import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadCommunity, renderBetaText, renderFaqText, renderRulesText } from '../src/data/community.ts';
import { resetSwitches, setSwitch } from '../src/config/switches.ts';
import { FeedbackRepo } from '../src/infra/db/feedback.ts';
import { UserActivityRepo } from '../src/infra/db/user-activity.ts';
import { computeBetaStats } from '../src/ops/stats.ts';
import { buildDailyReport } from '../src/ops/daily-report.ts';
import { checkAlerts, renderAlerts } from '../src/ops/alerts.ts';
import { buildMessageEvent } from '../src/loadtest/client.ts';
import { commandScript, judgeLoad, LOAD_THRESHOLDS } from '../src/loadtest/runner.ts';
import { createHarness } from './helpers/app.ts';

const A = '20001';

test('运营物料：FAQ ≥10 条、群规则、公告要点齐全且能渲染', () => {
  const community = loadCommunity();
  assert.deepEqual(community.issues, []);
  assert.ok(community.faq.length >= 10);
  assert.ok(community.rules.rules.length >= 3);
  assert.ok(community.rules.punishment.length >= 1);
  assert.ok(community.beta.scope.length >= 3);
  assert.ok(community.beta.not_included.length >= 2);

  const faqText = renderFaqText(community.faq);
  assert.match(faqText, /1\./);
  assert.match(renderRulesText(community.rules), /禁止刷屏/);
  const betaText = renderBetaText(community.beta);
  assert.match(betaText, /开放范围/);
  assert.match(betaText, /本次不做/);
});

test('.帮助 faq / 规则 / 公告：三种主题都能查', async () => {
  const h = createHarness();
  await h.createCharacter(A, '克莱恩');

  h.advance(11_000);
  const faq = await h.send({ rawText: '.帮助 faq', userId: A });
  assert.match(faq[0]?.text ?? '', /封测 FAQ/);
  assert.match(faq[0]?.text ?? '', /怎么晋升/);

  h.advance(11_000);
  const rules = await h.send({ rawText: '.帮助 规则', userId: A });
  assert.match(rules[0]?.text ?? '', /群规则/);
  assert.match(rules[0]?.text ?? '', /禁止诈骗/);

  h.advance(11_000);
  const beta = await h.send({ rawText: '.帮助 公告', userId: A });
  assert.match(beta[0]?.text ?? '', /开放范围/);
  assert.match(beta[0]?.text ?? '', /已知问题/);
  h.app.close();
});

test('新手引导：两步建号，回执里有城市、性别与「你还不知道自己会变成什么」', async () => {
  const h = createHarness();
  const asked = await h.send({ rawText: '.创建 克莱恩', userId: A });
  assert.match(asked[0]?.text ?? '', /你是男性还是女性/, '第一步只问性别');

  const sent = await h.send({ rawText: '1', userId: A });
  const text = sent[0]?.text ?? '';
  assert.match(text, /你出生在/, '回执要有出生城市');
  assert.match(text, /男性/, '回执要体现刚选的性别');
  assert.match(text, /你还不知道自己会变成什么/, '这一句是 M2.7.6 的口径');
  // 普通人阶段的三个入口：四处走走 / 看状态 / 看有没有人在注意你
  // （M2.85：第三项由 .线索 接替已删的 .引导）
  assert.match(text, /\.探索 /);
  assert.match(text, /\.状态/);
  assert.match(text, /\.线索/);
  assert.match(text, /\.帮助/);
  h.app.close();
});

test('.反馈：写入 feedback 表并返回编号；过短被拒', async () => {
  const h = createHarness();
  const character = await h.createCharacter(A, '克莱恩');

  h.advance(11_000);
  const short = await h.send({ rawText: '.反馈 短', userId: A });
  assert.match(short[0]?.text ?? '', /写得太短/);
  assert.equal(h.repos.feedback.count(), 0);

  h.advance(11_000);
  const ok = await h.send({ rawText: '.反馈 消化度涨得太慢，希望调整', userId: A });
  assert.match(ok[0]?.text ?? '', /反馈已记录（编号 #\d+）/);
  assert.equal(h.repos.feedback.count(), 1);
  const rows = h.repos.feedback.recent(5);
  assert.equal(rows[0]?.userId, A);
  assert.equal(rows[0]?.characterId, character.id);
  assert.match(rows[0]?.content ?? '', /消化度/);
  h.app.close();
});

test('行为埋点：指令会累加到 user_daily，可用于留存与指令分布', async () => {
  const h = createHarness();
  await h.createCharacter(A, '克莱恩');
  h.advance(11_000);
  await h.send({ rawText: '.状态', userId: A });
  h.advance(11_000);
  await h.send({ rawText: '.背包', userId: A });

  const activity = new UserActivityRepo(h.app.db);
  const dates = activity.dates();
  assert.equal(dates.length, 1);
  const counters = activity.commandTotals();
  assert.equal(counters['创建'], 1);
  assert.equal(counters['状态'], 1);
  assert.equal(counters['背包'], 1);
  assert.equal(activity.dauOn(dates[0]!), 1);
  assert.equal(activity.newUsersOn(dates[0]!), 1);
  h.app.close();
});

test('封测统计：留存、新手完成率、投诉率、玩法指标都能算出来', async () => {
  const h = createHarness();
  const character = await h.createCharacter(A, '克莱恩');
  h.advance(11_000);
  await h.send({ rawText: '.扮演 我占卜今天的运势', userId: A });
  h.advance(11_000);
  await h.send({ rawText: '.反馈 投诉：有人刷屏', userId: A });
  const rows = h.repos.feedback.recent(5);
  h.repos.feedback.setCategory(rows[0]!.id, '投诉');

  const stats = computeBetaStats(h.app.db);
  assert.equal(stats.totalUsers, 1);
  assert.equal(stats.onboardingRate, 1, '创建 + 至少扮演一次 = 完成新手');
  assert.equal(stats.feedback.complaints, 1);
  assert.ok(stats.gameplay.characters === 1);
  assert.ok(stats.commandTotals['扮演'] === 1);
  assert.ok(stats.retention.length >= 1);
  assert.equal(stats.gameplay.deadlockRate, 0);
  void character;
  h.app.close();
});

test('封测日报：markdown 结构完整，并能落 beta_daily 快照', async () => {
  const h = createHarness();
  await h.createCharacter(A, '克莱恩');
  h.advance(11_000);
  await h.send({ rawText: '.状态', userId: A });

  const date = new UserActivityRepo(h.app.db).dates()[0]!;
  const report = buildDailyReport(h.app.db, date);
  assert.match(report.markdown, /# 封测日报/);
  assert.match(report.markdown, /## 二、留存/);
  assert.match(report.markdown, /## 三、玩法与数值/);
  assert.match(report.markdown, /模拟器预测（W5）/);
  assert.match(report.markdown, /## 四、告警/);

  h.app.db
    .prepare(
      `INSERT INTO beta_daily (date, dau, new_users, commands, feedback_count, deadlock_rate, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(date, 1, 1, 2, 0, 0, '{}', Date.now());
  const row = h.app.db.prepare('SELECT dau FROM beta_daily WHERE date = ?').get(date) as { dau: number };
  assert.equal(row.dau, 1);
  h.app.close();
});

test('告警：死循环超阈值触发 P0；应急开关被打开留有痕迹', async () => {
  const h = createHarness();
  const character = await h.createCharacter(A, '克莱恩');
  h.repos.characters.update({
    ...h.repos.characters.findById(character.id)!,
    dig: 100,
    mad: 100,
    cor: 100,
    updatedAt: h.now(),
  });

  const alerts = checkAlerts(h.app.db, '2026-09-21');
  const deadlock = alerts.find((alert) => alert.code === 'DEADLOCK_RATE');
  assert.ok(deadlock, '死循环比例 100% 必须告警');
  assert.equal(deadlock?.level, 'P0');
  assert.match(renderAlerts(alerts).join('\n'), /EMERGENCY_PURIFY_HALF/);

  setSwitch('purifyHalfCost', true);
  try {
    const switched = checkAlerts(h.app.db, '2026-09-21');
    assert.ok(switched.some((alert) => alert.code === 'EMERGENCY_SWITCH_ON'));
  } finally {
    resetSwitches();
  }
  h.app.close();
});

test('应急开关：打开后净化不再消耗材料，并在回执里标注', async () => {
  const h = createHarness();
  const character = await h.createCharacter(A, '克莱恩');
  h.repos.characters.update({
    ...h.repos.characters.findById(character.id)!,
    cor: 60,
    mad: 60,
    updatedAt: h.now(),
  });

  setSwitch('purifyHalfCost', true);
  try {
    h.advance(11_000);
    const sent = await h.send({ rawText: '.净化', userId: A });
    assert.match(sent[0]?.text ?? '', /【应急】净化消耗已减半/);
    assert.equal(h.repos.inventory.count(character.id, '辅助材料·圣盐'), 0, '不需要材料也能净化');
    assert.equal(h.repos.characters.findById(character.id)!.cor, 45);
  } finally {
    resetSwitches();
  }

  // 关掉开关后又要材料了
  h.repos.characters.update({ ...h.repos.characters.findById(character.id)!, updatedAt: h.now() });
  h.advance(24 * 60 * 60 * 1000);
  const blocked = await h.send({ rawText: '.净化', userId: A });
  assert.match(blocked[0]?.text ?? '', /净化材料不足/);
  h.app.close();
});

test('反馈仓储：分类、处理状态与投诉计数', () => {
  const h = createHarness();
  const repo = new FeedbackRepo(h.app.db);
  const id = repo.add({ userId: A, content: '这是一条测试反馈', createdAt: h.now() });
  assert.equal(repo.count(), 1);
  repo.setCategory(id, '投诉');
  assert.equal(repo.countByCategory('投诉'), 1);
  repo.markHandled(id, h.now());
  const row = repo.getById(id);
  assert.equal(row?.status, 'triaged');
  assert.ok(row?.handledAt !== null);
  h.app.close();
});

test('压测工具：指令脚本为 20 条、事件构造兼容数字与字符串 message_id', () => {
  const script = commandScript(7);
  assert.equal(script.length, 20);
  assert.match(script[0]!, /^\.创建 压测者7 /);
  assert.ok(script.some((line) => line.startsWith('.反馈')));

  const numeric = buildMessageEvent({ messageId: '12345', userId: 'u1', rawText: '.状态', scene: 'private' });
  assert.equal(numeric.message_id, 12345);
  const textual = buildMessageEvent({ messageId: 'w6-1', userId: 'u1', rawText: '.状态', scene: 'group' });
  assert.equal(textual.message_id, 'w6-1');
  assert.equal(textual.group_id, 10001);
  assert.equal(textual.message_type, 'group');
});

test('压测判定：阈值不达标要明确失败', () => {
  const base = {
    users: 100,
    perUser: 20,
    total: 2000,
    ok: 2000,
    errors: 0,
    errorRate: 0,
    p50Ms: 10,
    p90Ms: 20,
    p95Ms: 100,
    p99Ms: 200,
    maxMs: 300,
    meanMs: 15,
    wallMs: 5000,
    throughputPerSec: 400,
    statusCounts: { 200: 2000 },
    sampleErrors: [],
    alive: true,
    effects: { characters: 100, auditRows: 2000, idempotencyKeys: 2000, userDaily: 100 },
  };
  assert.equal(judgeLoad(base).pass, true);

  assert.equal(judgeLoad({ ...base, p95Ms: LOAD_THRESHOLDS.p95Ms }).pass, false);
  assert.equal(judgeLoad({ ...base, errorRate: 0.01 }).pass, false);
  assert.equal(judgeLoad({ ...base, alive: false }).pass, false);
  const dropped = judgeLoad({ ...base, effects: { ...base.effects, characters: 3 } });
  assert.equal(dropped.pass, false, '请求被静默丢弃不能算通过');
  assert.match(dropped.failures.join('；'), /可能有请求被静默丢弃/);
});
