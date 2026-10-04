/**
 * M2.45：**GitHub 图床**（不需要部署方自建任何服务的那条外链方案）。
 *
 * 用户口径：「我要放行给用户用的，我自己整个腾讯云 COS 算怎么回事。」
 * ⇒ 一个仓库 + 一个 token：图提交进仓库，链接走 jsDelivr（国内有节点）。
 *
 * 本机实测（2026-09-30，真实网络）：
 *   cdn.jsdelivr.net/gh/…            → 200 / image/png / 1.1s
 *   raw.githubusercontent.com/…      → 200 / image/png / 0.4s
 * `Content-Type` 正确这一点很关键 —— 有些图床回 `text/plain`，markdown 里就不显示。
 *
 * 这里不碰网络：注入的 fetch 只记录请求，验证的是**我们发出去的东西对不对**。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uploadCardImage } from '../src/card/uploader.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function recordingFetch(): { calls: Array<{ url: string; method: string; body: string }>; impl: typeof fetch } {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  const impl = (async (url: string, init: { method?: string; body?: string } = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: String(init.body ?? '') });
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch;
  return { calls, impl };
}

test('GitHub 图床：提交到 contents API，返回 jsDelivr 链接', async () => {
  const { calls, impl } = recordingFetch();
  const result = await uploadCardImage(PNG, 'image/png', 'github', {
    fetchImpl: impl,
    github: { repo: 'me/cards', token: 'tok', branch: 'main' },
  });

  assert.equal(result?.provider, 'github');
  assert.match(
    result?.url ?? '',
    /^https:\/\/cdn\.jsdelivr\.net\/gh\/me\/cards@main\/cards\/[0-9]{14}-[a-z0-9]{6}\.png$/,
    `链接要走 jsDelivr 且以扩展名结尾（QQ 的域名代理认这个）：${result?.url}`,
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /^https:\/\/api\.github\.com\/repos\/me\/cards\/contents\/cards\//);
  assert.equal(calls[0]!.method, 'PUT');
  // 内容是 base64（contents API 的硬要求），分支也带上了
  assert.match(calls[0]!.body, /"content":"[A-Za-z0-9+/=]+"/);
  assert.match(calls[0]!.body, /"branch":"main"/);
});

test('GitHub 图床：cdn=raw 时走 raw.githubusercontent.com', async () => {
  const { impl } = recordingFetch();
  const result = await uploadCardImage(PNG, 'image/png', 'github', {
    fetchImpl: impl,
    github: { repo: 'me/cards', token: 'tok', cdn: 'raw' },
  });
  assert.match(result?.url ?? '', /^https:\/\/raw\.githubusercontent\.com\/me\/cards\/main\/cards\//);
});

test('GitHub 图床：没配 repo / token 时返回 undefined（调用方回落直发，不抛错）', async () => {
  const { calls, impl } = recordingFetch();
  assert.equal(
    await uploadCardImage(PNG, 'image/png', 'github', { fetchImpl: impl, github: { repo: '', token: 'x' } }),
    undefined,
  );
  assert.equal(
    await uploadCardImage(PNG, 'image/png', 'github', { fetchImpl: impl, github: { repo: 'me/cards', token: '' } }),
    undefined,
  );
  assert.equal(calls.length, 0, '没配齐就不该发请求');
});
