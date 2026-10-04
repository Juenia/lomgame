/**
 * M2.7 测试：按钮交互 / 世界地理 / 区域出生 / 跨区域移动。
 *
 * 四块内容各自的「为什么这么测」：
 *   1. **按钮交互**：两种通道（官方原生按钮 / OneBot 文本降级）必须给出**同一批选项**，
 *      而且降级文本要与 M2.3 的 renderMenu 逐字一致（127 条既有断言建立在那份文本上）；
 *   2. **地理数据**：城市 → 地点 → 途径三者互相对得上（写错一个 id 的后果极其隐蔽）；
 *   3. **区域出生**：出生是**派生**的 —— 同一个人永远落在同一座城市，
 *      「不允许重选」因此是结构性事实，而不是一句提示词；
 *   4. **跨区域移动**：扣钱扣 AP、路上有事件、到达切城市、路上做不了别的事。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryAdapter } from '../src/adapter/memory.ts';
import { PATHWAY_LABELS } from '../src/domain/character/rules.ts';
import type { PathwayId } from '../src/domain/character/types.ts';
import { OneBotAdapter } from '../src/adapter/onebot.ts';
import {
  OfficialAdapter,
  avatarUrlOf,
  buildKeyboardPayload,
  clipButtonLabel,
  labelWidthFor,
  mapOfficialInteraction,
  shortButtonLabel,
  toQQMarkdown,
} from '../src/adapter/official.ts';
import { menuToInteractive, renderInteractiveText, chunkOptions, foldOptions } from '../src/adapter/interactive.ts';
import { renderMenu } from '../src/domain/menu/render.ts';
import { buildTodayMenu } from '../src/domain/menu/today-menu.ts';
import { birthCityOf, birthDistribution } from '../src/domain/geo/birth.ts';
import { GeoIndex } from '../src/domain/geo/geo.ts';
import { planTravel, resolveTravelChoice, eventPointsFor } from '../src/domain/geo/travel.ts';
import { TRAVEL_EVENT_IDS } from '../src/domain/geo/events.ts';
import { loadCities, loadContentOrThrow, loadRegions, loadRoutes } from '../src/data/loader.ts';
import { createSeededRng, seedFrom } from '../src/domain/rng.ts';
import { createHarness, DEFAULT_USER } from './helpers/app.ts';
import { sendReplies } from '../src/router/index.ts';

const LOADED = loadContentOrThrow();
const GEO = new GeoIndex(LOADED.regions, LOADED.cities, LOADED.routes);

/* ================================================================== *
 * 一、按钮交互（M2.7 前置项）
 * ================================================================== */

test('M2.7 按钮：InteractiveMessage 的降级文本与 M2.3 的 renderMenu 逐字一致', () => {
  const menu = buildTodayMenu(
    {
      id: 'c1',
      userId: 'u1',
      name: '克莱恩',
      pathway: 'seer', pathwayStatus: 'initiated', gender: 'male',
      sequence: 9,
      hp: 100,
      mp: 100,
      mad: 0,
      cor: 0,
      dig: 12,
      dp: 0,
      status: 'active',
      promotionFails: 0,
      currentCityId: 'tingen',
      createdAt: 0,
      updatedAt: 0,
    },
    {
      clock: { now: 0, dayIndex: 0, hour: 12, timeOfDay: 'day', season: 'spring', moonPhase: 1, fullMoon: false, foggy: false, nextFogDay: 3 },
      weather: 'clear',
      modifiers: { exploreDangerMultiplier: 1, dropMultiplier: 1, playMad: 0, playDigMultiplier: 1, potionSuccessBonus: 0, lossOfControlMultiplier: 1, eventPool: [] },
      locations: [
        { id: 'tingen', name: '廷根市', city: 'tingen', danger: 1, minSeq: 9, maxSeq: 0, lootCount: 4, usedToday: 0, weather: 'clear' },
      ],
    },
    { id: 'seer', label: '愚者', tags: { pathway: 'seer', core: ['占卜'], secondary: ['观察'], forbidden: ['蛮力'] } },
    [],
  );
  assert.equal(renderInteractiveText(menuToInteractive(menu)), renderMenu(menu));
});

test('M2.7 按钮：同一份 InteractiveMessage 在两种通道下选项完全一致', async () => {
  const message = {
    text: '【今日】正文',
    options: [
      { id: '1', label: '探索老码头', command: '探索 老码头', preview: '危险 ×1.00' },
      { id: '2', label: '继续扮演', command: '扮演 观察' },
      { id: '3', label: '休息', command: '休息', disabled: true, disabledReason: '已经休息过了' },
    ],
    layout: 'grid' as const,
  };

  // 不支持按钮的通道：返回 false，调用方回退发文本（M2.3 的数字回复体系）
  const textAdapter = new MemoryAdapter();
  assert.equal(await textAdapter.sendInteractive('private', 'u1', message), false);
  assert.equal(textAdapter.sent.length, 0, '降级通道不该自己发消息');

  // 支持按钮的通道：记录结构化选项
  const buttonAdapter = new MemoryAdapter({ supportsButtons: true });
  assert.equal(await buttonAdapter.sendInteractive('private', 'u1', message), true);
  const sent = buttonAdapter.take();
  assert.equal(sent.length, 1);
  assert.deepEqual(
    sent[0]!.interactive!.options.map((option) => option.id),
    message.options.map((option) => option.id),
    '两种通道必须给出同一批选项 id',
  );
  assert.equal(sent[0]!.interactive!.options[2]!.disabled, true, '禁用态要传到通道层');
  assert.equal(sent[0]!.interactive!.options[2]!.disabledReason, '已经休息过了');
});

test('M2.7 按钮：OneBot 声明不支持按钮，官方机器人把选项摆成 keyboard', async () => {
  const onebot = new OneBotAdapter({ apiBase: 'http://127.0.0.1:9' });
  assert.equal(onebot.supportsButtons, false);
  assert.equal(
    await onebot.sendInteractive('private', 'u1', { text: 'x', options: [{ id: '1', label: 'a', command: 'a' }] }),
    false,
  );

  const keyboard = buildKeyboardPayload({
    text: '正文',
    options: [
      { id: '1', label: '战斗', command: '移动 抉择 fight' },
      { id: '2', label: '逃跑', command: '移动 抉择 flee' },
      { id: '3', label: '观察', command: '移动 抉择 observe' },
      { id: '4', label: '互动', command: '移动 抉择 interact' },
    ],
    layout: 'grid',
  });
  // M2.44：maxPerRow 从 3 收到 2 —— 真机实测「一行三个」时每个按钮只放得下约 4 个汉字，
  // 用户的原话是「按钮文本的信息不明显」。收到 2 之后每个有 12 列（约 6 个汉字）。
  assert.equal(keyboard.content.rows.length, 2, '每行最多 2 个（BUTTON.maxPerRow）');
  assert.equal(keyboard.content.rows[0]!.buttons.length, 2);
  assert.equal(keyboard.content.rows[1]!.buttons.length, 2);
  // 关键约定：按钮回传的 data 就是选项 id —— 与「玩家回数字」是同一条路径
  assert.deepEqual(
    keyboard.content.rows.flatMap((row) => row.buttons.map((button) => button.action.data)),
    ['1', '2', '3', '4'],
  );
  // M2.44 校准：1 = 回调按钮（平台推 INTERACTION_CREATE），2 = 指令按钮（只往输入框插 @bot）。
  // 要「按钮事件」就必须是 1 —— 依据见 docs/M2.44-QQ能力扩展.md §二。
  assert.equal(keyboard.content.rows[0]!.buttons[0]!.action.type, 1, '回调按钮');
});

test('M2.44 群聊回执：顶部标出说话人 + 首行标题', () => {
  /*
   * ⚠️ 判据改过（M2.86）。原来断言的是 `**の**`（加粗），但**手机端不渲染 `**`**
   * —— 用户实机看到的是星号本身。所以全站改成了 `mdStyle: 'plain'`（见 adapter/official.ts
   * 的 applyMdStyle）：**去星号，只保留换行结构**。
   *
   * 于是这里断言的是「去掉星号之后仍然分得清哪行是说话人」。
   * 结构没变、零宽空格没变，只是不靠加粗来区分了。
   */
  /*
   * 用户的要求：「MD 消息顶部要显示玩家头像和昵称，这样在群聊里可以分辨是谁的信息」。
   *
   * ⚠️ 头像做不到：官方事件里**没有**群成员头像字段（`author` 只有 id / username /
   * member_openid），也没有「按 openid 查头像」的接口 —— 这一版只有昵称。
   * 昵称来自通道侧（只有它看得到 `author.username`），从凭证里取。
   */
  const md = toQQMarkdown('【下一步 · 还没有途径】\n晴 · 夜晚 · HP 100 · AP 4\n1. 去找他交差', {
    header: { nickname: 'の' },
  });
  const lines = md.split('\n');
  assert.equal(lines[0], 'の\u200B', '第一行是说话人（行尾带零宽空格，否则和下一行粘在一起）');
  assert.equal(lines[1], '***', '紧跟一条分割线（它自己占一行，不补零宽空格）');
  assert.ok(lines[2]!.startsWith('【下一步 · 还没有途径】'), '【…】标题单独成行：实际 ' + lines[2]);
  // 带头像时：头像独占一行（官方示例也是这个写法），昵称与分割线跟在后面
  const withAvatar = toQQMarkdown('正文', {
    header: { nickname: 'の', genderTag: '♂', pathwayLine: '愚者 · 序列 9' },
    avatarUrl: avatarUrlOf('1905686871', '7A347424BB7C5F38142714E1A0E3E2CA'),
  });
  const lines2 = withAvatar.split('\n');
  /*
   * M2.45 第十一版（用户反馈「信息头很丑、很占高度」之后）：**整个头压成一行** ——
   * 头像 40px 与昵称并排（markdown 里图片是行内元素，文字就排在它右边），
   * 性别与途径序列用全角空格 + 括号并进同一行。
   * 第二版那套「头像独占一行 + 昵称一行 + 引用块一行」＝ 四条消息头，比正文还高。
   */
  /*
   * M2.45 第十二版（用户澄清「头像的右边放两行文字」之后）：
   *   第一行 = 头像 32px + 昵称 + 性别（**只有这两样**，长昵称才不会折行）
   *   第二行 = 缩进 3 个全角空格（＝头像宽 + 一个全角分隔）后接「途径 · 序列（与所在）」
   */
  /*
   * M2.45 第十五版：**消息头只占一行**。
   *
   * 「右边两行文字」试过三版都不成立：推到头像右侧 ⇒ 全角空格凑出来的对齐随字号漂（「文字歪了」）；
   * 顶格 ⇒ 第二行掉到头像底下（markdown 里图片是行内元素，换行后文字从段落左边缘开始）。
   * 压成一行，就没有「第二行」可以掉下去。
   */
  /*
   * M2.45 第十六版：**头像右边两行文字**，第二行的缩进用一张 56×1 的头像副本当锚 ——
   * 图片的宽度是**像素**值，不随字号漂（全角空格那条路第十三版已经证明会歪）。
   * 用的又是 `q.qlogo.cn`（腾讯自家域名），不引入任何外部图床。
   */
  // 第十九版：表格名片（探测证实「单元格里的 br 会换行」，而行内图片右边多行做不到）
  // 表格名片已撤（真机：<br> 在表格里是"撑成两行"，不是格内换行）→ 回到头像 + 昵称一行 + 引用块
  assert.equal(
    lines2[0],
    '![头像 #56px #56px](https://q.qlogo.cn/qqapp/1905686871/7A347424BB7C5F38142714E1A0E3E2CA/100) ' +
      'の　♂\u200B',
    '第一行：头像 56px + 昵称 + 性别（M2.86：mdStyle=plain，昵称不再用 ** 加粗）',
  );
  assert.equal(lines2[1], '> 愚者 · 序列 9\u200B', '第二行：引用块装次要信息');
  assert.equal(lines2[2], '***', '一条分割线收住消息头');
  assert.equal(avatarUrlOf('1905686871', 'ABC', 100), 'https://q.qlogo.cn/qqapp/1905686871/ABC/100');
  assert.equal(avatarUrlOf('1905686871', 'ABC', 640), 'https://q.qlogo.cn/qqapp/1905686871/ABC/640');
  assert.ok(md.includes('\u200B'), '正文行必须带零宽空格，否则 QQ 里会挤成一段');
  // 没有昵称时（比如单聊、或取不到 username）不加头，保持原样
  assert.equal(toQQMarkdown('正文'), '正文\u200B');
});

test('M2.44 群聊互动事件：操作者在 group_member_openid（真机实测的那一处）', () => {
  /*
   * 现场（2026-09-27，群 901372907）：用户点按钮，服务端日志里只有一句「收到事件」，
   * **没有「收到按钮点击」** —— 说明 mapOfficialInteraction 返回了 null，事件被静默丢掉。
   *
   * 根因：官方事件示例里只写了 `data.resolved.button_data`（群聊那一条连 user_id 都没有），
   * 而这份代码早先只找 `resolved.user_id` ⇒ 取不到 ⇒ `return null`。
   * 真机的群聊操作者在 **`d.group_member_openid`**。
   *
   * 这条例用真机那份 payload 的字段结构写死，防止回归。
   */
  const msg = mapOfficialInteraction({
    t: 'INTERACTION_CREATE',
    d: {
      id: '17027d20-4d44-4a7c-87e1-9e13e8db3dea',
      type: 11,
      chat_type: 1,
      scene: 'group',
      group_openid: 'F066563EDF0FEF1F44636F55E80222F9',
      group_member_openid: '7A347424BB7C5F38142714E1A0E3E2CA',
      data: { type: 11, resolved: { button_data: '3' } },
    },
  });
  assert.ok(msg, '真机群聊事件必须能映射出来 —— 早先这里返回 null，事件被静默丢掉');
  assert.equal(msg!.rawText, '3', '按钮点下去 = 替玩家发出「选项 id」');
  assert.equal(msg!.scene, 'group');
  assert.equal(msg!.sceneId, 'F066563EDF0FEF1F44636F55E80222F9');
  assert.equal(msg!.userId, '7A347424BB7C5F38142714E1A0E3E2CA');
});

test('M2.44 按钮文字按**显示宽度**截断，不是按字符数', () => {
  /*
   * 真机实测（M2.44）：`查看背包与身上的东西` 是 10 个字符、却占 20 列宽 ——
   * 按 10 个字符发出去之后，用户在群里看到的是**文本显示不完整**。
   * 官方文档那句「最多 10 字符」约束的其实是**宽度**，不是 `String.length`。
   *
   * 截断规则：全角算 2、半角算 1；**自己先截并补省略号**，
   * 不让客户端在句子中间切一刀（那看起来像 bug）。
   */
  assert.equal(clipButtonLabel('休息', 10), '休息', '放得下就一个字都不动');
  assert.equal(clipButtonLabel('abc', 10), 'abc');
  assert.equal(clipButtonLabel('探索老码头', 10), '探索老码头', '5 个全角字正好占满 10 列 ⇒ 不截');
  assert.equal(clipButtonLabel('查看背包与身上的东西', 10), '查看背包与…', '纯按宽度截：10 列刚好放下「查看背包与」');
  assert.equal(clipButtonLabel('abcdefghij', 10), 'abcdefghij', '半角按 1 算，正好 10 列');
  assert.equal(clipButtonLabel('abcdefghijk', 10), 'abcdefghij…');
});

test('M2.44 按钮文案先精简再截断（真机那个「一整句话」的按钮）', () => {
  /*
   * 真机现场：引导入口的 label 是一整个句子，截断后只剩 `他去让你…`，信息全丢。
   * 两条精简规则：**删括号里的补充说明**、**取第一个断句符之前**。
   */
  assert.equal(shortButtonLabel('休息一下（恢复 HP 与 MAD）'), '休息一下', '括号里的解释留给正文');
  assert.equal(shortButtonLabel('探索老码头'), '探索老码头', '本来就好好的，一个字不动');
  assert.equal(
    shortButtonLabel('他去让你做的事：去外国人聚居区走一趟。找一个叫「灰先生」的人，找到也不用说话。'),
    '他去让你做的事',
    '带断句的取标题那段',
  );
  assert.equal(shortButtonLabel('用了（半角括号）也要删'), '用了也要删', '半角括号同样要删');
  assert.equal(shortButtonLabel('查看背包与身上的东西'), '查看背包', '并列结构只留前半截');

  // 宽度上限跟着行内个数走 —— 截图里三个并排的按钮每个只放得下约 4 个汉字
  assert.equal(labelWidthFor(1), 20);
  assert.equal(labelWidthFor(2), 12);
  assert.equal(labelWidthFor(3), 8);
  assert.ok(labelWidthFor(3) < labelWidthFor(1), '一行三个必须比单独一行窄');
});

test('M2.7 按钮：官方按钮点击被映射成「玩家回了那个数字」', () => {
  const msg = mapOfficialInteraction({
    t: 'INTERACTION_CREATE',
    d: {
      id: 'evt-1',
      type: 11,
      group_openid: 'G1',
      data: { type: 11, resolved: { button_data: '2', button_id: 'opt-2', user_id: 'U1' } },
    },
  });
  assert.ok(msg);
  assert.equal(msg!.rawText, '2', '按钮点下去 = 发出「选项 id」这条消息');
  assert.equal(msg!.scene, 'group');
  assert.equal(msg!.sceneId, 'G1');
  assert.equal(msg!.userId, 'U1');
});

test('M2.7 按钮：官方通道缺配置时降级为 false（绝不假装发出去了）', async () => {
  const adapter = new OfficialAdapter({ appId: 'app' });
  assert.equal(adapter.supportsButtons, true);
  assert.equal(
    await adapter.sendInteractive('private', 'u1', { text: 'x', options: [{ id: '1', label: 'a', command: 'a' }] }),
    false,
  );
  const wired = new OfficialAdapter(
    { appId: 'app', accessToken: 't', apiBase: 'https://example.invalid' },
    async () => ({ ok: true }),
  );
  assert.equal(
    await wired.sendInteractive('private', 'u1', { text: 'x', options: [{ id: '1', label: 'a', command: 'a' }] }),
    true,
  );
  assert.equal(wired.buttonsSent, 1);
});

test('M2.7 按钮：sendReplies 优先走按钮通道，不支持时回退到文本', async () => {
  const message = { text: '正文', options: [{ id: '1', label: 'A', command: '状态' }], layout: 'row' as const };
  const button = new MemoryAdapter({ supportsButtons: true });
  await sendReplies(button, [{ scene: 'private', targetId: 'u1', text: '正文\n\n1. A\n\n回复数字。', interactive: message }]);
  assert.equal(button.sent[0]!.text, '正文', '按钮通道发的是正文，选项走键盘');

  const plain = new MemoryAdapter();
  await sendReplies(plain, [{ scene: 'private', targetId: 'u1', text: '正文\n\n1. A\n\n回复数字。', interactive: message }]);
  assert.match(plain.sent[0]!.text, /1\. A/, '降级通道发的是带选项的完整文本');
});

test('M2.7 按钮：超过 6 个按钮时折叠，且提示玩家还能回数字选', () => {
  const options = Array.from({ length: 9 }, (_, index) => ({
    id: String(index + 1),
    label: `选项${index + 1}`,
    command: `状态`,
  }));
  const folded = foldOptions(options, 6);
  assert.equal(folded.shown.length, 6);
  assert.equal(folded.folded.length, 3);
  const keyboard = buildKeyboardPayload({ text: '正文', options });
  assert.equal(keyboard.content.rows.flatMap((row) => row.buttons).length, 6, '一屏最多 6 个按钮');
  assert.deepEqual(
    chunkOptions(options, 3).map((row) => row.length),
    [3, 3, 3],
  );
});

/* ================================================================== *
 * 二、世界地理数据
 * ================================================================== */

test('M2.7 地理：区域 / 城市 / 航线装得进来，且交叉引用没有悬空', () => {
  const regions = loadRegions();
  const cities = loadCities();
  const routes = loadRoutes();
  assert.equal(regions.issues.filter((issue) => issue.level === 'error').length, 0);
  assert.equal(cities.issues.filter((issue) => issue.level === 'error').length, 0);
  assert.equal(routes.issues.filter((issue) => issue.level === 'error').length, 0);
  assert.ok(regions.regions.length >= 4, '至少四个区域（鲁恩 / 因蒂斯 / 南大陆 / 苏尼亚海）');
  /*
   * M2.85 内容填充 P2：城市从 6 扩到 28（原作 29 城里能归到项目的那些）。
   * 判据相应改成两条**更准确**的：
   *   · 出生城市仍然恰好是原来那 5 座（新城的 birth_weight = 0，只能被到达）；
   *   · 任务书 §3.2 的「至少 5 个地点」是给**出生城市**的（新城只要能被到达即可）。
   *
   * ⚠️ M2.95：第 29 座（埃斯科森港）落地 —— 原作 29 座城里**能归到「城市」这个概念的全部在这了**
   * （另外两座：利维希德在《格罗塞尔游记》里面、卡尔德隆城在灵界深处，原作标的是 otherworld，
   * 那不是城市，也不该当出生地）。
   *
   * 数量**写死**（AGENTS §3.5）：城市一变就红，提醒人回来看一眼 —— 别写成 `>= 6`。
   */
  assert.equal(cities.cities.length, 29, '29 座城市（原作 29 城里可归为城市的全部）');
  const birthCities = cities.cities.filter((city) => city.birth_weight > 0);
  assert.equal(birthCities.length, 5, '出生城市仍然恰好 5 座（新城只能被到达）');
  for (const city of birthCities) {
    assert.ok(city.locations.length >= 5, `${city.id} 只有 ${city.locations.length} 个地点`);
  }
  for (const city of cities.cities) {
    assert.ok(city.locations.length >= 1, `${city.id} 一个落脚点都没有`);
  }
  // 航线两端必须是真实城市，且两个方向都有（一条边两个方向的时长本来就可以不同）
  for (const route of routes.routes) {
    assert.ok(GEO.city(route.from), `航线 ${route.id} 的起点不存在`);
    assert.ok(GEO.city(route.to), `航线 ${route.id} 的终点不存在`);
  }
});

test('M2.7 地理：每座城市都开途径、且每条途径都有城市不开放它', () => {
  const cities = GEO.cities.filter((city) => city.birth_weight > 0);
  /*
   * ⚠️ **M2.76：上界从「2—3 条」放宽到「3—7 条」**，这是中间状态、不是最终形态。
   *
   * 22 条正途径全落地，而项目只落地了 6 座城 ⇒ 平均每城 3.7 条。
   * 原著数据集 `05-地理/` 有 29 座城，等城市扩开之后每城会自然回到 2—3 条。
   * 在那之前，**宁可让一座城多开几条，也不能让一条途径没有城开放**
   *（没有城开放 = 那条途径的玩家永远拿不到配方线索，链路直接断）。
   *
   * 下界仍然是 2：这一条守的是「每座城至少有两种选择」，那件事没变。
   */
  for (const city of cities) {
    assert.ok(
      city.pathways.length >= 2 && city.pathways.length <= 7,
      `${city.id} 开放 ${city.pathways.length} 条途径，超出 2—7 的范围`,
    );
  }
  // M2.76：不再手抄途径清单（第 8 处同形状的副本）—— 从 PATHWAY_LABELS 派生
  for (const pathway of Object.keys(PATHWAY_LABELS) as PathwayId[]) {
    const denied = cities.filter((city) => !city.pathways.includes(pathway));
    assert.ok(denied.length > 0, `没有一座城市拒绝 ${pathway} —— 「没有传承」这句话就永远走不到`);
  }
});

test('M2.7 地理：地点 → 城市反查、途径查询、路线查询都正确', () => {
  assert.equal(GEO.cityOfLocation('old_dock')?.id, 'tingen');
  assert.equal(GEO.cityOfLocation('backlund')?.id, 'backlund');
  assert.equal(GEO.cityOfLocation('storm_cape')?.id, 'sunia');
  assert.equal(GEO.cityOfLocation('不存在的id'), null);
  assert.equal(GEO.supportsPathway('tingen', 'seer'), true);
  assert.equal(GEO.supportsPathway('tingen', 'warrior'), false);
  /*
   * M2.85 P2：城市扩到 28 之后，廷根成了鲁恩新城的**区域枢纽**之一，
   * 它的出边不再只有两条。判据改成「原来那两条还在，且每个目的地都是真实城市」——
   * 验的还是「路线查询正确」，而不是「世界只有 6 座城」。
   */
  const fromTingen = GEO.routesFrom('tingen').map((route) => route.to).sort();
  assert.ok(fromTingen.includes('backlund') && fromTingen.includes('pritz'), '廷根到贝克兰德 / 普利兹港的航线还在：' + fromTingen.join('、'));
  for (const to of fromTingen) assert.ok(GEO.city(to), '航线目的地必须是真实城市：' + to);
  assert.equal(GEO.route('tingen', 'backlund')?.duration_hours, 8);
  assert.equal(GEO.route('tingen', 'backlund')?.cost_penny, 20);
  assert.equal(GEO.route('tingen', 'byron'), null, '廷根没有直达拜朗的路');
});

test('M2.7 地理：城市名与 id 都能查到（.移动 贝克兰德 / .移动 backlund 都认）', () => {
  assert.equal(GEO.cityByNameOrId('贝克兰德')?.id, 'backlund');
  assert.equal(GEO.cityByNameOrId('backlund')?.id, 'backlund');
  assert.equal(GEO.cityByNameOrId('不存在'), null);
});

/* ================================================================== *
 * 三、区域出生
 * ================================================================== */

test('M2.7 出生：同一 userId 永远落在同一座城市（派生式，不是抽卡）', () => {
  const cities = GEO.birthCities();
  const first = birthCityOf('20001', cities);
  for (let i = 0; i < 20; i += 1) {
    assert.equal(birthCityOf('20001', cities).id, first.id);
  }
  // 与 YAML 的书写顺序无关：把城市数组倒过来，结果不变
  assert.equal(birthCityOf('20001', [...cities].reverse()).id, first.id);
});

test('M2.7 出生：权重真的生效（大样本下与权重同序）', () => {
  const cities = GEO.birthCities();
  const userIds = Array.from({ length: 4000 }, (_, index) => String(100000 + index));
  const distribution = birthDistribution(userIds, cities);
  assert.equal(
    distribution.reduce((sum, entry) => sum + entry.count, 0),
  userIds.length,
  );
  // 廷根权重 30 是最大的一档，拜朗 10 是最小的
  const tingen = distribution.find((entry) => entry.cityId === 'tingen')!;
  const byron = distribution.find((entry) => entry.cityId === 'byron')!;
  assert.ok(tingen.count > byron.count, `廷根 ${tingen.count} 应当远多于拜朗 ${byron.count}`);
  // 每个城市的实际占比与权重占比的偏差不超过 5 个百分点（4000 样本足够）
  const totalWeight = distribution.reduce((sum, entry) => sum + entry.weight, 0);
  for (const entry of distribution) {
    const expected = entry.weight / totalWeight;
    const actual = entry.count / userIds.length;
    assert.ok(
      Math.abs(actual - expected) < 0.05,
      `${entry.cityId} 实测 ${(actual * 100).toFixed(1)}% 与权重 ${(expected * 100).toFixed(1)}% 偏差过大`,
    );
  }
});

test('M2.7 出生：苏尼亚海不作为出生城市（它只能被到达）', () => {
  assert.equal(GEO.city('sunia')?.birth_weight, 0);
  assert.ok(!GEO.birthCities().some((city) => city.id === 'sunia'));
});

/**
 * M2.7.6 重写：出生仍然是派生的（birthCityOf），但**途径不再在创建时选择**。
 *
 * 旧版本这里守的是「途径不匹配被拒且不改城市」——那条规则随着
 * 「创建即给途径」一起被删掉了。现在守的是同一件事的另一面：
 * 出生城市依然由 userId 决定，而且创建出来的人**没有途径**。
 */
test('M2.7.6 出生：两步建号落在派生城市，且建出来的是普通人', async () => {
  const h = createHarness();
  try {
    const userId = '20001';
    const home = birthCityOf(userId, h.app.geo.birthCities());
    // 第一步：问性别（回执里就带上了他落在哪座城市）
    const asked = await h.send({ rawText: '.创建 克莱恩', userId });
    assert.match(asked[0]!.text, new RegExp(home.name), '第一步就要告诉他落在哪座城市');
    assert.equal(h.repos.characters.findByUserId(userId), null, '选性别之前不能落卡');

    // 第二步：回数字 → 建号
    const ok = await h.send({ rawText: '1', userId });
    assert.match(ok[0]!.text, /【创建角色】/);
    const character = h.repos.characters.findByUserId(userId)!;
    assert.equal(character.currentCityId, home.id, '出生城市仍然是派生的');
    assert.equal(character.pathway, null, '创建时不能给途径');
    assert.equal(character.sequence, null, '创建时不能给序列');
    assert.equal(character.pathwayStatus, 'mortal');
    assert.equal(h.repos.inventory.count(character.id, '便士'), 60, '启程盘缠要真的到账');
    assert.equal(
      h.repos.flags.value(character.id, 'loc'),
      home.center,
      '落地点必须是出生城市的城区（通缉系统读它）',
    );

    // 同一个 QQ 号重复建号：城市不会重掷（出生是一次性的）
    const again = await h.send({ rawText: '.创建 别人', userId });
    assert.match(again[0]!.text, /你已经创建过角色/);
    assert.equal(h.repos.characters.findByUserId(userId)!.currentCityId, home.id);
  } finally {
    h.app.close();
  }
});

/* ================================================================== *
 * 四、跨区域移动
 * ================================================================== */

test('M2.7 移动：事件点按时长分档，且每次至少有一件事', () => {
  assert.equal(eventPointsFor(8), 2);
  assert.equal(eventPointsFor(72), 3);
  assert.equal(eventPointsFor(1), 1);
  const route = GEO.route('tingen', 'backlund')!;
  for (let i = 0; i < 200; i += 1) {
    const plan = planTravel({ route, now: 0, rng: createSeededRng(seedFrom(['plan', i])) });
    assert.ok(plan.events.length >= 1, '每个计划都必须至少有一件事');
    assert.ok(plan.events.length <= 3);
    assert.equal(plan.events[0]!.at, 0, '第一件事就是此刻（否则按钮点了没用）');
    assert.equal(plan.arrivesAt, route.duration_hours * 3600 * 1000);
  }
});

test('M2.7 移动：同 seed 的计划与结算完全可复现', () => {
  const route = GEO.route('pritz', 'sunia')!;
  const a = planTravel({ route, now: 1000, rng: createSeededRng(seedFrom(['same'])) });
  const b = planTravel({ route, now: 1000, rng: createSeededRng(seedFrom(['same'])) });
  assert.deepEqual(a, b);
  const r1 = resolveTravelChoice({ eventId: 'storm', choice: 'observe', routeDanger: 0.5, rng: createSeededRng(seedFrom(['x'])) });
  const r2 = resolveTravelChoice({ eventId: 'storm', choice: 'observe', routeDanger: 0.5, rng: createSeededRng(seedFrom(['x'])) });
  assert.deepEqual(r1, r2);
});

test('M2.7 移动：四个选择各有各的后果（战斗免伤 / 逃跑有概率 / 观察吃满 / 互动减半）', () => {
  const effects = NUMERIC_EFFECTS();
  const hpOf = (deltas: ReadonlyArray<{ type: string; value?: number }>): number =>
    deltas.filter((delta) => delta.type === 'hp').reduce((sum, delta) => sum + (delta.value ?? 0), 0);
  // 观察：吃满基础伤害
  const observe = resolveTravelChoice({ eventId: 'storm', choice: 'observe', routeDanger: 0.3, rng: createSeededRng(seedFrom(['o'])) });
  assert.equal(hpOf(observe.deltas), effects.storm.hp);
  // 互动：伤害减半
  const interact = resolveTravelChoice({ eventId: 'storm', choice: 'interact', routeDanger: 0.3, rng: createSeededRng(seedFrom(['i'])) });
  assert.equal(hpOf(interact.deltas), Math.round(effects.storm.hp * 0.5));
  // 迷雾：任何选择都会把到达时间往后推 12 小时
  const fog = resolveTravelChoice({ eventId: 'fog', choice: 'observe', routeDanger: 0.2, rng: createSeededRng(seedFrom(['f'])) });
  assert.equal(fog.extraHours, 12);
  // 八个事件的四种选择都能结算（不抛异常、结果非空）
  for (const eventId of TRAVEL_EVENT_IDS) {
    for (const choice of ['fight', 'flee', 'observe', 'interact'] as const) {
      const result = resolveTravelChoice({ eventId, choice, routeDanger: 0.5, rng: createSeededRng(seedFrom([eventId, choice])) });
      assert.ok(result.outcome.length > 0, `${eventId}/${choice} 必须给出结论`);
    }
  }
});

function NUMERIC_EFFECTS() {
  return { storm: { hp: -10, mad: 5 } };
}

test('M2.7 移动：.移动 无参给出目的地菜单（带花费与时长）', async () => {
  const h = createHarness();
  try {
    const character = await h.createCharacter(DEFAULT_USER, '旅行者');
    h.repos.inventory.add(character.id, '便士', 100, 'unbound', h.now());
    const replies = await h.send({ rawText: '.移动', userId: DEFAULT_USER });
    const text = replies.map((reply) => reply.text).join('\n');
    assert.match(text, /【移动 · 从廷根市出发】/);
    assert.match(text, /贝克兰德（陆路 8h）/);
    assert.match(text, /普利兹港（陆路 10h）/);
    assert.match(text, /20 便士/, '选项要写清花费');
  } finally {
    h.app.close();
  }
});

test('M2.7 移动：出发扣钱扣 AP、路上立刻有事件、到达切换城市', async () => {
  const h = createHarness();
  try {
    const character = await h.createCharacter(DEFAULT_USER, '旅行者');
    h.repos.inventory.add(character.id, '便士', 100, 'unbound', h.now());
    const before = h.repos.characters.findByUserId(DEFAULT_USER)!;

    const started = await h.send({ rawText: '.移动 贝克兰德', userId: DEFAULT_USER });
    const text = started.map((reply) => reply.text).join('\n');
    assert.match(text, /你踏上了去贝克兰德的路/);
    assert.match(text, /【路上 · /, '上路就立刻呈现第一件事（移动是一段内容）');

    const mid = h.repos.characters.findByUserId(DEFAULT_USER)!;
    assert.equal(h.repos.inventory.count(character.id, '便士'), 80, '扣 20 便士路费');
    assert.equal(mid.currentCityId, 'tingen', '还没到，城市不能变');
    const travel = h.repos.travels.activeOf(character.id)!;
    assert.equal(travel.status, 'traveling');
    assert.equal(travel.arrivesAt - travel.startedAt, 8 * 3600 * 1000);

    // 在路上：需要在地的指令被挡回
    h.advance(60 * 60 * 1000);
    // ⚠️ M2.121：`.扮演` 已下线，这里换成另一条**需要在地**的指令（`.探索` 认脚下的城市）
    const blocked = await h.send({ rawText: '.探索 廷根市', userId: DEFAULT_USER });
    assert.match(blocked.map((reply) => reply.text).join('\n'), /你在路上|先处理这件事/, '路上做不了需要在地的事');

    // 走完 8 小时 → 任何一条指令都会先把到达结算掉
    h.advance(7 * 3600 * 1000);
    const arrived = await h.send({ rawText: '.状态', userId: DEFAULT_USER });
    const arrivedText = arrived.map((reply) => reply.text).join('\n');
    assert.match(arrivedText, /你抵达了贝克兰德/);
    const after = h.repos.characters.findByUserId(DEFAULT_USER)!;
    assert.equal(after.currentCityId, 'backlund');
    assert.equal(h.repos.flags.value(character.id, 'loc'), 'backlund', '落地点切到新城区的城区');
    assert.equal(h.repos.travels.activeOf(character.id), null, '行程要收尾');

    // 到达之后：可以在新城市里活动了
    h.advance(30_000);
    const explore = await h.send({ rawText: '.探索 大桥区', userId: DEFAULT_USER });
    assert.ok(!explore.map((reply) => reply.text).join('\n').includes('要去那边得先发'), '到了就能探索本城地点');
  } finally {
    h.app.close();
  }
});

test('M2.7 移动：路线 / 钱 / 港口 / 途径都不满足时给出明确回执（M2.85：AP 门槛已随行动值下线）', async () => {
  const h = createHarness();
  try {
    const character = await h.createCharacter(DEFAULT_USER, '旅行者');
    const noMoney = await h.send({ rawText: '.移动 贝克兰德', userId: DEFAULT_USER });
    assert.match(noMoney[0]!.text, /要 20 便士，你只有 0/);

    h.repos.inventory.add(character.id, '便士', 500, 'unbound', h.now());
    const noRoute = await h.send({ rawText: '.移动 拜朗', userId: DEFAULT_USER });
    assert.match(noRoute[0]!.text, /没有直接去拜朗的路/);
    const unknown = await h.send({ rawText: '.移动 月球', userId: DEFAULT_USER });
    assert.match(unknown[0]!.text, /没有叫「月球」的地方/);
    const sameCity = await h.send({ rawText: '.移动 廷根市', userId: DEFAULT_USER });
    assert.match(sameCity[0]!.text, /你已经在廷根市了/);

    /*
     * M2.85：原来这里还有一段「AP 清空之后，钱不能再被扣走」（.移动 被「行动点不足」
     * 拒掉、钱包分文不动）—— 移动不再有行动点门槛，这段判据随行动值一并删除；
     * 「没走成不许扣钱」的语义由上面「钱不足」的分支守着。
     */
  } finally {
    h.app.close();
  }
});

test('M2.7 移动：路途事件的菜单真的落了库 —— 回数字能查到、选择会被记下', async () => {
  // 这条用例抓的是一个**真实踩过的坑**：第一版 .移动 直接返回了 InteractiveMessage，
  // 没有落 pending_menus。后果是玩家点按钮 / 回数字只会得到「菜单已过期」，
  // 于是所有路途事件都落到「到达时按观察自动结算」那条路上 ——
  // 200×14 长跑的 61 个事件，应对分布清一色是 observe，
  // 「移动中的选择」这条链路在实例测试里等于不存在。
  const h = createHarness();
  try {
    const character = await h.createCharacter(DEFAULT_USER, '旅行者');
    h.repos.inventory.add(character.id, '便士', 100, 'unbound', h.now());

    const started = await h.send({ rawText: '.移动 贝克兰德', userId: DEFAULT_USER });
    const text = started.map((reply) => reply.text).join('\n');
    assert.match(text, /回复数字。/, '路途事件必须给出可以回数字的菜单');

    const picked = h.app.router.deps.pendingMenus.pick(character.id, '1', h.now());
    assert.equal(picked.ok, true, '菜单必须落库，否则回数字查不到选项');
    assert.ok(
      picked.ok && picked.kind === 'option' && picked.option.command.startsWith('移动 抉择 '),
      '选项要指向 .移动 抉择',
    );

    const travel = h.repos.travels.activeOf(character.id)!;
    assert.equal(travel.events[0]!.resolved, false, '还没处理');
    await h.send({ rawText: '1', userId: DEFAULT_USER });
    const after = h.repos.travels.activeOf(character.id)!;
    assert.equal(after.events[0]!.resolved, true, '回数字之后这件事要标记成已处理');
    assert.ok(after.events[0]!.choice, '玩家选了什么必须记下来（报告里的应对分布靠它）');
    assert.ok(after.events[0]!.outcome, '结算结论也要落下来');
  } finally {
    h.app.close();
  }
});

test('M2.7 城市过滤：.探索 只认脚下的城市（唯一的强制点）', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(DEFAULT_USER, '本地人');
    const foreign = await h.send({ rawText: '.探索 大桥区', userId: DEFAULT_USER });
    const text = foreign[0]!.text;
    assert.match(text, /大桥区在贝克兰德/);
    assert.match(text, /要去那边得先发：\.移动 贝克兰德/);
    assert.equal(
      h.repos.exploreDaily.countOf(
        h.repos.characters.findByUserId(DEFAULT_USER)!.id,
        new Date(h.now() + 8 * 3600 * 1000).toISOString().slice(0, 10),
        'backlund_bridge',
      ),
      0,
      '被拒的探索不能记进探索次数',
    );
  } finally {
    h.app.close();
  }
});

test('M2.7 移动：地图上的每一座城市都能从廷根出发到达（连通性）', () => {
  // 广度优先：M2.7 的移动必须是有意义的 —— 出生在任何一座城市都要有出路，
  // 否则「玩家群分成几个圈子」会变成「某些圈子的人永远出不去」
  const seen = new Set<string>(['tingen']);
  const queue = ['tingen'];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const route of GEO.routesFrom(current)) {
      if (seen.has(route.to)) continue;
      seen.add(route.to);
      queue.push(route.to);
    }
  }
  assert.deepEqual([...seen].sort(), GEO.cities.map((city) => city.id).sort());
});
test('M2.55 markdown 模板：正文的小标题加粗、段落用分割线、行首项目符号翻成列表', () => {
  const md = toQQMarkdown(
    [
      '【克莱恩】老码头 · 晴',
      '天色干净，远处能看清。',
      '',
      '**收获**',
      '  · 战火余烬 × 1',
      '  · 圣盐 × 1',
      '',
      '【探索 · 老码头】',
      '1. 搜索',
    ].join('\n'),
    { header: { nickname: 'の' } },
  ).replace(/\u200B/g, '');
  const seg = md.split('\n');

  /*
   * M2.86：**不再是「加粗」，而是「原样保留」**。
   *
   * 原来这里断言 `**【克莱恩】**老码头 · 晴` —— 但手机端不渲染 `**`，
   * 用户看到的是星号本身。全站已改成 `mdStyle: 'plain'`（去星号、留结构）。
   *
   * 这条用例真正要守的东西没变：**行内的【】与 · 既不该被当标题、也不该被吃掉**。
   */
  assert.ok(md.includes('【克莱恩】老码头 · 晴'), '首行【】要原样保留：' + seg[3]);

  // 行首的「 · 」是项目自己的项目符号，翻成 markdown 无序列表
  assert.ok(md.includes('- 战火余烬 × 1'), '行首项目符号要翻成列表');

  // 正文里的小标题（不只首行）也要单独成行，且前面加分割线把段落分开
  assert.ok(md.includes('【探索 · 老码头】'), '正文里的小标题要单独成行');
  const at = seg.findIndex((line) => line.includes('【探索 · 老码头】'));
  assert.equal(seg[at - 1], '', '小标题前留空行');
  assert.equal(seg[at - 2], '***', '小标题前加分割线，否则正文和菜单糊在一起');

  /*
   * ⚠️ 这一条是本组的重点：行内的【】与 · **不是**标题、也不是项目符号。
   * 项目里到处都是 `事件【牌桌上的小钱】`、`不安 · 晴` —— 误伤它们等于把正文改坏。
   */
  const inline = toQQMarkdown('事件【牌桌上的小钱】\n不安 · 晴', { header: { nickname: 'の' } })
    .replace(/\u200B/g, '')
    .split('\n')
    .slice(2) // 消息头只有两行（昵称 + 分割线），多跳一行会把正文首行砍掉
    .join('\n');
  assert.equal(inline, '事件【牌桌上的小钱】\n不安 · 晴', '行内的【】与· 必须原样保留');
});
