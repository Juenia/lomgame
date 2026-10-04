/**
 * 仪式破坏（M2.85 RPG 化）—— **纯函数，无 IO**。
 *
 * ## 用户拍板
 *
 * > 「某些强大的高序列交恶了可能破坏晋升仪式」
 *
 * 这条补上了棋局级的**最后一块**，而且它挑的时刻最狠：
 * 晋升仪式是玩家**把全部材料与前途押上去的那一刻** —— 阶段 3 结算失败 = 材料损一半 + 重伤。
 * 在他最输不起的时候伸手，这才是半神该干的事（原著里克莱恩的晋升就没少被搅）。
 *
 * ## 与阴谋（npc_schemes）的分工
 *
 *   阴谋是**长线布局**（90 天 + 30 天端倪），有察觉窗口
 *   仪式破坏是**临门一脚**（在你点「融合」的那一刻），没有铺垫，你只能靠**准备**去防
 *
 * 所以防它的方式不是「察觉」，而是：
 *   · 把仪式配置拉满（地点 / 时间 / 见证都选对，成功率本来就高）
 *   · 别在得罪了半神的时候硬升 —— 这条本身就是 RPG 的取舍
 */

/**
 * 这个人会不会来搅你的仪式。
 *
 * 条件：**交恶**（≤ −25）且**序列够高**（≤ 6 —— 他自己得看懂仪式在干什么）。
 * 概率随「序列差 × 交恶程度」上升：差得越多、恨得越深，越可能来。
 */
export function sabotageChance(npcSequence: number, affinity: number, playerSequence: number): number {
  if (affinity > -25) return 0;
  if (npcSequence > 6) return 0;
  const hate = Math.min(1, (-affinity - 25) / 75);          // 0—1：从「冷淡」到「死敌」
  const gap = Math.max(0, playerSequence - npcSequence);     // 他比玩家强多少档
  const edge = Math.min(1, gap / 4);                         // 0—1
  return Math.max(0, Math.min(0.85, 0.15 + hate * 0.45 + edge * 0.45));
}

/**
 * 被搅了这一下，成功率要扣多少（**绝对值**，直接减在百分比上）。
 *
 * 量级参照：把仪式配置拉满能到 95%，而一个死敌半神能扣掉 20—45 个点 ——
 * 恰好是「配置得再好也可能翻车」的那个区间。
 */
export function sabotagePenalty(npcSequence: number, playerSequence: number): number {
  const gap = Math.max(0, playerSequence - npcSequence);
  return Math.min(45, 20 + gap * 6);
}

/**
 * 搅局者的三种手笔（按他的序列挑）：
 * 低序列只能物理捣乱，高序列能从**神秘层面上**污染你的仪式。
 */
export function sabotageTextFor(npcSequence: number): string {
  if (npcSequence <= 3) return '仪式的图案在最后一步被改了一笔 —— 那一笔不是你画的。';
  if (npcSequence <= 5) return '你念到一半，发现自己念的句子有个地方不对。你不记得自己念错过。';
  return '蜡烛灭了一次。再点上之后，火苗的方向反了。';
}

/** 仪式被破坏之后的收场话（玩家看到的） */
export function sabotageResultLine(npcName: string, foiled: boolean): string {
  return foiled
    ? `${npcName}在你的仪式上动了手脚 —— 但你看出来了，把它按了回去。`
    : `${npcName}在你的仪式上动了手脚。你没有看出来。`;
}
