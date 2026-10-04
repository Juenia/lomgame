import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCardService } from '../src/card/service.ts';
import { uploadCardImage } from '../src/card/uploader.ts';
import type { CharacterState } from '../src/domain/character/types.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 3, 3]);

function state(): CharacterState {
  return {
    id: 'c1', userId: 'u5', name: '测试者', pathway: 'seer', sequence: 9, pathwayStatus: 'initiated',
    gender: 'male', hp: 80, mp: 90, mad: 20, cor: 10, dig: 30, dp: 2,
    status: 'active', promotionFails: 0, createdAt: 0, updatedAt: 0,
  };
}

function fakeResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

test('图床：uguu 返回的 URL 被取出来（并归一化成可解析的 http 地址）', async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    seen.push(url);
    return fakeResponse({
      success: true,
      files: [{ hash: 'e347ca0b50123a5e', filename: 'piXZRNkx.png', url: 'https://n.uguu.se/piXZRNkx.png', size: 98058 }],
    });
  }) as unknown as typeof fetch;

  const result = await uploadCardImage(PNG, 'image/png', 'uguu', { fetchImpl });
  assert.ok(result, '应当拿到结果');
  assert.equal(result!.provider, 'uguu');
  assert.equal(result!.url, 'https://n.uguu.se/piXZRNkx.png');
  assert.ok(seen[0]!.includes('uguu.se'), `打到了 ${seen[0]}`);
});

test('图床：响应形如 https:\/\/… 时也能解析出正确 URL（别把反斜杠发进 markdown）', async () => {
  const fetchImpl = (async () =>
    fakeResponse({ success: true, files: [{ url: 'https:\/\/n.uguu.se\/abc.png' }] })) as unknown as typeof fetch;
  const result = await uploadCardImage(PNG, 'image/png', 'uguu', { fetchImpl });
  assert.equal(result?.url, 'https://n.uguu.se/abc.png');
});

test('图床：失败一律返回 undefined（不抛错，由调用方回落文字卡）', async () => {
  const cases: Array<[string, typeof fetch]> = [
    ['HTTP 非 2xx', (async () => fakeResponse({}, false)) as unknown as typeof fetch],
    ['success=false', (async () => fakeResponse({ success: false })) as unknown as typeof fetch],
    ['没有 files', (async () => fakeResponse({ success: true, files: [] })) as unknown as typeof fetch],
    ['url 不是 http', (async () => fakeResponse({ success: true, files: [{ url: 'ftp://x/y.png' }] })) as unknown as typeof fetch],
    ['网络异常', (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch],
  ];
  for (const [label, fetchImpl] of cases) {
    assert.equal(await uploadCardImage(PNG, 'image/png', 'uguu', { fetchImpl }), undefined, label);
  }
});

test('出图：**自建托管优先**，配了公网基址就不该去打图床', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'card-up-'));
  let uploads = 0;
  try {
    const service = createCardService({
      outDir: dir,
      publicBaseUrl: 'https://bot.example.com',
      uploadProvider: 'uguu',
      render: () => PNG,
      upload: async () => {
        uploads += 1;
        return { url: 'https://n.uguu.se/should-not-happen.png', provider: 'uguu' };
      },
    });
    const out = await service.generate({ character: state(), facts: {} });
    assert.equal(uploads, 0, '配了自建托管还去打图床 = 把卡面白白交给第三方');
    assert.match(out.publicUrl!, /^https:\/\/bot\.example\.com\/cards\//);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('出图：没配基址但有图床时，用上传得到的 URL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'card-up-'));
  try {
    const service = createCardService({
      outDir: dir,
      uploadProvider: 'uguu',
      render: () => PNG,
      upload: async () => ({ url: 'https://n.uguu.se/uploaded.png', provider: 'uguu' }),
    });
    const out = await service.generate({ character: state(), facts: {} });
    assert.equal(out.publicUrl, 'https://n.uguu.se/uploaded.png');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('出图：图床挂掉时 publicUrl 为空，但图照常落盘（不因为上传失败就不出卡）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'card-up-'));
  try {
    const service = createCardService({
      outDir: dir,
      uploadProvider: 'uguu',
      render: () => PNG,
      upload: async () => undefined,
    });
    const out = await service.generate({ character: state(), facts: {} });
    assert.equal(out.publicUrl, undefined);
    assert.ok(out.path.endsWith('.png'), '本地文件仍要写出来');
    assert.ok(out.png.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
