/**
 * 端到端演示：不需要 OneBot、不需要网络，直接用内存适配器跑一遍真实路由。
 * 运行：node scripts/demo.ts
 */
import { MemoryAdapter, type SentMessage } from '../src/adapter/memory.ts';
import { CharacterRepo } from '../src/infra/db/characters.ts';
import { runDailyTick } from '../src/infra/tick.ts';
import { InventoryRepo } from '../src/infra/db/inventory.ts';
import type { InternalMessage } from '../src/adapter/types.ts';
import { silentLogger } from '../src/infra/logger.ts';
import { createApp } from '../src/main.ts';

const GROUP = '10001';
const ALICE = '20001';
const BOB = '20002';

let clock = Date.UTC(2026, 8, 21, 12, 0, 0);
const now = (): number => clock;
const advance = (ms: number): void => {
  clock += ms;
};

const adapter = new MemoryAdapter();
const app = createApp(
  {
    dbPath: ':memory:',
    port: 0,
    onebotApiBase: 'http://127.0.0.1:3000',
    detailToPrivate: true,
    // 演示里手动触发每日结算，看清它到底做了什么；运维服务（备份等）关掉
    runTickOnStart: false,
    startOps: false,
  },
  { adapter, logger: silentLogger, now },
);

async function say(
  label: string,
  msg: Partial<InternalMessage> & { rawText: string; scene: InternalMessage['scene'] },
): Promise<SentMessage[]> {
  const full: InternalMessage = {
    messageId: `demo:${Math.random().toString(36).slice(2, 10)}`,
    platform: 'onebot',
    sceneId: msg.scene === 'private' ? ALICE : GROUP,
    userId: ALICE,
    nickname: '克莱恩',
    timestamp: now(),
    ...msg,
  };
  console.log(`\n>>> [${label}] ${full.rawText}`);
  await adapter.deliver(full);
  const sent = adapter.take();
  for (const message of sent) {
    const where =
      message.scene === 'private' ? `私聊 ${message.targetId}` : `${message.scene} ${message.targetId}`;
    console.log(`<<< [${where}]`);
    console.log(
      message.text
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n'),
    );
  }
  return sent;
}

async function run(): Promise<void> {
  await say('私聊 · 帮助', { scene: 'private', rawText: '.帮助' });
  await say('私聊 · 未创建角色就查状态', { scene: 'private', rawText: '.状态' });
  await say('群聊 · 创建角色', { scene: 'group', rawText: '.创建 克莱恩 愚者' });
  advance(6000);
  await say('私聊 · 查看角色卡', { scene: 'private', rawText: '.状态' });
  await say('群聊 · 5 秒内连点状态（应被频控）', { scene: 'group', rawText: '.状态' });
  advance(6000);
  await say('私聊 · 未开放途径', { scene: 'private', rawText: '.创建 阿尔杰 太阳' });
  await say('私聊 · 未识别指令', { scene: 'private', rawText: '.升维' });
  await say('私聊 · 敏感词拦截', { scene: 'private', rawText: '.创建 加微信买魔药 愚者' });

  // ---- W2：扮演 / 事件 ----
  console.log('\n────────── W2：扮演法与事件卡 ──────────');
  advance(11_000);
  await say('群聊 · 契合途径的扮演', { scene: 'group', rawText: '.扮演 我在书店里替人占卜今天的运势' });
  advance(11_000);
  await say('私聊 · 复读同一标签（收益递减）', { scene: 'private', rawText: '.扮演 占卜' });
  advance(11_000);
  await say('私聊 · 换着花样来（多样性加成）', { scene: 'private', rawText: '.扮演 观察街上的行人，推算他们的来历' });
  advance(11_000);
  await say('私聊 · 完全跑题的扮演', { scene: 'private', rawText: '.扮演 我随便在街上走了走' });
  advance(11_000);
  await say('群聊 · 主动探索（M2.85：不再消耗行动点）', { scene: 'group', rawText: '.事件 老码头' });
  advance(11_000);
  await say('私聊 · 状态里能看到标记', { scene: 'private', rawText: '.状态' });

  // ---- W3：探索 / 背包 / 魔药 / 服用 / 交易 ----
  console.log('\n────────── W3：探索、魔药、交易 ──────────');
  const characterRepo = new CharacterRepo(app.db);
  const inventory = new InventoryRepo(app.db);
  const alice = characterRepo.findByUserId(ALICE)!;

  advance(11_000);
  await say('群聊 · 探索廷根市（消耗 1 AP）', { scene: 'group', rawText: '.探索 廷根市' });
  advance(11_000);
  await say('私聊 · 查看背包', { scene: 'private', rawText: '.背包' });

  // 演示用补给：正常玩法里这些材料要从探索里攒
  inventory.add(alice.id, '主材料·灰雾结晶', 1, 'unbound', now());
  inventory.add(alice.id, '夜香草', 2, 'bound', now());
  inventory.add(alice.id, '辅助材料·银粉', 2, 'bound', now());
  inventory.add(alice.id, '安神药剂', 1, 'unbound', now());

  advance(11_000);
  await say('私聊 · 使用安神药剂', { scene: 'private', rawText: '.使用 安神药剂' });
  advance(11_000);
  await say('私聊 · 调制愚者序列9魔药', { scene: 'private', rawText: '.魔药 seer_9' });
  advance(31_000);
  await say('群聊 · 服下魔药', { scene: 'group', rawText: '.服用' });

  // 交易：需要第二个玩家
  await say('私聊 · 第二个玩家建号', { scene: 'private', rawText: '.创建 正义 战士', userId: BOB, nickname: '正义' });
  const bob = characterRepo.findByUserId(BOB)!;
  inventory.add(bob.id, '金镑', 300, 'unbound', now());
  inventory.add(alice.id, '淬火匕首', 1, 'unbound', now());

  advance(11_000);
  const traded = await say('群聊 · 发起交易（物品立即冻结）', {
    scene: 'group',
    rawText: `.交易 @${BOB} 淬火匕首 1 120`,
  });
  const tradeId = /单号：(\w{6})/.exec(traded.map((m) => m.text).join('\n'))?.[1];
  if (tradeId) {
    advance(11_000);
    await say('私聊 · 买家确认（扣 5% 税）', { scene: 'private', rawText: `.确认 ${tradeId}`, userId: BOB, nickname: '正义' });
    advance(11_000);
    await say('私聊 · 卖家查看背包', { scene: 'private', rawText: '.背包' });
  }

  // ---- W4：晋升 / 恢复 / 占卜 / 队伍 / 每日结算 ----
  console.log('\n────────── W4：晋升、恢复、组队、每日结算 ──────────');
  advance(11_000);
  await say('群聊 · 创建队伍', { scene: 'group', rawText: '.队伍 创建' });
  advance(11_000);
  await say('私聊 · 队友加入（队长 QQ）', { scene: 'private', rawText: `.队伍 加入 @${ALICE}`, userId: BOB, nickname: '正义' });
  advance(11_000);
  await say('私聊 · 查看队伍', { scene: 'private', rawText: '.队伍' });

  advance(11_000);
  await say('私聊 · 占卜', { scene: 'private', rawText: '.占卜 我该不该去老码头' });
  advance(11_000);
  await say('私聊 · 休息（MAD-5、HP+20）', { scene: 'private', rawText: '.休息' });

  inventory.add(alice.id, '辅助材料·圣盐', 1, 'bound', now());
  inventory.add(alice.id, '辅助材料·银粉', 1, 'bound', now());
  advance(11_000);
  await say('私聊 · 净化（COR-15、MAD-5）', { scene: 'private', rawText: '.净化' });

  // 晋升演示：正常玩法里这些条件要靠扮演与探索慢慢攒
  const aliceState = characterRepo.findById(alice.id)!;
  characterRepo.update({ ...aliceState, dig: 70, mad: 5, cor: 0, updatedAt: now() });
  inventory.add(alice.id, '主材料·灰雾结晶', 2, 'unbound', now());
  advance(61_000);
  await say('群聊 · 晋升序列 8', { scene: 'group', rawText: '.晋升' });
  advance(11_000);
  await say('私聊 · 晋升后的状态', { scene: 'private', rawText: '.状态' });

  console.log('\n────────── 每日结算（手动触发一次，线上由定时器在 0 点执行）──────────');
  const tick = runDailyTick(app.router.deps, now());
  console.log(
    `每日结算：date=${tick.date} 角色=${tick.characters} 失控=${tick.lostControl} 恢复=${tick.recovered} 超时交易=${tick.tradesExpired} 重复执行=${runDailyTick(app.router.deps, now()).skipped}`,
  );
  for (const notice of tick.notifications) {
    console.log(`<<< [私聊 ${notice.userId}]`);
    console.log(notice.text.split('\n').map((line) => `    ${line}`).join('\n'));
  }

  // 重复推送：QQ 会重推同一条消息，必须只处理一次
  const dup: InternalMessage = {
    messageId: 'demo:duplicate-1',
    platform: 'onebot',
    scene: 'private',
    sceneId: ALICE,
    userId: ALICE,
    nickname: '克莱恩',
    rawText: '.状态',
    timestamp: now(),
  };
  console.log('\n>>> [私聊 · 同一条 message_id 连推两次] .状态');
  await adapter.deliver(dup);
  await adapter.deliver({ ...dup });
  const sent = adapter.take();
  console.log(`<<< 实际处理次数：${sent.length}（期望 1）`);

  const characters = app.db.prepare('SELECT COUNT(*) AS n FROM characters').get() as { n: number };
  const events = app.db.prepare('SELECT COUNT(*) AS n FROM domain_events').get() as { n: number };
  const idem = app.db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys').get() as { n: number };
  const audit = app.db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get() as { n: number };
  console.log(
    `\n落库统计：characters=${characters.n} domain_events=${events.n} idempotency_keys=${idem.n} audit_logs=${audit.n}`,
  );
  app.close();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
