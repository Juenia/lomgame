/**
 * M2.3 虚拟玩家适配（任务书 §7）：
 *   1. 菜单决策分支：收到菜单 → 按目标选选项 → 回数字
 *   2. 菜单路径真的能跑通一天（回数字 → 服务端执行 → 又拿到新菜单）
 *   3. 数字回复幂等（同一 message_id 回两次只处理一次）—— 端到端那一层已覆盖，这里做决策层口径
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CharacterRepo } from '../src/infra/db/characters.ts';
import type { App } from '../src/main.ts';
import type { MemoryAdapter } from '../src/adapter/memory.ts';
import type { InternalMessage } from '../src/adapter/types.ts';
import { menuDecision, menuScore, makeContext } from '../src/vplayer/decide.ts';
import { buildWorld } from '../src/vplayer/cli.ts';
import { MS_PER_DAY, runPlayerDay } from '../src/vplayer/session.ts';
import { createGroupChatLog } from '../src/vplayer/http.ts';
import type { FakeInbox, SendCommandResult } from '../src/vplayer/http.ts';
import type { ActionRecord, MenuChoice, PlayerProfile, PlayerSnapshot } from '../src/vplayer/types.ts';
import { createHarness, type Harness } from './helpers/app.ts';

const WORLD = buildWorld();

function snapshotOf(overrides: Partial<PlayerSnapshot> = {}): PlayerSnapshot {
  return {
    exists: true,
    characterId: 'c1',
    name: '菜单玩家',
    sequence: 9,
    hp: 100,
    mp: 100,
    mad: 0,
    cor: 0,
    dig: 0,
    dp: 0,
    status: 'active',
    promotionFails: 0,
    inventory: [],
    flags: new Set<string>(),
    pendingTradeCount: 0,
    dailyCounters: {},
    exploreCounts: {},
    // M2.69：次数（daily_limit 是上限，默认 1）；空表 = 今天什么都没出过
    triggeredToday: new Map<string, number>(),
    partyId: null,
    partySize: 1,
    isPartyLeader: false,
    ritualPreparing: false,
    ritualRunning: false,
    ritualLocationId: null,
    // M2.6：通缉 / 位置 / 信誉
    wantedLevel: 0,
    wantedFactionId: null,
    currentLocationId: null,
    reputation: 0,
    ...overrides,
  };
}

function profileOf(overrides: Partial<PlayerProfile> = {}): PlayerProfile {
  return {
    id: 0,
    userId: '700000',
    name: '菜单玩家0',
    persona: 'aggressive',
    goal: 'promote',
    pathway: 'seer',
    gender: 'male',
    loginTimesPerDay: 2,
    actionsPerLogin: 6,
    riskAppetite: 0.8,
    patience: 1,
    seed: 'm23-vplayer',
    fleetSize: 10,
    ...overrides,
  };
}

/** 满分扮演次数（与 decide.ts 的 PLAYER_MODEL.maxPlaysPerDay 同口径） */
const PLAYER_MODEL = { maxPlaysPerDay: 30 };

const MENU: MenuChoice[] = [
  { key: '1', label: '摊开牌占卜一件还没发生的事（占卜，匹配高）', command: '扮演 摊开牌占卜一件还没发生的事' },
  { key: '2', label: '看今天还有什么可做', command: '今日' },
  { key: '3', label: '查看状态', command: '状态' },
  { key: '4', label: '休息', command: '休息', disabled: '行动点不足' },
];

test('菜单决策：走菜单路径的玩家收到菜单就回数字，且只选可用项', () => {
  const ctx = makeContext(profileOf(), snapshotOf(), {
    menuPath: true,
    pendingMenu: { menuType: 'play', options: MENU },
  });
  const decision = menuDecision(ctx);
  assert.ok(decision, '有菜单就必须走菜单分支');
  assert.ok(decision!.menuPath === true);
  assert.match(decision!.command, /^[1-9]$/, `回数字，而不是发指令：${decision!.command}`);
  // 4 号是灰色的，不能选
  assert.notEqual(decision!.command, '4');
});

/**
 * M2.9：遭遇菜单里的「动手」必须真的能被选中。
 *
 * 这一条是**实测踩坑之后补的**：那个选项的 label 是「动手」，
 * 而 command 是完整指令原文「战斗 开始」——
 * 决策函数当时写的是 `options.find(o => o.command.includes('动手'))`，
 * 于是**永远找不到它**，4 个分片跑满 14 天一场战斗都没有。
 *
 * 而菜单是对的、门槛是对的、服务端兜底也是对的 —— 坏掉的只有这一行匹配。
 * 教训：`find('撤退')` 那种写法成立，是因为那些选项的 label 与 command 里的动作词是同一个词。
 */
test('遭遇决策：菜单里有「动手」时，它会真的被选中（按 command 匹配，不是 label）', () => {
  const silhouetteMenu: MenuChoice[] = [
    { key: '1', label: '观察', command: '遭遇 观察' },
    { key: '2', label: '撤退', command: '遭遇 撤退' },
    { key: '3', label: '动手', command: '战斗 开始' },
  ];
  let fought = 0;
  for (let seed = 0; seed < 40; seed += 1) {
    const decision = menuDecision(
      makeContext(profileOf({ persona: 'aggressive', seed: 'fight-' + seed }), snapshotOf({ sequence: 9 }), {
        menuPath: false,
        pendingMenu: { menuType: 'encounter', options: silhouetteMenu },
      }),
    );
    assert.ok(decision, '这一档必须有决策');
    if (decision.command.startsWith('战斗 开始')) fought += 1;
  }
  assert.ok(fought > 0, '激进型玩家在看得见轮廓时应当会动手（实测 ' + fought + '/40）');

  // 菜单路径的玩家要把同一个选项**回数字**，而不是发原文
  const viaMenu = (() => {
    for (let seed = 0; seed < 40; seed += 1) {
      const decision = menuDecision(
        makeContext(profileOf({ persona: 'aggressive', seed: 'fight-' + seed }), snapshotOf(), {
          menuPath: true,
          pendingMenu: { menuType: 'encounter', options: silhouetteMenu },
        }),
      );
      if (decision?.command === '3') return decision;
    }
    return null;
  })();
  assert.ok(viaMenu, '菜单路径的玩家应当回数字 3，而不是发「战斗 开始」');
  assert.equal(viaMenu?.menuPath, true);
});

test('菜单决策：不走菜单路径的玩家（对照组）永远不回数字', () => {
  const ctx = makeContext(profileOf(), snapshotOf(), {
    menuPath: false,
    pendingMenu: { menuType: 'play', options: MENU },
  });
  assert.equal(menuDecision(ctx), null, '对照组的决策必须还是完整指令');
});

test('菜单决策：「今日」永远不会被选（选它就是原地打转）', () => {
  const onlyToday: MenuChoice[] = [
    { key: '1', label: '看今天还有什么可做', command: '今日' },
  ];
  const ctx = makeContext(profileOf(), snapshotOf(), {
    menuPath: true,
    pendingMenu: { menuType: 'result', options: onlyToday },
  });
  assert.equal(menuDecision(ctx), null, '全是 0 分项时应当回落到常规决策，而不是自己进自己的菜单');
  assert.equal(menuScore(ctx, onlyToday[0]!), 0);
});

test('菜单决策：全部不可选时回落到常规决策（不会卡死）', () => {
  const ctx = makeContext(profileOf(), snapshotOf(), {
    menuPath: true,
    pendingMenu: {
      menuType: 'play',
      options: [{ key: '1', label: '休息', command: '休息', disabled: '行动点不足' }],
    },
  });
  assert.equal(menuDecision(ctx), null);
});

test('菜单打分：状态到线时恢复项优先，目标影响倾向', () => {
  const risky = snapshotOf({ mad: 80, cor: 10 });
  const calm = snapshotOf({ mad: 10, cor: 10 });
  const rest: MenuChoice = { key: '1', label: '休息', command: '休息' };
  const play: MenuChoice = { key: '2', label: '扮演', command: '扮演 我占卜' };

  assert.ok(
    menuScore(makeContext(profileOf(), risky), rest) > menuScore(makeContext(profileOf(), risky), play),
    'MAD 到线时休息必须压过扮演',
  );
  assert.ok(
    menuScore(makeContext(profileOf(), calm), play) > menuScore(makeContext(profileOf(), calm), rest),
    '状态平稳时该去推消化度而不是休息',
  );

  const exploreOption: MenuChoice = { key: '3', label: '去探索', command: '探索 廷根市' };
  assert.ok(
    menuScore(makeContext(profileOf({ goal: 'explore' }), calm), exploreOption) >
      menuScore(makeContext(profileOf({ goal: 'promote' }), calm), exploreOption),
    '探索目标的玩家更愿意点探索',
  );
});

test('菜单打分：DIG 顶格后不再抢着「继续扮演」（第一轮分片回归 6 条 P1 的根因）', () => {
  // 完整指令路径的 promoteChain 有 `if (dig >= 100) return busywork(...)` 这条保护，
  // 菜单路径最初没有 —— 结果 DIG 满的玩家一直点「继续扮演」，连续 10 次无状态变化 → P1。
  // M2.2 单进程同规模是 0 条 P1，所以这是 M2.3 引入的回归，必须钉住。
  const play: MenuChoice = { key: '1', label: '继续扮演', command: '扮演 我摊开牌占卜' };
  const explore: MenuChoice = { key: '2', label: '去探索', command: '探索 廷根市' };

  const full = snapshotOf({ dig: 100 });
  assert.ok(
    menuScore(makeContext(profileOf(), full), play) < menuScore(makeContext(profileOf(), full), explore),
    'DIG 满了之后，探索必须压过扮演',
  );

  const playedOut = snapshotOf({ dig: 50, dailyCounters: { play: PLAYER_MODEL.maxPlaysPerDay } });
  assert.ok(
    menuScore(makeContext(profileOf(), playedOut), play) < menuScore(makeContext(profileOf(), playedOut), explore),
    '当天扮演次数到顶后同理',
  );

  assert.equal(
    menuScore(makeContext(profileOf(), full), play),
    0,
    '空转的扮演必须是 0 分（永不选中），否则它会压过纯读项继续被选中',
  );
  assert.deepEqual(
    menuDecision(makeContext(profileOf(), full, { menuPath: true, pendingMenu: { menuType: 'result', options: [play] } })),
    null,
    '菜单里只剩空转项时必须返回 null，回落到完整指令路径的 busywork（去交易 / 组队 / 占卜）',
  );

  const normal = snapshotOf({ dig: 50 });
  assert.ok(
    menuScore(makeContext(profileOf(), normal), play) > menuScore(makeContext(profileOf(), normal), explore),
    '正常状态下该推消化度就推消化度（别把保护写成了永远不扮演）',
  );

  // 纯读项一律 0 分：它们的覆盖率由完整指令路径的注入保证，菜单这条路上不需要它们
  for (const readOnly of ['状态', '背包', '帮助', '世界', '反馈', '今日']) {
    assert.equal(
      menuScore(makeContext(profileOf(), normal), { key: '9', label: readOnly, command: readOnly }),
      0,
      `${readOnly} 不该在菜单里抢分`,
    );
  }
});

/* ---------------- 真跑一天（本地路由，不走 HTTP 端口） ---------------- */

class LocalHttp {
  #adapter: MemoryAdapter;
  #app: App;
  #harness: Harness;

  constructor(adapter: MemoryAdapter, app: App, harness: Harness) {
    this.#adapter = adapter;
    this.#app = app;
    this.#harness = harness;
  }

  async pinClock(nowMs: number): Promise<boolean> {
    this.#harness.advance(nowMs - this.#harness.now());
    return true;
  }

  async tick(): Promise<Record<string, unknown>> {
    return {};
  }

  async menu(userId: string): Promise<{ menuType: string; options: MenuChoice[] } | null> {
    const character = new CharacterRepo(this.#app.db).findByUserId(userId);
    if (!character) return null;
    const current = this.#app.router.deps.pendingMenus.current(character.id, this.#app.now());
    return current ? { menuType: current.menuType, options: current.menu.options } : null;
  }

  async send(input: {
    messageId: string;
    userId: string;
    rawText: string;
    scene: 'private' | 'group';
    nickname?: string;
  }): Promise<SendCommandResult> {
    const message: InternalMessage = {
      messageId: input.messageId,
      platform: 'onebot',
      scene: input.scene,
      sceneId: input.scene === 'private' ? input.userId : '10001',
      userId: input.userId,
      nickname: input.nickname ?? input.userId,
      rawText: input.rawText,
      timestamp: this.#app.now(),
    };
    await this.#adapter.deliver(message);
    return { status: 200, costMs: 0 };
  }
}

function localInbox(adapter: MemoryAdapter): FakeInbox {
  return {
    port: 0,
    server: undefined as never,
    groupMessages: 0,
    drainPrivate: (userId: string) =>
      adapter.take().filter((message) => message.scene === 'private' && message.targetId === userId),
    drainGroup: () => adapter.take().filter((message) => message.scene === 'group'),
    drainAll: () => adapter.take(),
    flush: async () => {},
    close: async () => {},
  } as unknown as FakeInbox;
}

test('虚拟玩家菜单路径：真的能收到菜单、回数字、走完一天（偶数号玩家）', async () => {
  const h = createHarness();
  try {
    const profile = profileOf();
    const baseEpoch = h.now();
    await h.createCharacter(profile.userId, profile.name, profile.pathway);

    const records: ActionRecord[] = [];
    const recorder = { record: (entry: ActionRecord) => records.push(entry), close: async () => {} };
    const http = new LocalHttp(h.adapter, h.app, h);
    const inbox = localInbox(h.adapter);

    await runPlayerDay(
      {
        db: h.app.db,
        http: http as never,
        inbox,
        recorder: recorder as never,
        world: WORLD,
        baseEpoch,
        chat: createGroupChatLog(),
        onAnomaly: () => {},
      },
      profile,
      1,
      baseEpoch + MS_PER_DAY,
    );

    assert.ok(records.length >= 6, `一天至少要有若干动作，实际 ${records.length}`);
    const menuActions = records.filter((record) => record.menuPath === true);
    assert.ok(
      menuActions.length >= 2,
      `菜单路径必须真的被走到（回数字的动作数 ${menuActions.length}）`,
    );
    for (const record of menuActions) {
      assert.match(record.rawSent ?? '', /^\d{1,2}$/, `菜单路径发出去的必须是数字：${record.rawSent}`);
      assert.ok(record.command.length > 0, '日志里的 command 必须是真实执行的指令');
      assert.ok(!/^\d+$/.test(record.command), `日志里不能记成数字，否则覆盖率全废：${record.command}`);
    }
    // 走完链路的意思：这一天的动作里必须真的推动过角色状态
    const character = h.repos.characters.findByUserId(profile.userId)!;
    assert.ok(
      character.dig > 0 || records.some((record) => record.command.startsWith('探索')),
      '菜单路径必须能真的推动游戏进程（消化度或探索痕迹）',
    );
  } finally {
    h.app.close();
  }
});

test('虚拟玩家对照：奇数号玩家走完整指令路径，动作里没有回数字', async () => {
  const h = createHarness();
  try {
    const profile = profileOf({ id: 1, userId: '700001', name: '指令玩家1' });
    const baseEpoch = h.now();
    await h.createCharacter(profile.userId, profile.name, profile.pathway);

    const records: ActionRecord[] = [];
    const recorder = { record: (entry: ActionRecord) => records.push(entry), close: async () => {} };
    const http = new LocalHttp(h.adapter, h.app, h);
    const inbox = localInbox(h.adapter);

    await runPlayerDay(
      {
        db: h.app.db,
        http: http as never,
        inbox,
        recorder: recorder as never,
        world: WORLD,
        baseEpoch,
        chat: createGroupChatLog(),
        onAnomaly: () => {},
      },
      profile,
      1,
      baseEpoch + MS_PER_DAY,
    );

    assert.ok(records.length >= 6);
    assert.equal(
      records.filter((record) => record.menuPath === true).length,
      0,
      '对照组不该回数字（任务书 §7.3：一半走菜单、一半走完整指令）',
    );
    assert.ok(
      records.every((record) => record.command.startsWith('.') || !/^\d+$/.test(record.command)),
      '对照组的每一条都必须是完整指令',
    );
  } finally {
    h.app.close();
  }
});
