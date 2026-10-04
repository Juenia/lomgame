/**
 * 战斗（M2.9）：PVE 回合制。
 *
 * 与其它领域模块同一手法：**这一层全是纯函数**，不认识数据库、不认识时钟。
 *   types     —— 数据形状（状态机 + 一回合的结果）
 *   statuses  —— 五种状态（施加 / 推进 / 持续伤害）
 *   skills    —— 每途径两个技能（解禁，不是升级）
 *   specials  —— 物种专属行为（内容侧只写名字，效果在这里查表）
 *   ai        —— 生物六种行为 + 默认攻击的决策
 *   resolve   —— **状态机本体**：resolveBattleRound
 *   state     —— 开局与视图（battleViewFor 对 PVE 与 PVP 是同一个函数）
 *   pvp       —— M2.10：对手是玩家时的三件事（对手的物种视图 / 动作翻译 / 异步回合）
 */
export * from './types.ts';
export * from './statuses.ts';
export * from './skills.ts';
export * from './specials.ts';
export * from './ai.ts';
export * from './resolve.ts';
export * from './state.ts';
export * from './pvp.ts';
