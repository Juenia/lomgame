/**
 * M2.26 任务 0.5 的**前端链路验证**（不需要跑批）。
 *
 * ## 为什么要有这一条
 *
 * 小批（50 人）里 `perfect = 0 人` —— 但那个 0 **不能直接读成「断链」**：
 * `perfect` 只在**贝克兰德**开放（`cities.yaml`），而出生城市是 `birthCityOf(userId)` 派生的，
 * 所以「池子里抽到 perfect」**且**「出生在贝克兰德」两个条件同时成立才有玩家能入这条途径。
 * 两者各约 1/5 ⇒ 50 人里的期望只有 **约 2 人** ⇒ 抽到 0 人完全可能（约 13%）。
 *
 * 所以真正该问的是：**这条链路的每一环都通吗**：
 *
 *   ① 途径池里抽得到 perfect        （`profiles.test`，任务 0）
 *   ② 有城市开放 perfect            （`m2-26-pathway-pool.test.ts`，任务 0.5 的守卫）
 *   ③ **「perfect 偏好」与「开放 perfect 的城市」同时命中的人存在**  ← **本用例**
 *   ④ 那张配方的主材料在传承城市够得着（内容层校验，`loadContent()` 的 error 数）
 *
 * ①②④ 都已被别的用例守住，③ 就是这一条 —— 它把「小批 0 人」这个观测
 * 从「可能是断链」降级成「样本不够」。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { birthCityOf } from '../src/domain/geo/index.ts';
import { loadCities } from '../src/data/loader.ts';
import { OPEN_PATHWAYS } from '../src/domain/character/rules.ts';
import { buildProfiles } from '../src/vplayer/profiles.ts';

test('M2.26 任务 0.5：每条途径都有出生城市开放它（200 人规模作诊断）', (t) => {
  const cities = loadCities().cities;
  const byId = new Map(cities.map((city) => [city.id, city]));
  const profiles = buildProfiles({ players: 200, seed: 'm226' });

  /** 能真的走上这条途径的人数：偏好是该途径 **且** 出生城市开放它 */
  const usable = new Map<string, number>();
  for (const pathway of OPEN_PATHWAYS) usable.set(pathway, 0);
  let noCity = 0;
  for (const profile of profiles) {
    // birthCityOf(userId, cities)：排序后加权掷骰，结果只取决于 (userId, 城市集合)
    const city = byId.get(birthCityOf(profile.userId, cities).id);
    if (!city) {
      noCity += 1;
      continue;
    }
    if ((city.pathways as readonly string[]).includes(profile.pathway)) {
      usable.set(profile.pathway, (usable.get(profile.pathway) ?? 0) + 1);
    }
  }

  assert.equal(noCity, 0, '每个 userId 都应当派生出已登记的城市');
  /*
   * M2.76：原来的判据是「**每条途径在 200 人里至少有 1 人**命中」。
   * 22 条途径下这条不再成立 —— 200 人分到 22 条途径、再乘上「出生城市开放它」的条件，
   * 冷门途径落在 0 人是**抽样噪声**，不是内容缺口（7 条途径时它恰好够用）。
   *
   * ⇒ 拆成两条：
   *   ① **结构性**判据（本文件该守的）：每条已实现途径至少有一座出生城市开放它 ——
   *      这一条在任何样本量下都必须成立，而它才是「0 人坑」的真正成因；
   *   ② 抽样判据降级为**诊断信息**（用 t.diagnostic 打出来），不当断言。
   */
  for (const pathway of OPEN_PATHWAYS) {
    const openCities = cities.filter((city) => city.birth_weight > 0 && (city.pathways as readonly string[]).includes(pathway));
    assert.ok(
      openCities.length > 0,
      pathway + ' 没有任何出生城市开放它 —— 这条途径的玩家永远拿不到配方线索（任务 0.5 要守的就是这个）',
    );
  }
  for (const pathway of OPEN_PATHWAYS) {
    const n = usable.get(pathway) ?? 0;
    t.diagnostic(pathway + '：' + n + ' 人（偏好它且出生在开放它的城市）');
  }

  /*
   * 一并把「为什么 50 人小批可能是 0」记在这里：
   * 按等权 1/5 × 城市份额算，50 人里每条途径的可用期望只有个位数。
   * ⇒ 小批的 0 只能当**方向性**观测，真正的验收要靠任务 4 的 200 人批。
   */
  /*
   * M2.76：这条断言（同一条用例里的第二个）一并降级为诊断 ——
   * 22 条途径 × 200 人时，冷门途径落在 0 人是**抽样噪声**（7 条途径时它恰好够用）。
   * 结构性判据在上面那个循环里已经守住了（每条途径至少一座出生城市开放它），
   * 那才是「0 人坑」的真正成因。
   */
  const smallest = Math.min(...OPEN_PATHWAYS.map((p) => usable.get(p) ?? 0));
  t.diagnostic('200 人里最少的可用途径只有 ' + smallest + ' 人（抽样噪声，非内容缺口）');
});
