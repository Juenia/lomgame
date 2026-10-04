import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 卡片目录路径集中定义：避免 loader / fragments 互相 import 造成循环依赖 */
export const CARDS_DIR = fileURLToPath(new URL('.', import.meta.url));
export const DAILY_DIR = join(CARDS_DIR, 'daily');
/** M2.7.6：普通人专属事件池（未入途径时唯一会抽到的池子） */
export const MORTAL_DIR = join(CARDS_DIR, 'mortal');
/**
 * M2.76：**途径专属事件池**（按途径区分的卡，cond 写 `pathway:<id>`）。
 *
 * 为什么单开一个目录而不是塞进 daily/：daily 池是**所有已入途径的人共用**的，
 * 它的数量口径被三条断言守着（plain 12 / numeric 16 / CARD_COUNT）。
 * 途径卡是「同一件事只有这条途径的人撞得到」，混进去会让那两个数字
 * 从此同时表达两件事 —— 分开放，各自的数量各自守。
 */
export const PATHWAY_DIR = join(CARDS_DIR, 'pathway');
/**
 * M2.87：**序列专属事件池**（按「途径 × 序列」区分的卡）。
 *
 * 与 pathway/ 的区别：pathway/ 是一张卡写给一条途径（`cond: pathway:X`），
 * 这里是**每一档序列各有自己的卡**（`cond: pathway:X` + `min_seq == max_seq == N`）。
 *
 * 为什么要分开：序列 9 的占卜家与序列 4 的占卜家看到的世界完全不同 ——
 * 「同一件事只有这一档的人撞得到」需要一条**比途径更细**的判据，
 * 而 pathway/ 那些卡的数量口径已经被守着，混进去会让数字同时表达两件事。
 *
 * 素材来源：`诡秘之主原作数据/01-途径与序列/途径-*.yaml` 的 2784 条能力条目，
 * 逐条场景化改写（每张卡的 YAML 头部写着它改写自哪一条）。
 */
export const SEQ_DIR = join(CARDS_DIR, 'seq');
/** 全部卡片目录。顺序固定：lint 与装载的报告口径都依赖它 */
export const CARD_DIRS: readonly string[] = [DAILY_DIR, MORTAL_DIR, PATHWAY_DIR, SEQ_DIR];
export const REGISTRY_FILE = join(CARDS_DIR, 'registry.yaml');
export const FRAGMENTS_FILE = join(CARDS_DIR, 'fragments.yaml');
