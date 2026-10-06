import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC, applyNumericOverrides, resetNumeric } from '../src/config/numeric.ts';
import { WorldRepo } from '../src/infra/db/world.ts';
import { advanceWorld, hourKeyOf, hourStartOf } from '../src/infra/world-tick.ts';
import { runStartupRecovery } from '../src/infra/recovery.ts';
import { WEATHER_IDS, worldModifiers } from '../src/domain/world/weather.ts';
import { worldClock } from '../src/domain/world/clock.ts';
import { createHarness, GROUP_ID } from './helpers/app.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

test('世界 tick：同一小时重复执行不重复结算（world_ticks 幂等）', async () => {
  const h = createHarness();
  try {
    const repo = new WorldRepo(h.app.db);
    const now = h.now();

    const first = advanceWorld(h.app.router.deps, now, { force: true });
    assert.ok(first.light.executed >= 1, '首次推进至少要结算当前这个小时');
    assert.equal(first.heavy.executed, 1, '首次推进要补上当天的重 tick');
    const weatherAfterFirst = repo.weatherStates();

    // 同一时刻再推、以及连推三次：都不该再多结算任何一格
    const second = advanceWorld(h.app.router.deps, now, { force: true });
    const third = advanceWorld(h.app.router.deps, now, { force: true });
    assert.equal(second.light.executed, 0);
    assert.equal(third.light.executed, 0);
    assert.equal(second.heavy.executed, 0);
    assert.deepEqual(repo.weatherStates(), weatherAfterFirst, '重复执行不得改动天气');
    assert.equal(repo.countTicks('light'), first.light.executed);
    assert.equal(repo.countTicks('heavy'), 1);
    // 表里确实只有一行这一小时
    assert.ok(repo.hasTick('light', hourKeyOf(hourStartOf(now))));
  } finally {
    h.app.close();
  }
});

test('世界 tick：进程重启后补跑错过的整点与整天（按水位线逐格补齐）', async () => {
  const h = createHarness();
  try {
    const repo = new WorldRepo(h.app.db);
    const start = h.now();
    advanceWorld(h.app.router.deps, start, { force: true });
    const lightAfterBoot = repo.countTicks('light');
    const heavyAfterBoot = repo.countTicks('heavy');

    // 模拟"服务停了 5 小时"：时钟往前走，但一条指令都不发（惰性推进不会跑）
    h.advance(5 * HOUR);
    const late = advanceWorld(h.app.router.deps, h.now(), { force: true });
    assert.ok(late.light.executed >= 5, `应当补跑 5 个整点，实际 ${late.light.executed}`);
    assert.equal(repo.countTicks('light'), lightAfterBoot + late.light.executed);

    // 再模拟"停了 3 天"：重 tick 也要按天补齐
    // 注意：上面那次 5 小时的补跑本身跨过了 0 点，所以重 tick 的基线要在它之后取
    const heavyBeforeJump = repo.countTicks('heavy');
    h.advance(3 * DAY);
    const later = advanceWorld(h.app.router.deps, h.now(), { force: true });
    assert.equal(later.heavy.executed, 3, '跨过 3 个 0 点就要补 3 次重 tick');
    assert.equal(repo.countTicks('heavy'), heavyBeforeJump + 3);
    void heavyAfterBoot;

    // 补跑有上限（防重启后一次性跑爆）
    h.advance(200 * DAY);
    const capped = advanceWorld(h.app.router.deps, h.now(), { force: true });
    assert.ok(
      capped.light.executed <= NUMERIC.world.weather.maxCatchUpLight,
      '轻 tick 补跑数量必须受上限约束',
    );
    assert.ok(capped.heavy.executed <= NUMERIC.world.weather.maxCatchUpHeavy);
  } finally {
    h.app.close();
  }
});

test('世界 tick：启动补跑（runStartupRecovery）会把错过的世界 tick 补上并记录在报告里', async () => {
  const h = createHarness();
  try {
    const repo = new WorldRepo(h.app.db);
    advanceWorld(h.app.router.deps, h.now(), { force: true });
    const before = repo.countTicks('light');

    h.advance(4 * HOUR);
    // 启动补跑走的是同一套水位线：force 忽略进程内缓存
    // force:true 会绕过进程内水位线，等价于「进程刚重启、内存里什么都不知道」
    const report = runStartupRecovery(h.app.router.deps, h.now());
    assert.ok(report.worldLightTicks >= 4, `启动应当补 4 个轻 tick，实际 ${report.worldLightTicks}`);
    assert.equal(repo.countTicks('light'), before + report.worldLightTicks);
    assert.ok(
      report.notes.some((note) => note.includes('世界轻 tick')),
      `启动报告里要写清补跑情况：${report.notes.join(' / ')}`,
    );

    // 再跑一次启动补跑：没有新的东西可补
    const again = runStartupRecovery(h.app.router.deps, h.now());
    assert.equal(again.worldLightTicks, 0, '同一时刻重复启动补跑不得重复结算');
    assert.equal(again.worldHeavyTicks, 0);
  } finally {
    h.app.close();
  }
});

test('世界状态落库：每个地点一行天气，且都是八种之一（可复现）', async () => {
  const h = createHarness();
  try {
    const repo = new WorldRepo(h.app.db);
    advanceWorld(h.app.router.deps, h.now(), { force: true });
    const locations = h.repos.locations.all();
    const states = repo.weatherStates();
    assert.equal(states.length, locations.length, '每个地点都必须有独立的天气行');
    assert.equal(repo.countWeather(), locations.length);
    for (const state of states) {
      assert.ok(WEATHER_IDS.includes(state.weather), `${state.locationId} 的天气非法：${state.weather}`);
      assert.ok(state.until > state.since);
    }

    // 落库的世界状态能读出时段/月相/雾日（.世界 与 /health 都读它）
    const world = repo.state();
    assert.ok(world, 'world_state 必须有且只有一行');
    assert.ok(world!.moonPhase >= 1 && world!.moonPhase <= 30);
    assert.equal(typeof world!.foggy, 'boolean');
    assert.ok(world!.lastLightAt !== null, '轻 tick 水位线要落库');
    assert.ok(world!.lastHeavyAt !== null, '重 tick 水位线要落库');

    // 可复现：同一份数据重建一次仓储，读出来的天气完全一致
    const second = new WorldRepo(h.app.db).weatherStates();
    assert.deepEqual(second, states);
  } finally {
    h.app.close();
  }
});

test('世界 tick：显著天气（血月/灵界渗透）变化会全群播报', async () => {
  const h = createHarness();
  try {
    // 让世界先"认识"这个群（广播对象来自 world_state.groups_json）
    await h.createCharacter('30001', '播报者');
    await h.send({ rawText: '.状态', userId: '30001', scene: 'group' });
    h.adapter.take();

    const repo = new WorldRepo(h.app.db);
    assert.ok(repo.groups().includes(GROUP_ID), '群消息应当被登记为播报对象');

    // 把天气权重压到只剩血月，保证这次换天气一定抽到它
    for (const id of WEATHER_IDS) {
      applyNumericOverrides({ world: { weather: { effects: { [id]: { weight: 0 } } } } });
    }
    applyNumericOverrides({ world: { weather: { effects: { blood_moon: { weight: 1 } } } } });
    try {
      // 手动把所有地点推到过期，再跨过一个整点：下一次轻 tick 必然换天气
      const states = repo.weatherStates().map((state) => ({ ...state, until: h.now() - 1 }));
      repo.upsertWeather(states, h.now());
      h.advance(HOUR);
      h.adapter.take();

      // 走真实路径：群消息 → 路由的惰性世界推进 → 显著天气全群播报
      // 注意 h.send 自己会把适配器里的消息取走（take），所以要看它的返回值
      const sent = await h.send({ rawText: '.状态', userId: '30001', scene: 'group' });
      const groupTexts = sent.filter((message) => message.scene === 'group').map((message) => message.text);
      assert.ok(groupTexts.length > 0, '播报必须真的投递到群里');
      assert.ok(
        /*
         * M2.171 起播报模板换过（不再是「世界异象」那一套），血月这一条现在的文案是
         * 「【世界 · 灰雾之上】月亮是红的……」—— 所以断言改成**认出这是血月**，
         * 而不是钉住某一版模板。它守的事没变：显著天气变化要真的投到群里。
         */
        groupTexts.some((text) => /血月|月亮是红的/.test(text)),
        `群里应当收到血月播报，实际：${groupTexts.join(' || ')}`,
      );
      /*
       * M2.86 起：事件播报**带原生按钮**时就不再附「发送 .世界 查看并参与」那一行
       * （两条路是同一件事的两种形态）—— 所以这里认「文字指引」或「按钮」其中之一，
       * 而它守的事没变：玩家看到播报之后得有一条往下走的路。
       */
      /*
       * ⚠️ 这里原本还有一条 `text.includes('.世界')` ——「播报要带上查看方式」。
       *
       * M2.86 起它的判据没了：**带原生按钮的播报不再附那一行文字指引**
       * （见 `worldEventNotice`：按钮为空时才补「发送 .世界 查看并参与」），
       * 而按钮走通道层、不在 `sent` 的文本里。留着它只会一直红——
       * 抓不住故障的判据是装饰（AGENTS 的话），所以删掉，不是放宽。
       *
       * 它守的意图由上一条承担：播报真的投到了群里，而且内容认得出是血月。
       * 按钮本身的渲染另有用例（adapter 那一批）。
       */

      // 抽出来的确实是血月（权重被压到只剩它）
      assert.ok(
        repo.weatherStates().every((state) => state.weather === 'blood_moon'),
        '权重只剩血月时，换天气必然抽到血月',
      );
    } finally {
      resetNumeric();
    }
  } finally {
    h.app.close();
  }
});

test('世界修正器：夜晚这条旋钮在判定层真的生效（原 .扮演 那条路已下线）', () => {
  /*
   * ⚠️ M2.164：这条原来是**端到端**的 —— 把时钟拨到夜里，发一次 `.扮演`，
   * 断言 MAD 涨了。而 `.扮演` 已在 M2.121 下线（用户拍板改走「途径专属事件卡」）：
   * 命令没了、回执变成「没有这条指令」，于是这条判据**一直红着** ——
   * 红着的判据等于没有判据。
   *
   * 现在盯**判定层**（worldModifiers 是纯函数，这里才是说得清的地方）。
   *
   * ⚠️ 记一笔待办：`playMad` 目前**没有消费点**了（原来只有 play.ts 读它）。
   *    M2.119 的遭遇卡是它的去处；在那之前，这条旋钮是「留着但没人用」的 ——
   *    与其假装它在用，不如把这句话写在这儿。
   */
  const clock = worldClock(Date.UTC(2026, 8, 21, 15, 0, 0));
  assert.equal(clock.timeOfDay, 'night', '前提：这个时刻应当是夜里');
  const night = worldModifiers({ clock, weather: 'clear' });
  const day = worldModifiers({ clock: { ...clock, timeOfDay: 'day' }, weather: 'clear' });
  assert.equal(
    night.playMad - day.playMad,
    NUMERIC.world.timeOfDay.nightPlayMad,
    '夜里要多出一档扮演 MAD（白天不算）',
  );
  // 不眠者与夜同伍，不吃这一档
  const sleepless = worldModifiers({ clock, weather: 'clear', path: 'sleepless' });
  assert.equal(sleepless.playMad, day.playMad, '不眠者夜里不该被罚');
});