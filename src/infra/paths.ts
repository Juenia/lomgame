/**
 * 运行期数据的根目录（卡片、头像、各种缓存）—— 一个地方说了算。
 *
 * ## 为什么要有这个模块（现场事故）
 *
 * 从前这些目录全是写死的 `join(process.cwd(), 'data', …)`。
 * 在仓库里跑、BEE 部署里跑都没事，因为那时**进程的 cwd 就是数据该在的地方**。
 *
 * 但 Koishi 那套是把插件**装进 `node_modules/koishi-plugin-lom-bridge`**，
 * 内核的 cwd 就是那个包里的 `core/` —— 于是每出一张角色卡、每缓存一次头像，
 * 都在**插件安装目录**里写文件。后果有两个，而且都不报错：
 *
 *   ① 插件一更新，整个包目录被 npm 替换掉，玩家的头像/卡片缓存跟着没了；
 *   ② 更新那一刻目录里还有文件在写、内核进程的 cwd 也在里头 ——
 *      现场表现就是「**插件不停止，Koishi 的更新就装不上**」，
 *      得先去控制台把插件停掉（停插件 = 杀掉内核）才装得进。
 *
 * 所以部署方（Koishi 插件）现在会传 `LOM_DATA_DIR`，把数据指到存档目录去；
 * 不传就还是老的 `<cwd>/data` —— 仓库开发、BEE 部署的行为**一个字都不变**。
 */
import { join } from 'node:path';

/** 运行期数据的根目录：`LOM_DATA_DIR` 优先，否则 `<cwd>/data`（老行为） */
export function dataRoot(): string {
  const configured = (process.env['LOM_DATA_DIR'] ?? '').trim();
  return configured !== '' ? configured : join(process.cwd(), 'data');
}

/**
 * 拼一个运行期数据路径。
 *
 * ⚠️ 只用于**运行期产生**的东西（缓存、出图、备份这类可以重建的）。
 * 内容文件的路径**不归它管** —— 那些由 `src/data/loader.ts` 按模块自身位置解析
 * （`import.meta.url`），与工作目录无关。这一点正是这份改动敢动 cwd 一侧的底气。
 */
export function dataPath(...parts: string[]): string {
  return join(dataRoot(), ...parts);
}
