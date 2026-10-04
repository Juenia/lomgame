/**
 * NPC 出手（M2.85 世界演化第二层）—— **纯函数，无 IO**。
 *
 * ## 用户拍板的那句话
 *
 * > 「不要随便来个路人甲就窜一下子解决了大灾厄，然后还成神了」
 *
 * 这句话拆成**三道闸**，缺一道都不行：
 *
 *   ① **资格**：序列决定他能碰多高的灾厄 —— 低序列连靠近都做不到
 *   ② **成功率**：硬闯比自己高一档的，会受伤甚至陨落（不是稳赢的)
 *   ③ **功绩**：成神不只看「序列到 1」和「时间够」，还要看**他做过什么**（见 npc-advance.ts 的成神门槛）
 *
 * 于是「路人甲窜一下成神」在结构上不可能：他没资格处理大灾厄 → 拿不到功绩 → 到不了神位。
 */

/** NPC 能出手处理的**最高**灾厄等级（序列越小越强） */
export function maxCalamityLevel(sequence: number): number {
  if (sequence <= 3) return 3;   // 高序列（含天使）：神话级灾厄也敢碰
  if (sequence <= 6) return 2;   // 中序列：能压住中等灾厄
  return 1;                       // 低序列：只应付得了小事 —— 大灾厄面前他们连站都站不稳
}

/** 这个 NPC 能不能处理这一级的灾厄（资格闸） */
export function canHandle(sequence: number, level: number): boolean {
  return level <= maxCalamityLevel(sequence);
}

/**
 * 出手的成功率（0—1）。
 *
 * 高打低很稳（+0.25/档），同级只有 `baseChance`，**低打高不允许**（资格闸已经拦掉了）。
 * ⚠️ 成功率是**项目派生值**（原著没有这种概率），放 `NUMERIC.npc.handleBaseChance` 当旋钮。
 */
export function handleChance(sequence: number, level: number, baseChance = 0.45): number {
  const margin = maxCalamityLevel(sequence) - level;   // 能力余量：越高档越稳
  const raw = baseChance + margin * 0.25;
  return Math.max(0.05, Math.min(0.95, raw));
}

/** 灾厄等级对应的功绩分（化解才算；参与但失败算 0） */
export function meritOfCalamity(level: number): number {
  return level * 10;   // 1 级 10 / 2 级 20 / 3 级 30
}

/** 猎杀一只生物给多少分（按生物序列：越强越多） */
export function meritOfHunt(creatureSequence: number): number {
  return Math.max(1, 10 - creatureSequence);   // 序列 1 的 9 分、序列 9 的 1 分
}

/**
 * 他会不会去猎杀这只生物（**同一个资格闸的第二种用法**）。
 *
 * 规矩与灾厄一致：**要明显比对方强才出手**（差 2 档以上）。
 * 于是「序列 9 的普通人去猎杀序列 2 的怪物」在结构上不会发生 —— 他连想都不会想。
 * 这既是「有智慧」的意思，也是不让低序列靠运气刷功绩的第二道防线。
 */
export function canHunt(npcSequence: number, creatureSequence: number): boolean {
  return creatureSequence >= npcSequence + 2;
}

/** 猎杀成功率（0—1）：差得越多越稳 */
export function huntChance(npcSequence: number, creatureSequence: number, baseChance = 0.5): number {
  if (!canHunt(npcSequence, creatureSequence)) return 0;
  const margin = creatureSequence - npcSequence;   // 差距（≥2）
  const raw = baseChance + Math.min(0.4, (margin - 2) * 0.15);
  return Math.max(0.1, Math.min(0.95, raw));
}

/**
 * 成神需要的功绩分。
 *
 * 参考量级：**3 级灾厄 30 分/次** ⇒ 至少要处理 4 次神话级灾厄，或猎杀一屋子强者。
 * 这就把「时间够了就登神」变成了「时间 + 履历都够了才登神」。
 */
export function godhoodMeritRequired(): number {
  return 120;
}
