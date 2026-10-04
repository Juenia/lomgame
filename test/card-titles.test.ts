import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { PATHWAY_LABELS } from '../src/domain/character/rules.ts';
import { SEQ9_TITLES } from '../src/domain/initiation/initiate.ts';
import {
  ALL_PATHWAYS,
  ALL_SEQUENCES,
  HIGH_SEQUENCES,
  LABEL_OVERRIDES,
  PLAYER_REACHABLE_SEQUENCE,
  SEQUENCE_TITLES,
  allPathwaySequences,
  playableSequence,
  sequenceTitle,
} from '../src/card/titles.ts';

const abilitiesFile = new URL('../src/data/abilities.yaml', import.meta.url);

interface AbilityRow { pathway: string; seq: number; name: string }

function abilityRows(): AbilityRow[] {
  const raw = parseYaml(readFileSync(abilitiesFile, 'utf8')) as { abilities: AbilityRow[] };
  return raw.abilities;
}

/**
 * `docs/设计书.md` T0.2 表 A 的**照抄**（用户数据包，四源交叉一致）。
 *
 * 它在这里**再写一遍**是故意的：卡面表若与它悄悄漂移，这条测试就是唯一能发现的地方。
 * 抄错一格 → 这里报错；改了卡面表却没改依据 → 这里也报错。
 *
 * **M2.76 修正 3 格**：`perfect:4` 炼金术师→炼金术士、`reader:7` 侦探→守知者、
 * `mother:2` 荒芜主人→荒芜主母。依据是 `诡秘之主原作数据/00-索引/交叉校验-项目序列称号.md`
 * 的逐格比对（萌娘百科 + 阅文官方 API 为源，百度百科第二来源 203/210 格一致）。
 * 三处同步：本表、`docs/设计书.md` 表 A、`docs/card-preview.html`。
 */
const CANON: Readonly<Record<string, readonly [number, string][]>> = {
  seer: [[9, '占卜家'], [8, '小丑'], [7, '魔术师'], [6, '无面人'], [5, '秘偶大师'], [4, '诡法师'], [3, '古代学者'], [2, '奇迹师'], [1, '诡秘侍者'], [0, '愚者']],
  warrior: [[9, '战士'], [8, '格斗家'], [7, '武器大师'], [6, '黎明骑士'], [5, '守护者'], [4, '猎魔者'], [3, '银骑士'], [2, '荣耀者'], [1, '神明之手'], [0, '黄昏巨人']],
  sleepless: [[9, '不眠者'], [8, '午夜诗人'], [7, '梦魇'], [6, '安魂师'], [5, '灵巫'], [4, '守夜人'], [3, '恐惧主教'], [2, '隐秘之仆'], [1, '厄难骑士'], [0, '黑暗']],
  sailor: [[9, '水手'], [8, '暴怒之民'], [7, '航海家'], [6, '风眷者'], [5, '海洋歌者'], [4, '灾难主祭'], [3, '海王'], [2, '天灾'], [1, '雷神'], [0, '暴君']],
  perfect: [[9, '通识者'], [8, '考古学家'], [7, '鉴定师'], [6, '机械专家'], [5, '天文学家'], [4, '炼金术士'], [3, '奥秘学者'], [2, '知识导师'], [1, '启蒙者'], [0, '完美者']],
  reader: [[9, '阅读者'], [8, '推理学员'], [7, '守知者'], [6, '博学者'], [5, '秘术导师'], [4, '预言家'], [3, '洞悉者'], [2, '智天使'], [1, '全知之眼'], [0, '白塔']],
  mother: [[9, '耕种者'], [8, '医师'], [7, '丰收祭司'], [6, '生物学家'], [5, '德鲁伊'], [4, '古代炼金师'], [3, '抬棺人'], [2, '荒芜主母'], [1, '自然行者'], [0, '母亲']],
  door: [[9, '学徒'], [8, '戏法大师'], [7, '占星人'], [6, '记录官'], [5, '旅行家'], [4, '秘法师'], [3, '漫游者'], [2, '旅法师'], [1, '星之匙'], [0, '门']],
  sun: [[9, '歌颂者'], [8, '祈光人'], [7, '太阳神官'], [6, '公证人'], [5, '光之祭司'], [4, '无暗者'], [3, '正义导师'], [2, '逐光者'], [1, '纯白天使'], [0, '太阳']],
  corpse_collector: [[9, '收尸人'], [8, '掘墓人'], [7, '通灵者'], [6, '死灵导师'], [5, '看门人'], [4, '不死者'], [3, '摆渡人'], [2, '死亡执政官'], [1, '苍白皇帝'], [0, '死神']],
  error: [[9, '偷盗者'], [8, '诈骗师'], [7, '解密学者'], [6, '盗火人'], [5, '窃梦者'], [4, '寄生者'], [3, '欺瞒导师'], [2, '命运木马'], [1, '时之虫'], [0, '错误']],
  mystery_pryer: [[9, '窥秘人'], [8, '格斗学者'], [7, '巫师'], [6, '卷轴教授'], [5, '星象师'], [4, '神秘学家'], [3, '预言大师'], [2, '贤者'], [1, '知识皇帝'], [0, '隐者']],
  spectator: [[9, '观众'], [8, '读心者'], [7, '心理医生'], [6, '催眠师'], [5, '梦境行者'], [4, '操纵师'], [3, '织梦人'], [2, '洞察者'], [1, '作家'], [0, '空想家']],
  apothecary: [[9, '药师'], [8, '驯兽师'], [7, '吸血鬼'], [6, '魔药教授'], [5, '深红学者'], [4, '巫王'], [3, '召唤大师'], [2, '创生者'], [1, '美神'], [0, '月亮']],
  arbiter: [[9, '仲裁人'], [8, '治安官'], [7, '审讯者'], [6, '法官'], [5, '惩戒骑士'], [4, '律令法师'], [3, '混乱猎手'], [2, '平衡者'], [1, '秩序之手'], [0, '审判者']],
  assassin: [[9, '刺客'], [8, '教唆者'], [7, '女巫'], [6, '欢愉'], [5, '痛苦'], [4, '绝望'], [3, '不老'], [2, '灾难'], [1, '末日'], [0, '魔女']],
  criminal: [[9, '罪犯'], [8, '折翼天使'], [7, '连环杀手'], [6, '恶魔'], [5, '欲望使徒'], [4, '魔鬼'], [3, '呓语者'], [2, '鲜血大公'], [1, '污秽君王'], [0, '深渊']],
  hunter: [[9, '猎人'], [8, '挑衅者'], [7, '纵火家'], [6, '阴谋家'], [5, '收割者'], [4, '铁血骑士'], [3, '战争主教'], [2, '天气术士'], [1, '征服者'], [0, '红祭司']],
  lawyer: [[9, '律师'], [8, '野蛮人'], [7, '贿赂者'], [6, '腐化男爵'], [5, '混乱导师'], [4, '堕落伯爵'], [3, '狂乱法师'], [2, '熵之公爵'], [1, '弑序亲王'], [0, '黑皇帝']],
  monster: [[9, '怪物'], [8, '机器'], [7, '幸运儿'], [6, '灾祸教士'], [5, '赢家'], [4, '厄运法师'], [3, '混乱行者'], [2, '先知'], [1, '巨蛇'], [0, '命运之轮']],
  prisoner: [[9, '囚犯'], [8, '疯子'], [7, '狼人'], [6, '活尸'], [5, '怨魂'], [4, '木偶'], [3, '沉默门徒'], [2, '古代邪物'], [1, '神孽'], [0, '被缚者']],
  secrets_supplicant: [[9, '秘祈人'], [8, '倾听者'], [7, '隐修士'], [6, '蔷薇主教'], [5, '牧羊人'], [4, '黑骑士'], [3, '三首圣堂'], [2, '秽语长老'], [1, '暗天使'], [0, '倒吊人']],
};

test('称号表：与设计书 T0.2 表 A 逐格一致（220 格，一格都不许漂）', () => {
  const drift: string[] = [];
  for (const pathway of ALL_PATHWAYS) {
    const canon = CANON[pathway];
    assert.ok(canon, `CANON 里缺途径 ${pathway}`);
    for (const [seq, title] of canon!) {
      const actual = sequenceTitle(pathway, seq);
      if (actual !== title) drift.push(`${pathway} 序列 ${seq}：表里「${actual}」≠ 原作「${title}」`);
    }
  }
  assert.deepEqual(drift, []);
});

test('称号表：22 途径 × 10 序列 = 220 个组合全部有名字', () => {
  assert.equal(allPathwaySequences().length, 220);
});

test('称号表：同一条途径内不许重名（卡面读不出晋升就是渲染层事故）', () => {
  for (const pathway of ALL_PATHWAYS) {
    const byTitle = new Map<string, number>();
    for (const sequence of ALL_SEQUENCES) {
      const title = sequenceTitle(pathway, sequence);
      const prev = byTitle.get(title);
      assert.equal(prev, undefined, `${pathway} 的序列 ${sequence} 与序列 ${prev} 同名「${title}」`);
      byTitle.set(title, sequence);
    }
  }
});

test('称号表：卡面与原作不一致的格，必须全部登记在 LABEL_OVERRIDES（漏登记 = 卡面偷偷印错名）', () => {
  const rows = abilityRows();
  const libName = new Map<string, string>();
  for (const r of rows) libName.set(`${r.pathway}:${r.seq}`, r.name);
  for (const p of ALL_PATHWAYS) libName.set(`${p}:9`, SEQ9_TITLES[p]);

  const unregistered: string[] = [];
  for (const [key, name] of libName) {
    const [pathway, seqText] = key.split(':');
    const seq = Number(seqText);
    if (!ALL_PATHWAYS.includes(pathway as never)) continue;
    const card = sequenceTitle(pathway as never, seq);
    if (card !== name && LABEL_OVERRIDES[key] === undefined) {
      unregistered.push(`${key}：卡面「${card}」≠ 库「${name}」但没登记`);
    }
  }
  assert.deepEqual(unregistered, []);
});

test('称号表：LABEL_OVERRIDES 里没有死条目（库已改齐的登记必须删掉）', () => {
  const rows = abilityRows();
  const libName = new Map<string, string>();
  for (const r of rows) libName.set(`${r.pathway}:${r.seq}`, r.name);
  for (const p of ALL_PATHWAYS) libName.set(`${p}:9`, SEQ9_TITLES[p]);

  const dead: string[] = [];
  for (const [key, expected] of Object.entries(LABEL_OVERRIDES)) {
    const [pathway, seqText] = key.split(':');
    const current = sequenceTitle(pathway as never, Number(seqText));
    if (current !== expected) dead.push(`${key}：登记「${expected}」但表里是「${current}」`);
    const lib = libName.get(key);
    if (lib === undefined) continue; // 序列 1/0 之类库中没有的格，不算死条目
    if (lib === expected) dead.push(`${key}：库已改成「${lib}」，登记该删`);
  }
  assert.deepEqual(dead, []);
});

test('称号表：T0.3 的结论仍成立 —— 库里有相当比例的格与原作不一致（否则登记表该清空）', () => {
  const rows = abilityRows();
  let mismatched = 0;
  let compared = 0;
  for (const r of rows) {
    compared += 1;
    if (sequenceTitle(r.pathway as never, r.seq) !== r.name) mismatched += 1;
  }
  assert.ok(compared >= 49, `对账格数 ${compared} 少于 49`);
  assert.ok(mismatched >= 30, `不一致只有 ${mismatched} 格 —— 设计书 T0.3 记的是 34 格，先核对再改本断言`);
});

test('称号表：序列 9 与原作一致的途径不许登记（那条登记是多余的）', () => {
  for (const [key, expected] of Object.entries(LABEL_OVERRIDES)) {
    const [pathway, seqText] = key.split(':');
    if (Number(seqText) !== 9) continue;
    assert.notEqual(
      SEQ9_TITLES[pathway as never],
      expected,
      `${key}：SEQ9_TITLES 已与原作一致，登记多余`,
    );
  }
});

test('称号表：阅读者序列 7 的两种写法都在案（数据包两处来源不一致）', () => {
  /*
   * M2.76：歧义**已裁定** —— 原著数据（萌娘百科 + 阅文官方 API）取「守知者」，
   * 所以那条「两种写法都算通过」的断言改成唯一值断言：
   * 留一个候选列表在那里，下一个人会以为它还没定。
   */
  assert.equal(sequenceTitle('reader', 7), '守知者');
});

test('称号表：序列 1/0 一律不可达，且都有名字', () => {
  for (const pathway of ALL_PATHWAYS) {
    for (const seq of HIGH_SEQUENCES) {
      assert.equal(playableSequence(seq), false);
      assert.ok(sequenceTitle(pathway, seq).length > 0);
    }
  }
  assert.equal(PLAYER_REACHABLE_SEQUENCE, 2);
  assert.equal(playableSequence(2), true);
  assert.equal(playableSequence(9), true);
});

test('称号表：缺失的档一律抛错，不回退占位名（K19）', () => {
  assert.throws(() => sequenceTitle('seer', 11), /没有 seer 的序列 11/);
  assert.throws(() => sequenceTitle('nope' as never, 9), /没有途径 "nope"/);
});

test('称号表：途径覆盖与 PATHWAY_LABELS 同步（加途径必须同时改这里）', () => {
  assert.deepEqual([...ALL_PATHWAYS].sort(), Object.keys(PATHWAY_LABELS).sort());
  assert.deepEqual([...ALL_PATHWAYS].sort(), Object.keys(SEQUENCE_TITLES).sort());
  assert.deepEqual([...ALL_PATHWAYS].sort(), Object.keys(CANON).sort());
});
