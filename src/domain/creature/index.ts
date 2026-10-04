/**
 * 非凡生物（M2.8）的对外入口。
 *
 * 层次：
 *   types.ts      纯数据（物种模板 / 生物实例 / 遭遇结果 / 生态 tick 结果）
 *   schema.ts     物种模板的 YAML schema 与校验
 *   perception.ts 感知分层 —— **M2.8 最重要的一条**：同一只生物，不同序列的人看到不同的东西
 *   ecology.ts    生态 tick：迁移 / 捕食 / 进化 / 繁衍 / 衰亡（世界自己在动）
 */
export * from './types.ts';
export * from './schema.ts';
export * from './perception.ts';
export * from './ecology.ts';
