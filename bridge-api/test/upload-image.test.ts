/**
 * 上游那半边：把图上传换成 `raw_url`（四步）。
 *
 * 这一段在本机没法真连 QQ，但**流程本身是纯逻辑** —— 四步怎么走、哪一步失败
 * 就该回落，都能用替身钉住。真机上要验的只剩「adapter-qq 的内部接口名字对不对」，
 * 而那一步失败会回落成「图单独发一条」，不会更糟。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uploadImageForMarkdown, type OfficialUploadApi } from '../integrations/koishi/src/upload-image.ts';

const PNG = Buffer.from([137, 80, 78, 71]).toString('base64');

/** 一个「一切正常」的替身，按调用顺序把动作记下来 */
function fakeApi(log: string[], over: Partial<OfficialUploadApi> = {}): OfficialUploadApi {
  return {
    prepare: async () => {
      log.push('prepare');
      return { upload_id: 'u1', parts: [{ index: 1, presigned_url: 'https://cos.example/p1' }] };
    },
    partFinish: async () => {
      log.push('partFinish');
      return {};
    },
    finish: async () => {
      log.push('finish');
      return { raw_url: 'https://x.myqcloud.com/a.png' };
    },
    put: async () => {
      log.push('put');
      return { ok: true, status: 200 };
    },
    ...over,
  };
}

test('四步走完拿回 raw_url，顺序是 prepare → PUT → partFinish → finish', async () => {
  const log: string[] = [];
  const url = await uploadImageForMarkdown(fakeApi(log), { targetId: 'g1', isDirect: false }, {
    base64: PNG,
    mediaType: 'image/png',
  });
  assert.equal(url, 'https://x.myqcloud.com/a.png');
  assert.deepEqual(log, ['prepare', 'put', 'partFinish', 'finish']);
});

test('分片 PUT 失败 → undefined，且不再往下走（不回传半张图）', async () => {
  const log: string[] = [];
  const api = fakeApi(log, { put: async () => ({ ok: false, status: 403 }) });
  const url = await uploadImageForMarkdown(api, { targetId: 'g1', isDirect: false }, { base64: PNG, mediaType: 'image/png' });
  assert.equal(url, undefined);
  assert.deepEqual(log, ['prepare'], 'PUT 失败就不该继续');
});

test('合并后没有 raw_url → undefined（宁可回落，也不回传一个空地址）', async () => {
  const api = fakeApi([], { finish: async () => ({ file_info: 'xxx' }) });
  const url = await uploadImageForMarkdown(api, { targetId: 'g1', isDirect: false }, { base64: PNG, mediaType: 'image/png' });
  assert.equal(url, undefined);
});

test('prepare 没给出 upload_id → undefined，一个分片都不传', async () => {
  let putCalls = 0;
  const api = fakeApi([], {
    prepare: async () => ({}),
    put: async () => { putCalls += 1; return { ok: true, status: 200 }; },
  });
  const url = await uploadImageForMarkdown(api, { targetId: 'g1', isDirect: false }, { base64: PNG, mediaType: 'image/png' });
  assert.equal(url, undefined);
  assert.equal(putCalls, 0);
});

test('上传抛错也吞掉（网络/平台抽风是常态，不能冒到投递循环里）', async () => {
  const api = fakeApi([], { prepare: async () => { throw new Error('boom'); } });
  const url = await uploadImageForMarkdown(api, { targetId: 'g1', isDirect: false }, { base64: PNG, mediaType: 'image/png' });
  assert.equal(url, undefined);
});