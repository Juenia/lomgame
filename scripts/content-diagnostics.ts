#! /usr/bin/env node
/**
 * M2.26 任务 1.7：内容层诊断（0 批，开跑前看）。
 *
 * 为什么要有它（两次白跑换来的）：perfect 的「期望样本数只有 4%」这件事本轮是事后算出来的，
 * 事前不可见 —— 于是小批跑出 perfect = 0 人时第一反应是「断链」。
 * 这个脚本把它提前：开跑前打印每条途径的可入城市数 / 期望出生占比 / 期望人数，
 * 以及每个配方主材料的产出点是否满足「传承城市 x min_seq >= 配方 seq」。
 *
 * 用法：node scripts/content-diagnostics.ts [--players 50]
 * 退出码：loadContent() 有 error 时非零退出（K17 的处置：跑批前先跑它）。
 */
import { loadContent, loadChurches, loadCities, loadCreatures, loadFactions, loadLocations, loadRecipes, loadRegions } from '../src/data/loader.ts';
import { NUMERIC } from '../src/config/numeric.ts';
import { BATCH_TIERS, STANDARD_TIER, batchCommandOf } from '../src/config/batch-tiers.ts';
import { CONTENT_MAX_SEQUENCE, CONTENT_TARGET_SEQ } from '../src/config/content-scope.ts';
import { checkLinks } from '../src/data/link-check.ts';
import { OPEN_PATHWAYS } from '../src/domain/character/rules.ts';
// M2.35：口径搬到 src/data/birth-share.ts（链路检查器也要用同一份），这里直接引新位置
import { birthShares, cityWeightOf, pad } from '../src/data/birth-share.ts';

const argv = process.argv.slice(2);
const at = argv.indexOf('--players');
const PLAYERS = at >= 0 ? Number(argv[at + 1] ?? '50') : 50;

const content = loadContent();
const errors = content.issues.filter((i) => i.level === 'error');
const warns = content.issues.filter((i) => i.level === 'warn').length;

console.log('=== §0 内容校验（K17：跑批前先看这一节）===');
console.log('  error ' + errors.length + ' 条　warn ' + warns + ' 条');
for (const issue of errors.slice(0, 8)) {
  console.log('    x ' + String(issue.message).slice(0, 170));
}
if (errors.length > 0) {
  console.log('');
  console.log('  !! 有 error 就不要开跑 —— 服务端会起不来，而跑批命令行只会报「服务未就绪」（K17）');
  process.exitCode = 1;
}

const cities = loadCities().cities;
const churches = loadChurches().churches;
const locations = loadLocations().locations;
const recipes = loadRecipes().recipes;

/*
 * 期望出生占比的**口径只有一份**（scripts/birth-share-lib.ts），本脚本与
 * m226-small-read.ts 共用 —— 此前两边各算一遍，而小批那边漏了城市份额。
 */
const churchOf = (pathway: string): string | null => {
  for (const church of churches) if (church.pathway === pathway) return church.id;
  return null;
};
const shares = birthShares({
  cities,
  pathways: OPEN_PATHWAYS,
  factions: loadFactions().factions,
  priorityWeight: NUMERIC.initiation.factionPriority,
  // 期望人数按两档给：小批（--players，默认 50）与大规模（200）
  expectAt: [PLAYERS, 200],
  churchOf,
});
console.log('');
console.log('=== §1 途径 x 城市 x 势力（期望的**依据**，可复算）===');
console.log('  口径 share = Σ_城市 [ (城市权重 / 全部城市权重) x (本城传承它的势力权重和 / 本城全部势力权重和) ]');
console.log(
  '  势力权重 = NUMERIC.initiation.factionPriority：primary ' + NUMERIC.initiation.factionPriority.primary +
    ' / secondary ' + NUMERIC.initiation.factionPriority.secondary,
);
console.log(
  '  全部城市权重 = ' + shares[0]!.cityWeightTotal + '（' +
    cities.map((city) => city.id + ' ' + cityWeightOf(city)).join(' / ') + '）',
);
console.log('');
for (const row of shares) {
  const nums = row.expectedBy
    .map((e) => e.players + ' 人档 ' + e.expected.toFixed(1) + ' 人（P(0)=' + e.zeroProbability.toFixed(3) + '）')
    .join('　｜　');
  console.log('  ── ' + row.pathway + '　教会：' + (row.churchId ?? '无') + '　────────────────');
  console.log('     期望出生占比 ' + (row.share * 100).toFixed(2) + '%　　' + nums);
  console.log('     算式 ' + row.formula);
  if (row.sources.length === 0) {
    console.log('     ⚠️ **传承势力 0 家 ⇒ 期望恒为 0**（不是「低」）：这条途径在这批里一个玩家都不会有');
    console.log('        修法：cities.yaml 开了它，就得在本城 factions.yaml 里加一家传承它的势力（K16 第五实例）');
  }
  for (const source of row.sources) {
    console.log(
      '       ' + pad(source.cityId, 11) + '权重 ' + pad(String(source.cityWeight), 4) +
        '城市占比 ' + pad(source.cityShare.toFixed(2), 6) + '本城 ' + source.localFactionCount + ' 家(权重和 ' +
        source.localWeightSum.toFixed(2) + ')  ' + pad(source.factionId, 20) + pad(source.priority, 10) +
        '份额 ' + pad(source.factionShare.toFixed(3), 7) + '→ ' + source.contribution.toFixed(4),
    );
  }
  console.log('');
}
console.log('  · 旧口径（途径池 x 城市白名单）对照：' +
  shares.map((row) => row.pathway + ' ' + (row.legacyShare * 100).toFixed(1) + '%').join('、'));
console.log('  · 它把「期望 0」算成了 2-4%，正是前两批误判的来源 —— **不要再拿它下结论**');
console.log('  · 这是**期望**，不是「应该有多少人」：势力任务难度不同、材料掉落是概率的，个位数偏差正常');
console.log('  · 判据：**期望 = 0 ⇒ 结构性断链**（改内容表）；期望 > 0 而实测 0 ⇒ 先看 P(0) 再谈');

const cityOfLocation = new Map<string, string>();
for (const city of cities) {
  for (const loc of city.locations as readonly string[]) cityOfLocation.set(loc, city.id);
}

console.log('');
console.log('=== §2 配方主材料的产出点（K17 的那条校验）===');
let bad = 0;
for (const recipe of recipes) {
  const first = recipe.main[0];
  if (!first) continue;
  const seats = new Set<string>();
  for (const church of churches) {
    if (church.pathway !== recipe.pathway) continue;
    for (const seat of church.seats as readonly string[]) seats.add(seat);
  }
  const spots: string[] = [];
  let bestMinSeq = -1;
  let inCity = false;
  for (const location of locations) {
    for (const drop of location.loot ?? []) {
      if ((drop as { itemId?: string }).itemId !== first.itemId) continue;
      const cityId = cityOfLocation.get(location.id) ?? '?';
      // ⚠️ 字段名是 snake_case（zod schema 不做驼峰转换）—— 第一版写成 minSeq，全读到 undefined
      const minSeq = Number((location as { min_seq?: number }).min_seq ?? 0);
      spots.push(location.id + '(min_seq ' + minSeq + ')');
      if (minSeq > bestMinSeq) bestMinSeq = minSeq;
      if (seats.has(cityId)) inCity = true;
    }
  }
  /*
   * 「无教会」的途径（seer）**不是不满足** —— 它是 M2.15 拍板的设计边界
   * （愚者不入七正神教会），loader 的校验对它本来就跳过（所以 §0 是 0 error）。
   * 第一版把它算成「不满足」，自己制造了两条假红。
   */
  const noChurch = seats.size === 0;
  const ok = noChurch || (inCity && bestMinSeq >= recipe.seq);
  if (!ok) bad += 1;
  const verdict = noChurch ? 'N/A（无教会，设计边界）' : ok ? 'OK' : '!! 不满足';
  console.log(
    '  ' + recipe.id + '　seq=' + recipe.seq + '　' + first.itemId + '　' + verdict +
      '　（城市内的产出点 ' + (inCity ? '有' : '无') + '，最高 min_seq = ' + bestMinSeq + '）',
  );
  console.log('      产出点：' + (spots.slice(0, 4).join('、') || '(没有)') + (spots.length > 4 ? ' ……共 ' + spots.length + ' 个' : ''));
  console.log('      传承城市：' + ([...seats].join(',') || '(无教会 —— seer 是设计边界)'));
}
console.log('');
console.log('  判据（src/data/loader.ts）：产出点必须在传承城市里，且 min_seq >= 配方 seq');
console.log('  不满足 ' + bad + ' 条（N/A 的不算）—— 有的话上面 §0 会报 error（K17 的形状）');

/*
 * §3 是给**新途径落地**用的：选主材料落点之前，先看这座城市有哪些地点、
 * 它们的 min_seq 够不够（序列 9 配方要 >= 9，序列 8 配方要 >= 8）。
 * M2.26 第一批就是先选地点、再被校验打回来的。
 */
console.log('');
console.log('=== §3 城市 x 地点 x min_seq（选主材料落点时看这一节）===');
for (const city of cities) {
  const list: string[] = [];
  for (const loc of city.locations as readonly string[]) {
    for (const location of locations) {
      if (location.id !== loc) continue;
      const minSeq = Number((location as { min_seq?: number }).min_seq ?? 0);
      list.push(loc + '(' + minSeq + ')');
    }
  }
  console.log('  ' + city.id + '　pathways=[' + (city.pathways as readonly string[]).join(',') + ']');
  console.log('      ' + list.join('　'));
}

/* ================================================================== *
 * M2.35 任务 1：§4 链路检查
 *
 * 这一节与 §0 是**同一批 issues**（链路检查在 loadContent() 里被调用，
 * error 会让服务端起不来）。差别是 §0 只给计数与前 8 条，
 * 这里给**逐项剖面** —— 「哪条途径缺哪一层」「哪个配置没人读」「哪一档够不到哪一层」。
 * ================================================================== */
console.log('');
console.log('=== §4 链路检查（M2.35 任务 1：配方齐全 / 有读取点 / 跑批可达）===');

const linkReport = checkLinks({
  pathways: OPEN_PATHWAYS,
  recipes,
  cities,
  factions: loadFactions().factions,
  churches,
  creatures: loadCreatures().creatures,
  // M2.71 第 5 项：区域传承的途径 / 城市声明的势力
  regions: loadRegions().regions,
  geoCities: loadCities().cities,
});

console.log('');
console.log('  ① 每序列有配方（目标区间 ' + CONTENT_TARGET_SEQ + '—9 —— 出处 src/config/content-scope.ts）');
for (const row of linkReport.recipe.rows) {
  console.log(
    '     ' + pad(row.pathway, 11) + pad(row.have.join('/'), 14) +
      (row.missing.length === 0 ? 'OK' : '!! 缺 ' + row.missing.join('、')),
  );
}
console.log(
  '     不齐 ' + linkReport.recipe.issues.filter((issue) => issue.level === 'error').length +
    ' 条 —— 有的话 §0 会报 error（服务端起不来）。【形状】seq 7 缺 7 条（M2.32，靠人翻表才发现）',
);

console.log('');
console.log('  ② 生产读取点（清单出自 src/data/link-check.ts 的 REQUIRED_READERS，唯一出处 K22）');
for (const row of linkReport.reader.rows) {
  console.log('     ' + pad(row.label, 34) + (row.ok ? 'OK　' + row.readers.join('、') : '!! 没有任何生产读取点'));
}
console.log('     判据：**先剥注释与字符串再搜** —— 「只在注释里出现」不算读取点（M2.28 的现场形状）');

console.log('');
console.log('  ③ 跑批可达（**逐档**；判据只用标准对照轮 = ' + STANDARD_TIER.label + '）');
console.log('     口径 E(s) = 档位人数 x 该途径期望出生占比（§1 同一个函数） x ∏ planned[t]，t 从 8 降到 s');
console.log('     ⚠️ 这是**上界**：不含 DIG 门槛、材料与天数 ⇒ 报「够不到」是硬结论，报「够得到」不保证');
console.log('     内容可达 = 序列 ' + CONTENT_MAX_SEQUENCE + '（seq ' + CONTENT_TARGET_SEQ + ' 的配方做得出来）');
console.log('');
for (const reach of linkReport.reach) {
  const star = reach.tier.id === STANDARD_TIER.id ? '　★标准对照轮' : '';
  console.log(
    '     ' + pad(reach.tier.label, 8) + pad(reach.tier.players + ' 人 x ' + reach.tier.days + ' 天', 18) + star,
  );
  console.log('        ' + reach.rows.map((row) => row.pathway + '→' + row.reachSequence).join('　'));
  /*
   * 命令**从档位定义生成**（`src/config/batch-tiers.ts`），不在这里手抄一份 ——
   * 手抄的副本会在改档位时静默漂掉（K22），而手册里给的正是这几条。
   */
  for (const line of batchCommandOf({ tier: reach.tier, seed: '<seed>' }).split(String.fromCharCode(10))) {
    console.log('        $ ' + line);
  }
}
console.log('');
for (const issue of linkReport.issues) {
  console.log('     ' + (issue.level === 'error' ? 'x ' : '! ') + String(issue.message).slice(0, 210));
}
console.log('');
console.log('  · 判据与清单的唯一出处：src/data/link-check.ts（K22）；档位：src/config/batch-tiers.ts');
console.log('  · 够不到的那几层 ⇒ 按 docs/对照规范.md §四·补二 用判定层直调 + 零夹具生产链路用例验，');
console.log('    **不要**为了让它出现在跑批里而去调门槛或改窗口（那是拿测量方法迁就内容）');
