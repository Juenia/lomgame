import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { OfficialAdapter } from '../src/adapter/official.ts';
import type { HttpPost } from '../src/adapter/onebot.ts';
import { characterCardData } from '../src/card/contract.ts';
import { createCardService } from '../src/card/service.ts';
import type { CharacterState } from '../src/domain/character/types.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);

function state(): CharacterState {
  return {
    id: 'c1', userId: 'u9', name: '克莱恩·莫雷蒂', pathway: 'seer', sequence: 9,
    pathwayStatus: 'initiated', gender: 'male', hp: 84, mp: 91, mad: 38, cor: 27,
    dig: 73, dp: 4, status: 'active', promotionFails: 0, createdAt: 0, updatedAt: 0,
  };
}

/**
 * 串联验证：**卡服务产出的公网 URL** 一路走到官方通道的 markdown 正文里。
 *
 * 这条链路横跨三层（service → 路由选择的字段 → adapter 的 markdown 组装），
 * 每层单测都过、串起来却断掉，是这类改动最典型的失效方式 —— 所以这里串一次。
 */
test('串联：卡服务给 publicUrl → 官方通道发出一条带 ![](url) 的 markdown 消息', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'card-e2e-'));
  const calls: Array<Record<string, unknown>> = [];
  const post = (async (_url: string, body: unknown) => {
    calls.push(body as Record<string, unknown>);
    return { status: 'ok' };
  }) as unknown as HttpPost;

  try {
    const service = createCardService({
      outDir: dir,
      publicBaseUrl: 'https://bot.example.com',
      render: () => PNG,
    });
    const outcome = await service.generate({ character: state(), facts: {} });
    assert.ok(outcome.publicUrl, '服务应当给出公网 URL');

    const adapter = new OfficialAdapter({ appId: '1', accessToken: 't' }, post);
    const sent = await adapter.sendImage('group', 'g1', {
      bytes: outcome.png,
      mediaType: 'image/png',
      alt: `${state().name} 的角色卡`,
      url: outcome.publicUrl!,
    });

    assert.equal(sent, true);
    assert.equal(calls.length, 1);
    const md = (calls[0]!.markdown as { content: string }).content;
    assert.ok(md.includes(outcome.publicUrl!), `正文里没有卡图 URL：${md}`);
    assert.match(md, /!\[克莱恩·莫雷蒂 的角色卡 #600px #968px\]\(https:\/\/bot\.example\.com\/cards\//);
    // 卡面数据本身也参与了一次组装（普通人/入途径分支不会抛）
    assert.equal(characterCardData(state()).title, '占卜家');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
