/**
 * 入途径领域（M2.7.6；M2.85 修订）的对外入口。
 *
 * 层次：
 *   types.ts    纯数据（线索、势力；邀约/任务类型已随引导删除）
 *   mortal.ts   普通人：属性上限、探索修正、被挡下的动作
 *   guided.ts   本地势力权重：线索的途径落点 + 「第几天」的算法
 *   clue.ts     唯一那条路：5% 线索（cluePityDays 保底在 initiate.ts 承接）
 *   initiate.ts 统一入口 resolveInitiation + 入途径那一刻的文案
 */
export * from './types.ts';
export * from './mortal.ts';
export * from './guided.ts';
export * from './clue.ts';
export * from './initiate.ts';
export * from './schema.ts';
export * from './content.ts';
