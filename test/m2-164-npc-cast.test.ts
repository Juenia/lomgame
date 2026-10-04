/**
 * M2.164：**世界人物名册**（用户拍板「大量 NPC，按类型铺开：教会 / 官方 / 地下 / 学者 / 普通人…」）。
 *
 * 这一条守四件事：
 *   ① 名册真的铺开了 —— 数量与身份覆盖**写死**（内容一变就红，提醒人去看一眼）
 *   ② 名册进了 deps，而且**名字解析认两张表**（轨道 + 居民）
 *   ③ 引用校验不是装饰 —— 五个坏值都必须被拦下（判据自检）
 *   ④ 真实内容零 error（防线钉在真实加载路径上，不是只在测试里成立）
 *
 * 为什么第 ③ 条单独写：这一轮加的四个校验全都是「错了也不报错」的那一类 ——
 * 人在一座到不了的城市里、势力 id 拼错、id 与轨道撞车……判定层只会永远匹配不上。
 * 抓不住故障的判据是装饰，所以这里**故意喂坏数据**。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { NPC_KINDS, NPC_KIND_LABELS, NpcCastFileSchema, type NpcCast } from '../src/domain/world/npc-cast.ts';
import { loadContent, checkNpcCastRefs } from '../src/data/loader.ts';
import { createHarness } from './helpers/app.ts';

process.env.TEMP = process.env.TEMP ?? 'data/tmp';

const FILE = new URL('../src/data/npc-cast.yaml', import.meta.url);
function loadCast(): { cast: NpcCast[]; meta: Record<string, unknown> } {
  const raw = parse(readFileSync(FILE, 'utf8')) as { meta?: Record<string, unknown> };
  const parsed = NpcCastFileSchema.safeParse(raw);
  assert.ok(parsed.success, '名册 schema 不过：' + JSON.stringify(parsed.error?.issues?.slice(0, 3)));
  return { cast: parsed.data.npc_cast, meta: raw.meta ?? {} };
}

test('M2.164 名册：120 位居民，身份按类型铺开、城市覆盖过半', () => {
  const { cast, meta } = loadCast();
  // 数量：**写死**（AGENTS §3.5）—— 它就是提醒「内容变了，去看一眼」
  assert.equal(cast.length, 124, '名册条数变了：meta.count 与这条断言都要跟着改');
  assert.equal(meta['count'], 124, 'meta.count 与实际条数不一致');
  // 身份：清单从 NPC_KINDS 派生（不手抄），每一类都要有人
  const counts = new Map<string, number>(NPC_KINDS.map((k) => [k, 0]));
  for (const npc of cast) counts.set(npc.kind, (counts.get(npc.kind) ?? 0) + 1);
  for (const kind of NPC_KINDS) {
    assert.ok((counts.get(kind) ?? 0) > 0, '身份「' + NPC_KIND_LABELS[kind] + '」一个人都没有 —— 要求是按类型铺开');
  }
  // id 唯一
  assert.equal(new Set(cast.map((n) => n.id)).size, cast.length, '名册里有重复 id');
  // 城市覆盖：29 座城不该只有廷根有人
  assert.ok(new Set(cast.map((n) => n.city)).size >= 20, '名册覆盖的城市太少');
});

test('M2.164 加载：名册进了 deps，名字解析同时认轨道与居民', () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    assert.equal(deps.npcCast.length, 124, '名册没进 deps（或条数变了）');
    assert.equal(
      deps.npcRoster.size,
      deps.npcCast.length + deps.npcTracks.length,
      '名册应当同时含轨道与居民 —— 少一半就意味着有人读不到名字',
    );
    // 轨道里的人（原作）与名册里的人（居民）都要查得到中文名
    assert.equal(deps.npcRoster.nameOf('klein_moretti'), '克莱恩·莫雷蒂');
    const resident = deps.npcCast[0]!;
    assert.equal(deps.npcRoster.nameOf(resident.id), resident.name);
    assert.notEqual(deps.npcRoster.nameOf(resident.id), resident.id, '居民名字解析退化成 id 了');
    // 查不到时返回 id（既有兜底口径），不抛
    assert.equal(deps.npcRoster.nameOf('nobody_at_all'), 'nobody_at_all');
    // 场景渲染的入口：这座城里有人
    assert.ok(deps.npcRoster.inCity('tingen').length >= 8, '廷根街上没人');
  } finally {
    h.app.close();
  }
});

test('M2.164 校验：五个坏值都要被拦下（判据自检，不许是装饰）', () => {
  const { cast } = loadCast();
  const base = cast[0]!;
  const ids = {
    cities: new Map<string, readonly string[]>([['tingen', ['mist_street']], ['backlund', ['backlund_bridge']]]),
    locations: new Set(['mist_street', 'backlund_bridge']),
    factions: new Set(['church_tingen']),
    organizations: new Set(['police_system']),
    churches: new Set(['night_goddess']),
    pathways: new Set(['seer']),
    tracks: new Set(['klein_moretti']),
  };
  const bad: NpcCast[] = [
    { ...base, location: 'backlund_bridge' },   // ③ 别城的地点（人在一个到不了的地方）
    { ...base, city: 'atlantis' },              // ② 城市不存在
    { ...base, faction: 'no_such_faction' },    // ④ 势力不存在
    { ...base, church: 'no_such_church' },      // ④ 教会不存在
    { ...base, id: 'klein_moretti' },           // ① 与 npc-tracks 撞 id
  ];
  const issues = checkNpcCastRefs(bad, ids).filter((i) => i.level === 'error');
  const text = issues.map((i) => i.message).join(' / ');
  assert.equal(issues.length, 5, '五个坏值应当各产生一条 error，实际是：' + text);
  assert.ok(text.includes('不属于'), '别城地点没被拦下：' + text);
  assert.ok(text.includes('撞了 id'), 'id 撞车没被拦下：' + text);
  // 正例：真实那一条在这里必须是干净的（否则判据本身太松或太紧）
  assert.deepEqual(checkNpcCastRefs([base], ids), []);
});

test('M2.164 真实内容：整份名册在真实加载路径上零 error', () => {
  const bundle = loadContent();
  const errors = bundle.issues.filter((i) => i.level === 'error');
  assert.deepEqual(errors.map((e) => e.message), [], '真实内容里有 error —— 名册的引用校验没通过');
  assert.equal(bundle.npcCast.length, 124);
});
