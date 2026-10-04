import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveAvatarPath } from '../src/card/avatar.ts';
import { characterCardData } from '../src/card/contract.ts';
import { renderCharacterCard } from '../src/card/render.ts';
import type { CharacterState } from '../src/domain/character/types.ts';

/**
 * 拿渲染器**自己画的一张卡**当头像素材 —— 保证喂进去的是合法 PNG，
 * 而不是手写的魔数（手写魔数会让"嗅探"这条断言变得没有意义）。
 *
 * 只画一次（约 4 秒，PowerShell 起进程的代价）：三个用例共用同一份字节，
 * 既省时间，也保证它们验的是**同一张图**。
 */
let cachedPng: Buffer | null = null;
function realPng(): Buffer {
  if (cachedPng !== null) return cachedPng;
  cachedPng = renderCharacterCard(
    characterCardData({
      id: 'a', userId: 'a', name: '头像样例', pathway: 'seer', sequence: 9,
      pathwayStatus: 'initiated', gender: 'male', hp: 80, mp: 90, mad: 20, cor: 10,
      dig: 30, dp: 2, status: 'active', promotionFails: 0, createdAt: 0, updatedAt: 0,
    } as CharacterState),
  );
  return cachedPng;
}

/** 一个只在测试期内活着的头像服务 */
async function withServer(
  handler: (url: string | undefined, res: import('node:http').ServerResponse) => void,
  body: (base: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => handler(req.url, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  try {
    await body(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test('头像：下载真 PNG 落盘，且二次调用命中缓存（不再打网络）', async () => {
  const png = realPng();
  const dir = mkdtempSync(join(tmpdir(), 'avatar-'));
  try {
    await withServer(
      (url, res) => {
        if (url === '/avatar.png') {
          res.writeHead(200, { 'content-type': 'image/png' });
          res.end(png);
        } else {
          res.writeHead(404);
          res.end('nope');
        }
      },
      async (base) => {
        const file = await resolveAvatarPath({ key: 'u1', url: `${base}/avatar.png`, dir });
        assert.ok(file, '应当落盘');
        // 落盘的是**真 PNG**（魔数 + 长度都对得上）
        const bytes = readFileSync(file!);
        assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
        assert.equal(bytes.length, png.length);

        // 缓存命中：URL 指向一个必死端口，仍应返回同一个文件
        const again = await resolveAvatarPath({ key: 'u1', url: 'http://127.0.0.1:1/dead.png', dir });
        assert.equal(again, file, '缓存没生效 —— 每次出卡都会重新下载');
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('头像：拿不到就返回 undefined，绝不落盘一张破图（渲染器会用首字纹章）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'avatar-'));
  try {
    await withServer(
      (url, res) => {
        res.writeHead(url === '/text' ? 200 : 404, { 'content-type': 'text/plain' });
        res.end('这不是图片');
      },
      async (base) => {
        // 404
        assert.equal(await resolveAvatarPath({ key: 'k404', url: `${base}/missing`, dir }), undefined);
        // 200 但内容不是图片（错误页伪装成图片是最常见的坑）
        assert.equal(await resolveAvatarPath({ key: 'ktext', url: `${base}/text`, dir }), undefined);
        // 根本没有 URL
        assert.equal(await resolveAvatarPath({ key: 'kempty', dir }), undefined);
        // 连不上
        assert.equal(await resolveAvatarPath({ key: 'kdead', url: 'http://127.0.0.1:1/x.png', dir }), undefined);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('头像：TTL 过期后重新下载（换了头像要能跟上）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'avatar-'));
  try {
    let hits = 0;
    await withServer(
      (url, res) => {
        if (url !== '/a.png') {
          res.writeHead(404);
          res.end();
          return;
        }
        hits += 1;
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(realPng());
      },
      async (base) => {
        await resolveAvatarPath({ key: 'ttl', url: `${base}/a.png`, dir, ttlMs: 1000 });
        assert.equal(hits, 1);
        /*
         * 负 TTL = 任何缓存都已过期（确定性的）。
         * 原来用 ttlMs: 0，判定是 `Date.now() - mtimeMs < 0` —— 全量跑时负载高、
         * 两次调用落在同一毫秒就会假失败（单独跑是过的，属于 flaky）。
         */
        await resolveAvatarPath({ key: 'ttl', url: `${base}/a.png`, dir, ttlMs: -1 });
        assert.equal(hits, 2, 'TTL 过期应当重新拉取');
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
