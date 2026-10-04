import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness, DEFAULT_USER } from './helpers/app.ts';

test('私聊 .帮助 返回指令说明', async () => {
  const h = createHarness();
  const sent = await h.send({ rawText: '.帮助' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.scene, 'private');
  /*
   * ⚠️ M2.90：帮助文案在 M2.86 改过版（「内测指令」那个抬头没有了），
   * 而这条断言还盯着旧抬头 ⇒ 一直红着。判据改成盯**现在的**抬头。
   */
  assert.match(sent[0]?.text ?? '', /《诡秘之主：群星低语》/);
  assert.match(sent[0]?.text ?? '', /最常用的几条/);
  h.app.close();
});

/* ---------------- M2.7.6：创建是**两步** ----------------
 *
 * 第一步只问性别，第二步才建号；建出来的是一张白纸（没有途径、没有序列）。
 * 旧的 .创建 姓名 途径 被彻底删除 —— 那几条断言现在反过来守着「它必须被拒绝」。
 */
test('群聊 .创建：与私聊一致，群里直接摆出性别菜单', async () => {
  const h = createHarness();
  const sent = await h.send({ rawText: '.创建 克莱恩', scene: 'group' });
  // 群聊与私聊已合并成同一条路：一条完整回执，菜单直接落在群里
  assert.equal(sent.length, 1, '群聊一条完整回执（不再摘要 + 私聊明细两条）');
  assert.equal(sent[0]?.scene, 'group', '回执发回群里');
  assert.match(sent[0]?.text ?? '', /你是男性还是女性/);
  assert.match(sent[0]?.text ?? '', /1\. 男性/);
  assert.match(sent[0]?.text ?? '', /2\. 女性/);
  h.app.close();
});

test('私聊 .创建：两步建出一个普通人（没有途径、没有序列）', async () => {
  const h = createHarness();
  const asked = await h.send({ rawText: '.创建 克莱恩' });
  assert.equal(asked.length, 1);
  assert.match(asked[0]?.text ?? '', /你是男性还是女性/);
  assert.match(asked[0]?.text ?? '', /1\. 男性/);
  assert.match(asked[0]?.text ?? '', /2\. 女性/);

  const created = await h.send({ rawText: '1' });
  assert.match(created[0]?.text ?? '', /【创建角色】/);
  assert.match(created[0]?.text ?? '', /你还不知道自己会变成什么/);
  assert.match(created[0]?.text ?? '', /男性/);
  assert.equal((created[0]?.text ?? '').includes('途径：'), false, '回执里不该出现任何途径');

  const row = h.repos.characters.findByUserId(DEFAULT_USER)!;
  assert.equal(row.pathway, null, '创建时不能给途径');
  assert.equal(row.sequence, null, '创建时不能给序列');
  assert.equal(row.pathwayStatus, 'mortal');
  assert.equal(row.gender, 'male');
  assert.equal(row.mp, 50, '普通人灵性上限 50');
  h.app.close();
});

test('私聊 .创建：回 2 得到女性角色', async () => {
  const h = createHarness();
  await h.send({ rawText: '.创建 奥黛丽' });
  await h.send({ rawText: '2' });
  assert.equal(h.repos.characters.findByUserId(DEFAULT_USER)?.gender, 'female');
  h.app.close();
});

test('旧流程 .创建 姓名 途径 被明确拒绝（不是保留）', async () => {
  const h = createHarness();
  const sent = await h.send({ rawText: '.创建 克莱恩 愚者' });
  assert.match(sent[0]?.text ?? '', /不是你现在能选的东西/);
  assert.equal(h.repos.characters.findByUserId(DEFAULT_USER), null, '被拒绝时不能建出角色');
  h.app.close();
});

test('detailToPrivate=false 时群聊只发摘要', async () => {
  const h = createHarness({ detailToPrivate: false });
  const sent = await h.send({ rawText: '.创建 克莱恩', scene: 'group' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.scene, 'group');
  h.app.close();
});

test('重复推送（同 message_id）静默丢弃，不重复建号', async () => {
  const h = createHarness();
  const first = await h.send({ rawText: '.创建 克莱恩 男', messageId: 'dup-1' });
  const second = await h.send({ rawText: '.创建 克莱恩 男', messageId: 'dup-1' });
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  assert.equal((h.app.db.prepare('SELECT COUNT(*) AS n FROM characters').get() as { n: number }).n, 1);
  h.app.close();
});

test('并发两次 .创建 只会成功一次（actor 队列生效）', async () => {
  const h = createHarness();
  const [a, b] = await Promise.all([
    h.send({ rawText: '.创建 克莱恩 男', messageId: 'c-1' }),
    h.send({ rawText: '.创建 克莱恩 男', messageId: 'c-2' }),
  ]);
  const texts = [...a, ...b].map((s) => s.text).join('\n');
  assert.match(texts, /【创建角色】/);
  assert.match(texts, /你已经创建过角色了/);
  assert.equal((h.app.db.prepare('SELECT COUNT(*) AS n FROM characters').get() as { n: number }).n, 1);
  h.app.close();
});

test('.创建 参数校验：用法 / 姓名长度 / 违规名 / 不认识的性别选项', async () => {
  const h = createHarness();
  assert.match((await h.send({ rawText: '.创建' }))[0]?.text ?? '', /用法：\.创建 姓名/);
  assert.match(
    (await h.send({ rawText: '.创建 这个名字实在是太长了超过十六个字啦啦啦啦啦' }))[0]?.text ?? '',
    /姓名长度需 1—16 字/,
  );
  assert.match(
    (await h.send({ rawText: '.创建 克莱恩 别的什么' }))[0]?.text ?? '',
    /没有「别的什么」这个选项/,
  );
  h.app.close();
});

test('.状态：未建号提示 + 普通人状态卡（没有途径、没有序列）+ 建号后 SAN 由 MAD 推导', async () => {
  const h = createHarness();
  assert.match((await h.send({ rawText: '.状态' }))[0]?.text ?? '', /你还没有角色/);

  await h.send({ rawText: '.创建 克莱恩 男' });
  h.advance(6000);
  const mortal = await h.send({ rawText: '.状态' });
  assert.match(mortal[0]?.text ?? '', /还没有途径/, '普通人没有途径，状态卡上要说出来');
  // M2.45 第三版：emoji 前缀 + 进度条 + 「当前/上限（百分比）」
  // M2.45 第十版：`**灵性**　▰…　50/50`（表格换成紧凑文字行）
  // M2.90：数值外面套了上色标记（`$\textcolor{...}{50/50}$`）⇒ 别把标记写进判据
  assert.match(mortal[0]?.text ?? '', /\*\*灵性\*\*.*50\/50/, '普通人灵性上限 50');

  // 入途径之后才是熟悉的那张卡（用夹具把入途径那一步补上）
  const h2 = createHarness();
  await h2.createCharacter(DEFAULT_USER, '克莱恩');
  h2.advance(6000);
  const sent = await h2.send({ rawText: '.状态', scene: 'group' });
  assert.equal(sent.length, 1, '群聊与私聊同一条路：一条完整回执');
  assert.equal(sent[0]?.scene, 'group');
  // M2.45：状态卡改成了「加粗标签 + 全角间隔」，且不再自带【角色名】那一行 ——
  // 名字挪进了消息头（头像 / 昵称 / 性别 / 途径序列 / 分割线）
  // M2.45 第二版：三条核心数值各占一行并带进度条（`**理智**　100 / 100　▰▰▰…`）
  // M2.90：同上 —— 进度条与数值都套了上色标记
  assert.match(sent[0]?.text ?? '', /\*\*理智\*\*.*100\/100/);
  // M2.45 第十版 / M2.85：状态卡里没有表格，七项数值走紧凑文字行（命运在末行；
  // 原来这里还断言「行动:5/5」—— 随行动值一并删除）
  // M2.90：命运前面带 ✦ 标记（同 m2-45 那边）
  assert.match(sent[0]?.text ?? '', /命运:.*0\/10/);
  assert.match(sent[0]?.text ?? '', /▰/, '进度条画出来了');
  h.app.close();
  h2.app.close();
});

test('频控：5 秒内第二次 .状态 被拒', async () => {
  const h = createHarness();
  await h.createCharacter(DEFAULT_USER, '克莱恩');
  h.advance(6000);
  await h.send({ rawText: '.状态' });
  const blocked = await h.send({ rawText: '.状态' });
  assert.match(blocked[0]?.text ?? '', /冷却中/);
  h.advance(5000);
  assert.match((await h.send({ rawText: '.状态' }))[0]?.text ?? '', /序列 9/);
  h.app.close();
});

test('未识别指令与敏感词拦截', async () => {
  const h = createHarness();
  /*
   * M2.85：**未识别指令的口径变了**（用户要求：别形成骚扰）。
   *   · 群里 → 一个字都不回（骚扰就发生在这里）；
   *   · 私聊 → 一句极简「没有 .xxx 这条指令」，不再把全量指令表糊上来。
   * 敏感词拦截**不受影响** —— 那是安全问题，不是刷屏问题。
   */
  const priv = await h.send({ rawText: '.升维' });
  assert.equal(priv.length, 1, '私聊要回一条，否则玩家分不清"打错了"和"机器人挂了"');
  assert.match(priv[0]?.text ?? '', /没有 \.升维 这条指令/);
  assert.ok(!/可用指令/.test(priv[0]?.text ?? ''), '不再回一长串指令表');
  assert.equal((await h.send({ rawText: '.升维', scene: 'group' })).length, 0, '群里未知指令必须静默');

  assert.match((await h.send({ rawText: '.创建 加微信买魔药 愚者' }))[0]?.text ?? '', /违规内容/);
  assert.equal((await h.send({ rawText: '今天天气不错' })).length, 0, '非指令消息不回应');
  h.app.close();
});

test('审计日志记录了每一条处理过的指令', async () => {
  const h = createHarness();
  await h.send({ rawText: '.创建 克莱恩 男' });
  h.advance(6000);
  await h.send({ rawText: '.状态' });
  const rows = h.app.db
    .prepare('SELECT command FROM audit_logs ORDER BY id ASC')
    .all() as Array<{ command: string }>;
  assert.deepEqual(rows.map((r) => r.command), ['创建', '状态']);
  h.app.close();
});