/**
 * M2.164：**后台覆盖面**（AGENTS §3.7 那条判据的执行点）。
 *
 * 原文：「`src/**` 里每一份 yaml 都该在后台」—— 原因是它的反面没有判据：
 * 一份内容表**没登记**时不会报错，只会「运营看不见也改不了」。
 *
 * 本轮实测（M2.164）漏了四份：
 *   · divine-thrones.yaml      神座 22 条 —— 祂们的资源 / 目标 / 手段全是内容 ⇒ **已补登记**
 *   · divine-authorities.yaml  权柄与象征 95 条 ⇒ **已补登记**
 *   · original-materials.yaml  原作材料全表 1173 条 ⇒ 设定层参考数据，写明理由不上
 *   · pathway-abilities.yaml   原作能力清单 2405 条 ⇒ 同上
 *
 * 判据要求两件事：① 要么在后台，要么在这份清单里；② 清单里的每一项都要有理由
 * （空理由 = 借口）。少一条就会红 —— 这正是「抓不住故障的判据是装饰」的反面。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync } from 'node:fs';
import { ENTITIES } from '../src/admin/schema.ts';

/** 有意不上后台的**整份文件** —— 与 m2-77 的字段级清单是两件事（那一份管字段，这一份管文件） */
const FILES_WITH_REASON: Record<string, string> = {
  'original-materials.yaml':
    '原作材料全表 1173 条：设定层参考数据（只读图鉴 .图鉴 材料 用它），不是运营内容 —— 逐条编辑没有意义',
  'pathway-abilities.yaml':
    '原作能力清单 2405 条：同上（.图鉴 能力）。要加内容走 abilities.yaml 那张机制表，不走这张设定表',
};

test('M2.164 后台覆盖面：src/data 下每一份 yaml 要么在后台，要么写明理由', () => {
  const files = readdirSync('src/data').filter((f) => f.endsWith('.yaml'));
  assert.ok(files.length >= 40, '内容文件数不对：' + files.length);
  const registered = new Set(ENTITIES.map((e) => String(e.file).replace(/\\/g, '/')));
  const missing = files.filter((f) => !registered.has('src/data/' + f) && FILES_WITH_REASON[f] === undefined);
  assert.deepEqual(
    missing,
    [],
    '这些内容文件既不在后台、也没写明理由 —— 运营看不见也改不了，而且不报错',
  );
  // 清单里的每一项都要有理由（空理由的清单项就是借口），而且文件真的存在
  for (const [file, why] of Object.entries(FILES_WITH_REASON)) {
    assert.ok(why.length >= 20, file + ' 的理由太短，等于没写');
    assert.ok(files.includes(file), file + ' 已经不在内容目录里了 —— 过期的清单项要删掉');
  }
});

test('M2.164 后台覆盖面：本轮补登记的两张表字段都在', () => {
  for (const id of ['divine-thrones', 'npc-cast', 'divine-authorities']) {
    const entity = ENTITIES.find((e) => e.id === id);
    assert.ok(entity !== undefined, '这张表没登记：' + id);
    assert.ok(entity!.fields.length >= 6, id + ' 的字段太少：' + entity!.fields.length);
  }
  // 神座的资源 / 手段 / 注视必须是可编辑的（不是只读摆着看）
  const throne = ENTITIES.find((e) => e.id === 'divine-thrones')!;
  const types = new Map(throne.fields.map((f) => [f.key, f.type]));
  assert.equal(types.get('resources'), 'object', '资源不可编辑');
  assert.equal(types.get('methods'), 'rows', '手段不可编辑');
  assert.equal(types.get('gaze'), 'rows', '注视不可编辑');
  assert.equal(types.get('state'), 'enum', '状态不可编辑');
});
