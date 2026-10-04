/**
 * M2.26 任务 0（P0）：**途径池必须与 `OPEN_PATHWAYS` 同步**。
 *
 * 背景：`src/vplayer/profiles.ts` 的途径池曾经硬编码三条（`seer/warrior/sleepless`），
 * M2.19 实现 `sailor` 之后没有人回来加它 —— 结果是「**内容做了，行为层验不到**」：
 * vplayer 抽不到 sailor，一个 sailor 玩家只能靠材料恰好齐了偶然产生（实测 m224 只有 7 人）。
 *
 * 这三条用例各守一件事：
 *   1. **池子 == OPEN_PATHWAYS**（形状守卫，加新途径时自动跟上）；
 *   2. **等权**（改权重就必须同时改这条断言，不能悄悄变成有偏）；
 *   3. **同 seed 可复现**（铁律 3，改池子不能破坏它）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { OPEN_PATHWAYS } from '../src/domain/character/rules.ts';
import { loadCities, loadFactions } from '../src/data/loader.ts';
import { buildProfiles } from '../src/vplayer/profiles.ts';

const tallyOf = (players: number, seed: string): Map<string, number> => {
  const profiles = buildProfiles({ players, seed });
  const tally = new Map<string, number>();
  for (const profile of profiles) tally.set(profile.pathway, (tally.get(profile.pathway) ?? 0) + 1);
  return tally;
};

test('M2.26 任务 0：途径池覆盖 OPEN_PATHWAYS 的每一条（sailor 曾经漏在外面）', () => {
  const tally = tallyOf(400, 'm226-pool');
  for (const pathway of OPEN_PATHWAYS) {
    assert.ok(
      (tally.get(pathway) ?? 0) > 0,
      '途径池里抽不到 ' + pathway + ' —— 它已在 OPEN_PATHWAYS 里，说明池子又和权威清单脱钩了',
    );
  }
  for (const key of tally.keys()) {
    assert.ok(
      (OPEN_PATHWAYS as readonly string[]).includes(key),
      '途径池里出现了未实现的途径 ' + key + '（池子只能放 OPEN_PATHWAYS 里的）',
    );
  }
});

test('M2.26 任务 0：途径等权（判据按 3σ 给，并配一个「偏了就必须红」的对照）', () => {
  /*
   * ## 判据口径改过一次，理由必须留在这里（M2.26 第二批）
   *
   * 原来写的是**固定百分比**：`|n - expected| / expected < 0.25`。
   * 池子从 5 条变 6 条之后，这个百分比**含义变了**：
   *
   *   | 池子 | 期望/条 | 二项 σ | 25% 相当于 |
   *   | 5 条 | 80.0    | 8.00   | 2.50σ      |
   *   | 6 条 | 66.7    | 7.45   | **2.24σ**  |
   *
   * 实测（`m226-pool`，400 人）：`sleepless = 50`，
   * 偏差 `|50 - 66.67| / 66.67 = 25.00%` —— **恰好擦在边上**。
   * 这不是「池子偏了」（另外五条是 67/69/70/70/74，全在 ±1σ 内），
   * 而是**判据的松紧随池子大小漂**：加一条途径，同一个百分比变得更严。
   *
   * 这条判据的本意是「抓大偏差」（它当年要抓的是硬编码三条时
   * seer 43.5% / sailor 3.5% 那种形状），所以改成按 **σ** 给：
   * **3σ = 22.4 人**，与池子大小无关，鉴别力不再随参数漂。
   *
   * ⚠️ seed 是固定的 ⇒ 这个结果是**确定性的**（要么恒过要么恒红），不是 flaky。
   * ⚠️ 这不是「为了让测试变绿而放宽」：下面那半条**对照侧**证明同一个判据
   *    仍然抓得住「池子与权威清单脱钩」——旧池子的分布会被它全数报出来。
   */
  const players = 400;
  const n = OPEN_PATHWAYS.length;
  const expected = players / n;
  const sigma = Math.sqrt(players * (1 / n) * (1 - 1 / n));
  const tolerance = 3 * sigma;

  /** 同一个判据，既判真池子、也判对照分布 —— 判据只有一份（K9：上界须配对照侧） */
  const offenders = (counts: ReadonlyMap<string, number>): string[] =>
    OPEN_PATHWAYS.filter((pathway) => Math.abs((counts.get(pathway) ?? 0) - expected) > tolerance);

  assert.deepEqual(
    offenders(tallyOf(players, 'm226-pool')),
    [],
    '池子偏离等权超过 3σ（' + tolerance.toFixed(1) + ' 人）—— 期望每条约 ' + expected.toFixed(1) + ' 人',
  );

  /*
   * 对照侧：**旧池子**（硬编码 `['seer','warrior','sleepless']`）在 400 人下的必然分布 ——
   * 三条各 ~133、另外三条 0。这正是 M2.26 任务 0 修掉的那个 bug，
   * 一个「抓得住偏差」的判据必须把它全报出来。
   */
  const legacyPool = new Map([
    ['seer', 133],
    ['warrior', 133],
    ['sleepless', 134],
    ['sailor', 0],
    ['perfect', 0],
    ['reader', 0],
  ]);
  assert.ok(
    offenders(legacyPool).length >= 6,
    '对照侧失败：判据连「池子里少了三条途径」都抓不住，那它就是装饰（K14）',
  );
});

test('M2.26 任务 0.5：每条已实现途径**至少在一座城市开放**（本轮的 0 人坑就出在这里）', () => {
  /*
   * **这一条是现场踩出来的**：M2.26 第一批第一次跑小批时 `perfect = 0 人` ——
   * 途径池是对的（上一条用例证明），但 `cities.yaml` 的出生城市 `pathways` 里
   * **没有一座城市开放 perfect**，于是建号时它被**校正成城市支持的途径**，
   * 玩家侧看起来就是「这条途径一个人都没有」。
   *
   * 这是 K16 的第四个实例（手抄一份权威清单），而这一条守卫让它不会再发生：
   * **加途径时漏了 `cities.yaml`，这条用例直接红**。
   */
  const cities = loadCities().cities;
  const opened = new Set(cities.flatMap((city) => city.pathways as readonly string[]));
  for (const pathway of OPEN_PATHWAYS) {
    assert.ok(
      opened.has(pathway),
      pathway + ' 没有任何城市开放它 —— 途径池里抽得到，也会在建号时被校正成别的途径（表现为「这条途径 0 人」）',
    );
  }
});

test('M2.26 任务 0.6：analyzer 的途径默认值**引用** OPEN_PATHWAYS（不是手抄一份）', () => {
  /*
   * K16 的判据：**修法是引用，不是补齐**。
   * 这条守卫读源码，断言默认值是引用、且文件里没有「一只手抄的途径列表」——
   * 比「两边都写 5 条」那种会一起漂的断言强。
   */
  const source = readFileSync('src/vplayer/analyzer.ts', 'utf8');
  assert.match(source, /pathways: PathwayId\[\] = OPEN_PATHWAYS/, 'worldKnowledge 的默认值必须引用 OPEN_PATHWAYS');
  assert.doesNotMatch(
    source,
    /\['seer'[^\]]*'sleepless'[^\]]*\]/,
    'analyzer.ts 里不该出现手抄的途径列表（K16 的形状：抄一份会漂的副本）',
  );
});

test('M2.26 任务 0：同 seed 可复现（改池子不能破坏铁律 3）', () => {
  const a = buildProfiles({ players: 60, seed: 'm226-pool' });
  const b = buildProfiles({ players: 60, seed: 'm226-pool' });
  assert.deepEqual(
    a.map((p) => [p.pathway, p.gender, p.goal, p.loginTimesPerDay, p.actionsPerLogin]),
    b.map((p) => [p.pathway, p.gender, p.goal, p.loginTimesPerDay, p.actionsPerLogin]),
  );
});

test('M2.26 任务 2.5：城市开放的每条途径，本城都有引导势力传承它（K16 第五实例的守卫）', () => {
  /*
   * **这一条是现场踩出来的**，而且踩了两次（第一批 perfect、第二批 reader）。
   *
   * 玩家入哪条途径**不是**由画像偏好决定的 —— 是「本城势力名单」决定的：
   *   · 保底那条路：pickGuidedFaction 从本城势力里挑一家；
   *   · 自己找那条路：rollRecipeClue 走的也是同一份本城势力名单。
   * 所以「cities.yaml 开了某条途径、factions.yaml 里没有一家传承它」= 这条途径
   * 在这座城市的**期望是 0**（不是「低」），而读数看起来跟抽样运气一模一样（见 K18）。
   *
   * 内容层已经有同样的校验（src/data/loader.ts，error 级 ⇒ 服务端起不来）——
   * 这一条用例是它的**第二道**：让「两份清单不同步」在测试里也红一次，
   * 而不是只靠跑批时那句「服务未就绪」（K17）。
   */
  const cities = loadCities().cities;
  const factions = loadFactions().factions;

  /** 判据只有一份：既判真内容、也判对照分布（K9：上界须配对照侧） */
  const missing = (
    cs: ReadonlyArray<{ id: string; pathways: readonly string[] }>,
    fs: ReadonlyArray<{ cityId: string; pathway: string; id: string }>,
  ): string[] =>
    cs.flatMap((city) =>
      city.pathways
        .filter((pathway) => !fs.some((f) => f.cityId === city.id && f.pathway === pathway))
        .map((pathway) => city.id + ':' + pathway),
    );

  assert.deepEqual(
    missing(cities, factions),
    [],
    '有城市开了某条途径却没有一家本城势力传承它 —— 那条途径在这里的期望是 0（M2.19 的 sailor、M2.26 的 perfect / reader 都栽在这里）',
  );

  // 对照侧：把 M2.26 第二批加的两家拿掉，同一个判据必须立刻把它们报出来
  const withoutNew = factions.filter((f) => f.id !== 'steam_guild' && f.id !== 'bookmen_trier');
  const caught = missing(cities, withoutNew);
  assert.ok(
    caught.includes('backlund:perfect') && caught.includes('trier:reader'),
    '对照侧失败：判据抓不住「城市开了途径但没人传承」，那它就是装饰（K14）。实际报出：' + caught.join(', '),
  );
});
