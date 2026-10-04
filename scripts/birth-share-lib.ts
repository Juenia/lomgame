/**
 * M2.35 任务 1：**这个文件已经搬到 `src/data/birth-share.ts`**。
 *
 * 搬家的理由：链路检查器（`src/data/link-check.ts` 第 3 项「跑批可达」）也要用这个口径，
 * 而它必须能在 `loadContent()` 里被调用 —— 那一层不能反向依赖 `scripts/`。
 * 留在原地会造成**第二份份额算法**，而那正是铁律 11 与 K16 一起禁掉的形状
 * （「两边各算一遍，而其中一边漏了城市份额」在 M2.26 已经发生过一次）。
 *
 * 本文件保留为**转发**（不复制内容）：两个脚本的 import 路径不变，改动面最小。
 * ⚠️ 不要再往这里加实现 —— 要改口径请去 `src/data/birth-share.ts`。
 */

export * from '../src/data/birth-share.ts';
