import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply } from '../src/domain/effect/apply.ts';
import { runDailyTick } from '../src/infra/tick.ts';
import { createHarness, type Harness } from './helpers/app.ts';
import { birthCityOf } from '../src/domain/geo/index.ts';
import { PATHWAY_LABELS } from '../src/domain/character/rules.ts';

/**
 * M2.7：压测要的是**并发**，不是「途径地理化」。
 * 出生城市是派生的，拿固定途径去建号会有约三分之一的号被
 * 「这座城市没有这条途径的传承」挡回（100 人里就少 19—20 个角色）。
 * 所以压测按出生城市挑一条它真传承的途径 —— 与虚拟玩家在 decide.ts 里的做法同源。
 */
function nativePathway(h: Harness, userId: string): string {
  const city = birthCityOf(userId, h.app.geo.birthCities());
  return PATHWAY_LABELS[city.pathways[0] ?? 'seer'];
}

test('W1 压测：100 人并发乱点不崩，重复推送不重复建号', async () => {
  const h = createHarness();
  const users = Array.from({ length: 100 }, (_, i) => String(30000 + i));

  await Promise.all(
    users.map(async (userId, index) => {
      /*
       * M2.7.6：建号是**两步**（姓名 → 性别），而且这一步必须在私聊里做 ——
       * 群里不接数字回复（§3.6），回 1 在群里只是一句闲聊。
       * 第二次同 message_id 的推送仍然保留：它压的是幂等键。
       */
      await h.deliver({ rawText: `.创建 玩家${index}`, userId, messageId: `stress:create:${userId}` });
      await h.deliver({ rawText: `.创建 玩家${index}`, userId, messageId: `stress:create:${userId}` });
      await h.deliver({ rawText: '1', userId, messageId: `stress:create:${userId}:gender` });
      for (let k = 0; k < 3; k += 1) {
        await h.deliver({ rawText: '.状态', userId, messageId: `stress:status:${userId}:${k}` });
        await h.deliver({ rawText: `.升维${k}`, userId, messageId: `stress:junk:${userId}:${k}` });
        await h.deliver({ rawText: '.帮助', userId, messageId: `stress:help:${userId}:${k}` });
      }
    }),
  );

  const counts = h.app.db
    .prepare('SELECT (SELECT COUNT(*) FROM characters) AS characters, (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM audit_logs) AS audits')
    .get() as { characters: number; users: number; audits: number };
  assert.equal(counts.characters, 100);
  assert.equal(counts.users, 100);
  assert.ok(counts.audits > 0);
  h.app.close();
});

test('W1 压测：先扣后执行 —— 同一 message_id 并发只扣一次（M2.85：硬约束只剩 DP）', async () => {
  // 放宽频控，让本用例只验「先扣后执行 + 幂等 + 硬约束」这条链路；
  // 防刷频控本身由 router.test.ts 覆盖。
  const h = createHarness({ rateLimits: { 探索: { capacity: 100, refillPerSec: 0 } } });
  let ok = 0;
  let rejected = 0;

  // 用 .探索 这条真实指令名注册，只验证「先扣后执行」链路本身
  h.app.router.register('探索', (ctx) => {
    const character = ctx.deps.characters.findByUserId(ctx.msg.userId);
    assert.ok(character, '压测前必须先建号');
    // M2.85：AP 已删、MP 变成可透支（软约束）—— 现在唯一的硬约束是 DP，
    // 所以这条链路改用 DP 承接（reason 只是账本上的一句话）
    const result = apply(character, [{ type: 'dp', value: -1 }], '探索消耗', ctx.now);
    if (result.rejected) {
      rejected += 1;
      return { privateText: result.rejected };
    }
    ok += 1;
    ctx.deps.characters.update(result.newState);
    ctx.deps.characters.appendEvents(result.events);
    return { privateText: `DP=${result.newState.dp}` };
  });

  await h.send({ rawText: '.创建 克莱恩', userId: 'u-mp' });
  await h.send({ rawText: '1', userId: 'u-mp' });

  // 把 DP 压到 2：并发去重后第一次扣到 1，之后不同 message_id 各扣一次，第三次起被硬约束拒绝
  const me = h.repos.characters.findByUserId('u-mp')!;
  h.repos.characters.update({ ...me, dp: 2 });

  // 同一条 message_id 并发 10 次 → 只有 1 次进入执行
  await Promise.all(
    Array.from({ length: 10 }, () =>
      h.deliver({ rawText: '.探索 迷雾街区', userId: 'u-mp', messageId: 'mp:dup' }),
    ),
  );
  assert.equal(ok, 1, '重复推送只扣一次');
  assert.equal(rejected, 0);
  assert.equal(h.app.db.prepare('SELECT dp FROM characters WHERE user_id = ?').get('u-mp' as never) !== undefined, true);

  /*
   * 之后 3 次不同 message_id（每次间隔 1 秒，避开频控）→ 第 1 次扣到 0，后 2 次被硬约束拒绝。
   * ⚠️ 用不同地点：每地点每天 3 次的上限会**先于** DP 硬约束拒绝（迷雾街区在上面已经用过一次），
   * 那样测到的就不是本用例要守的那条链路了。
   */
  const places = ['迷雾街区', '廷根市', '廷根市'];
  for (let i = 0; i < 3; i += 1) {
    h.advance(1000);
    await h.send({ rawText: `.探索 ${places[i]}`, userId: 'u-mp', messageId: `mp:seq:${i}` });
  }

  assert.equal(ok, 2, 'DP 只够扣 2 次');
  assert.equal(rejected, 2, 'DP 归零后两次被硬约束拒绝（不可透支）');
  const row = h.app.db.prepare('SELECT dp FROM characters WHERE user_id = ?').get('u-mp') as { dp: number };
  assert.equal(row.dp, 0);
  h.app.close();
});
test('W3 压测：100 人并发探索不崩，AP 与每日上限都不被击穿', async () => {
  const h = createHarness();
  const users = Array.from({ length: 100 }, (_, i) => String(40000 + i));

  await Promise.all(
    users.map(async (userId, index) => {
      // M2.7.6：两步建号（普通人也能探索 —— 这正是普通人阶段的主要内容）
      await h.deliver({ rawText: `.创建 探索者${index}`, userId, messageId: `w3:create:${userId}` });
      await h.deliver({ rawText: '1', userId, messageId: `w3:create:${userId}:gender` });
      // M2.7：探索只能去自己脚下的城市，所以探自己城市的城区（出生城市是派生的）
      const home = birthCityOf(userId, h.app.geo.birthCities());
      const centerName = h.repos.locations.get(h.app.geo.city(home.id)!.center)!.name;
      for (let k = 0; k < 4; k += 1) {
        await h.deliver({ rawText: `.探索 ${centerName}`, userId, messageId: `w3:explore:${userId}:${k}` });
      }
    }),
  );

  const characters = h.app.db.prepare('SELECT COUNT(*) AS n FROM characters').get() as { n: number };
  assert.equal(characters.n, 100);

  /* M2.85：原来这里断言 `characters.ap === 2`（探索扣行动点）—— AP 下线后，
     每日 3 次的硬上限语义由下面的 explore_daily 断言守着，不再看行动点。 */

  const explores = h.app.db
    .prepare('SELECT location_id, COUNT(*) AS n, SUM(count) AS total FROM explore_daily GROUP BY location_id')
    .all() as Array<{ location_id: string; n: number; total: number }>;
  // M2.7：出生城市是派生的，100 个角色分散在五座城市、各探各的城区 ——
  // 所以不再是「一个地点」，但「每人每天 3 次」这条硬上限一个都不能破。
  assert.ok(explores.length >= 1 && explores.length <= 5, `探索地点数 ${explores.length} 不合常理`);
  /*
   * ⚠️ M2.90：这里原来写 300（100 人 × 3，硬上限时代）。
   * M2.86 把探索上限改成了**软**上限（用户：「探索每日三次是不合理的机制」）：
   * 第 4 次照样能探，只是收益衰减 —— 所以四轮探索全部落地，300 → 400。
   * 判据守的是「并发下计数不被击穿」，而不是某一个具体的上限值。
   */
  assert.equal(
    explores.reduce((sum, row) => sum + row.total, 0),
    400,
    '软上限下每人四轮探索都算数（100 人 × 4）',
  );
  assert.ok(
    explores.every((row) => row.total === row.n * 4),
    '每个地点的探索次数都应当恰好是「人数 × 4」',
  );

  const items = h.app.db.prepare('SELECT COUNT(*) AS n FROM inventory WHERE quantity > 0').get() as { n: number };
  assert.ok(items.n > 0, '掉落要真的进背包');
  h.app.close();
});
test('W4 压测：100 人并发日常指令后跑每日结算，幂等且不崩', async () => {
  const h = createHarness();
  const users = Array.from({ length: 100 }, (_, i) => String(50000 + i));

  await Promise.all(
    users.map(async (userId, index) => {
      await h.deliver({ rawText: `.创建 结算者${index}`, userId, messageId: `w4:create:${userId}` });
      await h.deliver({ rawText: '1', userId, messageId: `w4:create:${userId}:gender` });
      await h.deliver({ rawText: '.占卜 今天会出事吗', userId, messageId: `w4:div:${userId}` });
      await h.deliver({ rawText: '.休息', userId, messageId: `w4:rest:${userId}` });
      await h.deliver({ rawText: '.队伍 创建', userId, messageId: `w4:party:${userId}` });
    }),
  );

  const first = runDailyTick(h.app.router.deps, h.now());
  assert.equal(first.skipped, false);
  assert.equal(first.characters, 100, '每日结算要覆盖全部角色');

  const second = runDailyTick(h.app.router.deps, h.now());
  assert.equal(second.skipped, true, '同一天重复结算是幂等的');

  // M2.85：SELECT 里的 ap 与「AP 全部补到 5」断言随行动值一并删除
  const rows = h.app.db.prepare('SELECT mp, hp FROM characters').all() as Array<{
    mp: number;
    hp: number;
  }>;
  assert.equal(rows.length, 100);
  assert.ok(rows.every((row) => row.mp <= 100 && row.hp <= 100), '恢复不能越过上限');

  const ticks = h.app.db.prepare('SELECT COUNT(*) AS n FROM daily_ticks').get() as { n: number };
  assert.equal(ticks.n, 1);
  const parties = h.app.db.prepare('SELECT COUNT(*) AS n FROM parties').get() as { n: number };
  assert.equal(parties.n, 100, '100 人各建了一个队');
  h.app.close();
});

test('W4 压测：失控结算与恢复路径不产生死循环', async () => {
  const h = createHarness();
  const characters = [];
  for (let i = 0; i < 30; i += 1) {
    const userId = String(60000 + i);
    const character = await h.createCharacter(userId, `失控者${i}`);
    h.repos.characters.update({
      ...h.repos.characters.findById(character.id)!,
      mad: 100,
      cor: 100,
      updatedAt: h.now(),
    });
    characters.push(character);
  }

  await Promise.all(
    characters.map((character) =>
      h.deliver({ rawText: '.净化', userId: character.userId, messageId: `w4:purify:${character.userId}` }),
    ),
  );

  // 连续跑 3 天结算：不能有人被反复扣血到异常，也不能永远卡在失控
  //
  // M2.1 之后 MAD=100/COR=100 的失控概率是 100%/天（旧闸门 80/70 时只有 6%），
  // 「结算完那一刻至少有一个 active」会变成掷骰子（0.967^30 ≈ 36% 全中）。
  // 这里改成真正的口径：**三天里每个角色都至少回过一次 active** —— 失控必然在次日解除，
  // 谁都不许被永久卡住。
  const activeDays = new Map<string, number>();
  for (let day = 0; day < 3; day += 1) {
    runDailyTick(h.app.router.deps, h.now());
    h.advance(24 * 60 * 60 * 1000);
    const after = h.app.db.prepare('SELECT id, status FROM characters').all() as Array<{
      id: string;
      status: string;
    }>;
    for (const row of after) {
      if (row.status === 'active') activeDays.set(row.id, (activeDays.get(row.id) ?? 0) + 1);
    }
  }

  const rows = h.app.db.prepare('SELECT hp, status FROM characters').all() as Array<{
    hp: number;
    status: string;
  }>;
  assert.ok(rows.every((row) => row.hp >= 0), 'HP 不能被扣穿');
  assert.equal(activeDays.size, 30, '三天里每个角色都至少恢复过一次（恢复路径存在）');
  assert.ok(
    [...activeDays.values()].every((count) => count >= 1),
    '没有任何角色被永久卡在失控里',
  );

  const tickRows = h.app.db.prepare('SELECT COUNT(*) AS n FROM daily_ticks').get() as { n: number };
  assert.equal(tickRows.n, 3, '三天各结算一次');
  h.app.close();
});
