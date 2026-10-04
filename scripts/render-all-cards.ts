/**
 * 全量角色卡出图（M2.47）：7 途径 × 序列 9—0 = 70 张。
 *
 * 跑法：node scripts/render-all-cards.ts [输出目录]
 *
 * ## 为什么要有这个脚本
 * 卡面模板必须能覆盖**每一条途径的每一档序列** —— 只要有一档画不出来，
 * 玩家升到那一档时卡面就是空的。70 张一次性出完，缺口是看得见的（缺文件）。
 * 序列 1/0 本版不可达，但**照样出图**：模板的可达性由 `seqNote` 标注，
 * 不由「文件存不存在」表达。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { characterCardData } from '../src/card/contract.ts';
import { renderCharacterCard } from '../src/card/render.ts';
import { ALL_PATHWAYS, ALL_SEQUENCES, sequenceTitle } from '../src/card/titles.ts';
import type { CharacterState } from '../src/domain/character/types.ts';

const outDir = resolve(process.argv[2] ?? 'build/cards');
mkdirSync(outDir, { recursive: true });

/** 一份**样板角色**：用来审视版式，不是任何真实玩家 */
function sample(pathway: CharacterState['pathway'], sequence: number): CharacterState {
  return {
    id: 'sample',
    userId: 'sample',
    name: '克莱恩·莫雷蒂',
    pathway,
    sequence,
    pathwayStatus: pathway === null ? 'mortal' : 'initiated',
    gender: 'male',
    hp: 84,
    mp: 91,
    mad: 38,
    cor: 27,
    dig: 73,
    dp: 4,
    status: 'active',
    promotionFails: 0,
    currentCityId: 'tingen',
    churchId: 'night',
    churchContribution: 120,
    createdAt: 0,
    updatedAt: 0,
  };
}

const facts = {
  cityName: '廷根市',
  churchName: '黑夜女神教会',
  promotionSuccess: 0.71,
  lossGate: { mad: 65, cor: 60 },
};

let count = 0;
const failures: string[] = [];
for (const pathway of ALL_PATHWAYS) {
  for (const sequence of ALL_SEQUENCES) {
    const state = sample(pathway, sequence);
    const data = characterCardData(state, facts);
    const file = join(outDir, `${pathway}-${sequence}.png`);
    try {
      const png = renderCharacterCard(data);
      writeFileSync(file, png);
      count += 1;
    } catch (error) {
      failures.push(`${pathway}-${sequence}: ${(error as Error).message}`);
    }
  }
}

// 普通人（未入途径）单独一张：卡面不许出现序列
try {
  const mortal = characterCardData({ ...sample(null, 9), pathway: null, sequence: null, pathwayStatus: 'mortal' }, {
    cityName: '廷根市',
  });
  writeFileSync(join(outDir, 'mortal.png'), renderCharacterCard(mortal));
  count += 1;
} catch (error) {
  failures.push(`mortal: ${(error as Error).message}`);
}

console.log(`出图 ${count} 张 → ${outDir}`);
if (failures.length > 0) {
  console.error(`失败 ${failures.length} 张：`);
  for (const f of failures) console.error('  ' + f);
  process.exitCode = 1;
}
// 抽样打印，供人工核对称号与徽章
for (const pathway of ALL_PATHWAYS) {
  const row = ALL_SEQUENCES.map((s) => `${s}:${sequenceTitle(pathway, s)}`).join(' ');
  console.log(`${pathway.padEnd(10)} ${row}`);
}
