import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorldRepo } from '../src/infra/db/world.ts';
import { weatherLabel, WEATHER_IDS } from '../src/domain/world/weather.ts';
import { createHarness, GROUP_ID } from './helpers/app.ts';

async function worldContext() {
  const h = createHarness();
  await h.createCharacter('40001', '看天的');
  h.adapter.take();
  return h;
}

test('.世界 <地点>：带原作地点档案（类型 / 神祇 / 角色 / 事迹）', async () => {
  const h = await worldContext();
  try {
    const sent = await h.send({ rawText: '.世界 圣赛缪尔教堂', userId: '40001' });
    const text = sent.map((m) => m.text).join('\n');
    assert.match(text, /【圣赛缪尔教堂】/);
    assert.match(text, /类型：教堂 \/ 圣所/);
    assert.match(text, /神祇：黑夜女神/);
    assert.match(text, /角色：/);
    assert.match(text, /在这里发生过：/);
  } finally {
    h.app.close();
  }
});

test('.世界 区域：带原作国家档案（政体 / 首都 / 语言 / 国教 / 皇室途径 / 传承途径）', async () => {
  const h = await worldContext();
  try {
    const sent = await h.send({ rawText: '.世界 区域 弗萨克帝国', userId: '40001' });
    const text = sent.map((m) => m.text).join('\n');
    assert.match(text, /【弗萨克帝国】/);
    assert.match(text, /首都：圣密隆/);
    assert.match(text, /国教：战神/);
    assert.match(text, /皇室途径：/);
    assert.match(text, /传承途径：/);
    assert.match(text, /所辖城市：/);
  } finally {
    h.app.close();
  }
});

test('.世界 区域：查不到的区域要说清可用列表（不静默）', async () => {
  const h = await worldContext();
  try {
    const sent = await h.send({ rawText: '.世界 区域 不存在的地方', userId: '40001' });
    const text = sent.map((m) => m.text).join('\n');
    assert.match(text, /没有这个区域：不存在的地方/);
    assert.match(text, /鲁恩王国/);
  } finally {
    h.app.close();
  }
});

test('.世界 城市：带原作档案（国家 / 类型 / 人口 / 特征 / 城区 / 地标）', async () => {
  const h = await worldContext();
  try {
    const sent = await h.send({ rawText: '.世界 城市 贝克兰德', userId: '40001' });
    const text = sent.map((m) => m.text).join('\n');
    assert.match(text, /【贝克兰德】/);
    assert.match(text, /所属：鲁恩王国 · 首都（现存）/);
    assert.match(text, /人口：超过五百万/);
    assert.match(text, /别名 \/ 旧称：/);
    assert.match(text, /城区：/);
    assert.match(text, /皇后区/);
    assert.match(text, /地标：/);
  } finally {
    h.app.close();
  }
});

test('.世界 城市：别名也能查到（尘埃之都 → 贝克兰德）', async () => {
  const h = await worldContext();
  try {
    const sent = await h.send({ rawText: '.世界 城市 尘埃之都', userId: '40001' });
    const text = sent.map((m) => m.text).join('\n');
    assert.match(text, /尘埃之都/, '别名要出现在档案里');
    assert.match(text, /【贝克兰德】/);
  } finally {
    h.app.close();
  }
});

test('.世界：群聊与私聊同一条路 —— 完整明细与菜单直接发在群里', async () => {
  const h = await worldContext();
  try {
    const sent = await h.send({ rawText: '.世界', userId: '40001', scene: 'group', groupId: GROUP_ID });
    // 群聊与私聊已合并成同一条路：一条完整回执，不再摘要 + 私聊明细两条
    assert.equal(sent.length, 1, '群聊只回一条（完整内容），不再额外发私聊明细');
    const group = sent[0]!;
    assert.equal(group.scene, 'group', '回执发回群里');

    assert.match(group.text, /【世界】/);
    assert.match(group.text, /时段|·/);
    assert.match(group.text, /月相/);
    assert.match(group.text, /雾日/);

    /*
     * M2.54：文字**只列玩家所在城市**的地点 —— 全境那 58 处由随消息一起发出的
     * 世界地图承担（1691 字 / 65 行的列表换成了一张图）。
     * 所以这里按「本城地点」断言，并确认它确实比全境少（否则这条测试就白测了）。
     */
    const all = h.repos.locations.all();
    const character = h.repos.characters.findByUserId('40001')!;
    const cityIds = new Set(h.repos.cities.get(character.currentCityId!)?.locations ?? []);
    const expected = all.filter((location) => cityIds.has(location.id));
    assert.ok(expected.length > 0, '前提：这个角色所在城市要有地点');
    assert.ok(expected.length < all.length, '前提：本城地点应当少于全境，否则测不出过滤');
    for (const location of expected) {
      assert.ok(group.text.includes(location.name), `群聊回执缺少本城地点 ${location.name}`);
    }
    // 菜单必须跟着内容一起到玩家眼前，否则群里就没法回数字
    assert.ok(
      group.text.includes(`1. ${expected[0]!.name}`),
      `群聊菜单第一项必须是本城第一个地点：${group.text.split('\n').slice(0, 6).join(' / ')}`,
    );
    assert.match(group.text, /回复数字。/);
  } finally {
    h.app.close();
  }
});

test('.世界 地点：给详细天气 + 影响 + 预告；群聊只回一行', async () => {
  const h = await worldContext();
  try {
    const repo = new WorldRepo(h.app.db);
    const sent = await h.send({ rawText: '.世界 廷根市', userId: '40001', scene: 'group' });
    assert.equal(sent.length, 1, '群聊一条完整回执');
    const group = sent[0]!;
    assert.equal(group.scene, 'group');
    const priv = group; // 群聊与私聊同一份内容

    assert.match(priv.text, /【廷根市】/);
    assert.match(priv.text, /影响：/);
    assert.match(priv.text, /探索危险/);
    assert.match(priv.text, /掉落/);
    assert.match(priv.text, /调制成功率/);
    assert.match(priv.text, /失控概率/);
    assert.match(priv.text, /预告：/);
    assert.match(priv.text, /持续到/);

    // 详情里的天气就是库里那一行
    const weather = repo.weatherOf('tingen');
    assert.ok(priv.text.includes(weatherLabel(weather)), '详情里的天气必须与落库一致');

    assert.ok(group.text.includes('廷根市'));
  } finally {
    h.app.close();
  }
});

test('.世界：支持编号与数字回复（私聊里回 1 = 看第一个地点）', async () => {
  const h = await worldContext();
  try {
    const list = await h.send({ rawText: '.世界', userId: '40001' });
    const priv = list.find((message) => message.scene === 'private')!;
    /*
     * 菜单只列本城地点，但**编号沿用全局序号** —— 否则文字里的编号与
     * 「.世界 <编号>」的解析会对不上（那条解析走的是全境列表）。
     */
    const all = h.repos.locations.all();
    const character = h.repos.characters.findByUserId('40001')!;
    const cityIds = new Set(h.repos.cities.get(character.currentCityId!)?.locations ?? []);
    const expected = all.filter((location) => cityIds.has(location.id));
    assert.ok(expected.length > 0, '前提：这个角色所在城市要有地点');
    const first = expected[0]!;
    /*
     * 菜单的编号是**菜单自己的**（本城第 1、2、3…）—— 它只服务「回数字」这一条路，
     * 玩家回 1 就是本城第一个。用全局序号会让编号跳号（6、9、13…），没人会去回 6。
     * 文字列表因此**不显示编号**，免得与「.世界 编号」的全境语义混。
     */
    assert.ok(
      priv.text.includes('1. ' + first.name),
      '菜单第一项是本城第一个地点，编号从 1 起，实际：' + priv.text.split('\n').slice(0, 5).join(' / '),
    );

    // M2.3：私聊里直接回一个数字 → 走 pending_menus（不再是路由里的特判）
    const byNumber = await h.send({ rawText: '1', userId: '40001' });
    assert.ok(byNumber.length > 0, '私聊的数字回复必须被识别');
    assert.ok(byNumber[0]!.text.includes(`【${first.name}】`));

    // 显式编号写法仍然可用（完整指令一个都没删）
    h.advance(5000); // 跨过 .世界 的令牌桶冷却
    await h.send({ rawText: '.世界', userId: '40001' });
    h.advance(5000);
    const byIndex = await h.send({ rawText: '.世界 1', userId: '40001' });
    assert.ok(byIndex[0]!.text.includes(`【${first.name}】`));

    // 群聊里的裸数字：这个人**有待命菜单**时接住（与私聊同义）
    h.advance(5000);
    const groupList = await h.send({ rawText: '.世界', userId: '40001', scene: 'group' });
    assert.ok(groupList[0]!.text.includes(`1. ${first.name}`), '群聊也给带编号的菜单');
    const groupNumber = await h.send({ rawText: '1', userId: '40001', scene: 'group' });
    assert.equal(groupNumber.length, 1, '群聊里有待命菜单时，数字要被接住');
    assert.ok(groupNumber[0]!.text.includes(`【${first.name}】`));

    // 但**没有待命菜单的人**在群里打数字，一声不响
    const stranger = await h.send({ rawText: '1', userId: '40002', scene: 'group' });
    assert.equal(stranger.length, 0, '没在玩的人打"1"不该有任何响应');

    // 超出范围 / 不存在的地点：给出用法，不炸
    /*
     * ⚠️ M2.90：这里原来写死 99。地点表补到 155 个之后，第 99 个**真的存在**了
     * （冰封海域）—— 于是这一行测的不再是「超出范围」，而是在读一个正常地点，
     * 断言自然就红了。改成相对值：比总数还大 5，内容再怎么加都仍然超范围。
     */
    h.advance(5000);
    const tooBig = await h.send({ rawText: '.世界 ' + (all.length + 5), userId: '40001' });
    h.advance(5000);
    assert.match(tooBig[0]!.text, /没有这个地方/);
    assert.match(tooBig[0]!.text, /用法：/);
    const unknown = await h.send({ rawText: '.世界 月球背面', userId: '40001' });
    assert.match(unknown[0]!.text, /没有这个地方/);
  } finally {
    h.app.close();
  }
});

test('探索回执头部带天气氛围，且天气来自落库的那一行', async () => {
  const h = await worldContext();
  try {
    const repo = new WorldRepo(h.app.db);
    const weather = repo.weatherOf('tingen');
    const sent = await h.send({ rawText: '.探索 廷根市', userId: '40001' });
    /*
     * ⚠️ M2.90：这条断言原来盯着**首行**，而 M2.45 的回执分层之后首行是
     * 「【名字】地点（危险度）」，天气被挪到了第二行 —— 文本被移动过，
     * 而断言没跟着动，于是一直红着（红着的判据等于没有判据）。
     * 判据改成「头部两行里要有天气」；次数那一条也跟着当前文案走
     * （现在是「今日已探 N 次」，不再是「今日 1/3 次」）。
     */
    const head = sent[0]!.text.split('\n').slice(0, 2).join('\n');
    assert.ok(head.includes(weatherLabel(weather)), `头部要带天气：${head}`);
    assert.match(sent[0]!.text, /今日已探 1 次/);
  } finally {
    h.app.close();
  }
});

test('.世界：天气与影响随时间推进而变化（世界在跑，不是快照）', async () => {
  const h = await worldContext();
  try {
    const repo = new WorldRepo(h.app.db);
    const before = repo.weatherStates();
    // 往前走一天：中间跨过 4 次换天气窗口
    h.advance(24 * 60 * 60 * 1000);
    await h.send({ rawText: '.世界', userId: '40001' });
    const after = repo.weatherStates();

    assert.equal(after.length, before.length);
    // 至少有一个地点换了天气（6 小时一次，一天必然换过）
    assert.ok(
      after.some((state, index) => state.since !== before[index]!.since),
      '一天的推进里天气必须变过',
    );
    // 落库的天气必须都在八种之内
    for (const state of after) assert.ok(WEATHER_IDS.includes(state.weather));
    // 世界 tick 也被真的执行了（轻 tick 每小时一格）
    assert.ok(repo.countTicks('light') >= 24, `一天至少要结算 24 个轻 tick，实际 ${repo.countTicks('light')}`);
  } finally {
    h.app.close();
  }
});
test('世界切换：全部 / 城市 / 只发地图，且不抢走地点详情', async () => {
  const h = await worldContext();
  try {
    const all = h.repos.locations.all();

    // 全部：老玩家习惯的那份完整列表，一处不少
    const every = await h.send({ rawText: '.世界 全部', userId: '40001' });
    for (const location of all) {
      assert.ok(every[0]!.text.includes(location.name), '全境模式缺 ' + location.name);
    }

    // 城市：只列该城的地点
    const city = h.repos.cities.all().find((c) => c.locations.length > 0 && c.locations.length < all.length)!;
    h.advance(5000);
    const one = await h.send({ rawText: '.世界 城市 ' + city.name, userId: '40001' });
    assert.ok(one[0]!.text.includes(city.name), '城市模式要在标题里报出城市名');
    for (const id of city.locations) {
      const name = all.find((l) => l.id === id)?.name;
      if (name !== undefined) assert.ok(one[0]!.text.includes(name), '城市模式缺 ' + name);
    }
    const other = all.find((l) => !city.locations.includes(l.id))!;
    assert.ok(!one[0]!.text.includes(other.name), '城市模式不该出现别的城市的地点：' + other.name);

    /*
     * 名字冲突：「廷根市」既是城市 id、又是那座城里一个地点的名字。
     * 不带「城市」两个字时必须仍然是**地点详情** —— 城市不能靠猜优先级来抢。
     */
    h.advance(5000);
    const tingen = await h.send({ rawText: '.世界 廷根市', userId: '40001' });
    assert.ok(tingen[0]!.text.includes('【廷根市】'), '不带前缀时应当是地点详情，实际：' + tingen[0]!.text.slice(0, 60));

    // 不存在的城市：报错并列出可选项，而不是静默落到地点详情
    h.advance(5000);
    const nope = await h.send({ rawText: '.世界 城市 不存在的城', userId: '40001' });
    assert.ok(nope[0]!.text.includes('没有这座城市'), '要明确说没有这座城市');
    assert.ok(nope[0]!.text.includes(city.name), '要把可用的城市列出来');
  } finally {
    h.app.close();
  }
});
