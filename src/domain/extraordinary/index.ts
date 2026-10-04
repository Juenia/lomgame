/**
 * M2.13 封印物（对外入口）。
 *
 * 与 `domain/creature/index.ts` / `domain/battle/index.ts` 同一手法：
 * 目录外只 import 这一个文件，内部怎么分文件是对外不可见的。
 */
export {
  dropRatesFor,
  dropTierOf,
  isSealed,
  isWonder,
  resolveExtraordinaryUse,
  rollCalamityDrop,
  rollExtraordinaryDrop,
  rerollHelps,
  betterOf,
  shortNameOf,
} from './extraordinary.ts';
export type {
  CalamityDrop,
  DropTier,
  ExtraordinaryAction,
  ExtraordinaryDrop,
  ExtraordinaryKind,
  ExtraordinaryTarget,
  UseResult,
} from './types.ts';
