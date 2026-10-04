import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { silentLogger } from '../src/infra/logger.ts';
import { createApp, startHttpServer } from '../src/main.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);

/**
 * `startHttpServer` **自己就会 listen**（见 main.ts 里 `server.listen(app.config.port)`），
 * 所以这里只等它进入 listening —— 再调一次 listen 会抛 ERR_SERVER_ALREADY_LISTEN。
 * 测试用 `port: 0`，端口由系统分配，从 address() 取。
 */
async function portOf(server: Server): Promise<number> {
  if (!server.listening) await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

/**
 * 卡图托管（`GET /cards/<文件名>.png`）。
 *
 * 为什么值得单独测：这条路是**公网可访问**的 —— 它是唯一一个
 * 「外面的人能按名字取我们磁盘上某个文件」的入口，所以白名单必须真的挡住穿越。
 */
test('托管：/cards/<文件名>.png 返回图片本体，并带长缓存头', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'card-http-'));
  const app = createApp(
    { dbPath: ':memory:', port: 0, onebotApiBase: 'http://127.0.0.1:1', detailToPrivate: true, runTickOnStart: false, startOps: false, cardOutDir: dir },
    {
      adapter: { onMessage() {}, sendPrivate: async () => {}, sendGroup: async () => {}, sendChannel: async () => {} } as never,
      logger: silentLogger,
    },
  );
  const server = startHttpServer(app);
  try {
    const port = await portOf(server);
    writeFileSync(join(dir, 'x_1_20260101.png'), PNG);

    const res = await fetch(`http://127.0.0.1:${port}/cards/x_1_20260101.png`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    const body = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...body], [...PNG], '返回的字节要与磁盘上的一致');
    assert.match(res.headers.get('cache-control') ?? '', /immutable/, '文件名带时间戳、内容不可变，应当可长缓存');
  } finally {
    server.close();
    app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('托管：目录穿越与非法名字一律 400，不会读到出图目录以外的文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'card-http-'));
  const app = createApp(
    { dbPath: ':memory:', port: 0, onebotApiBase: 'http://127.0.0.1:1', detailToPrivate: true, runTickOnStart: false, startOps: false, cardOutDir: dir },
    {
      adapter: { onMessage() {}, sendPrivate: async () => {}, sendGroup: async () => {}, sendChannel: async () => {} } as never,
      logger: silentLogger,
    },
  );
  const server = startHttpServer(app);
  try {
    const port = await portOf(server);
    const evil = [
      '..%2F..%2Fdata%2Fgame.db',
      '..%2fpackage.json',
      'sub%2Fdir%2Fx.png',
      'x.jpg',
      'x.png%00.txt',
      '',
    ];
    for (const name of evil) {
      const res = await fetch(`http://127.0.0.1:${port}/cards/${name}`);
      assert.equal(res.status, 400, `这个名字本该被拒：${name}`);
    }
    // 合法名字但文件不存在 ⇒ 404（不是 400，也不泄露目录结构）
    const missing = await fetch(`http://127.0.0.1:${port}/cards/nope_1_20260101.png`);
    assert.equal(missing.status, 404);
  } finally {
    server.close();
    app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('托管：没配 CARD_PUBLIC_BASE_URL 也能起服务（路由存在但没人取）', async () => {
  const app = createApp(
    { dbPath: ':memory:', port: 0, onebotApiBase: 'http://127.0.0.1:1', detailToPrivate: true, runTickOnStart: false, startOps: false },
    {
      adapter: { onMessage() {}, sendPrivate: async () => {}, sendGroup: async () => {}, sendChannel: async () => {} } as never,
      logger: silentLogger,
    },
  );
  const server = startHttpServer(app);
  try {
    const port = await portOf(server);
    const res = await fetch(`http://127.0.0.1:${port}/cards/anything.png`);
    assert.equal(res.status, 404, '默认目录下没有这张图');
  } finally {
    server.close();
    app.close();
  }
});
