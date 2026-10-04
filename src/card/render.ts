/**
 * 角色卡渲染（M2.48）：把角色状态画成**图片**。
 *
 * ## 为什么是图片
 * 纯文字卡受三样东西限制：QQ 的 Markdown 白名单、emoji 的宽度漂移、
 * 以及「所有机器人长得都一样」。图片没有这些约束。
 *
 * ## 为什么从 GDI+ 换成 Edge（M2.48 重写）
 *
 * M2.46 起卡面是 PowerShell 调 GDI+ 画的。**换了七版都长一个样**：一个居中的表单，
 * 顶上盖了个圆。原因不是配色（对参考卡的实测早就把色调对齐了：暗部 85.6% / 亮部 2.3% /
 * 金 2.2%，参考卡是 84% / 2.4% / 2.04%），是**空间组织**做不到：
 *
 *   要的东西             GDI+       Chromium
 *   模糊雾（深度）        ✗          filter: blur()
 *   前后的图层关系        ✗          z-index + 前景弧压主体
 *   把亮头像调进暗卡      ✗          mix-blend-mode: multiply / color
 *   颗粒（去色带）        ✗          feTurbulence + overlay
 *   圆内暗角（软化硬边）  ✗          radial-gradient 遮罩
 *
 * 这七条没有一条能用 `DrawEllipse` 补上。所以换渲染器 —— 换的是**能力**，不是配色。
 *
 * ## 为什么还是"不引原生依赖"
 * 本机是 Windows，**Edge 是系统自带的**（和当年选 GDI+ 是同一条理由）。
 * 无头模式 + `--screenshot` 就能把 HTML 出成 PNG，拿到的却是完整 Chromium。
 * 运行时的 npm 依赖依然只有 yaml + zod。
 *
 * ## 分工
 *   本模块：卡面数据 → 起 Edge → 读回 PNG
 *   template.ts：卡面数据 → HTML（纯函数，画什么全在那儿）
 *   contract.ts：角色状态 → 卡面数据（**卡面上每个数字的唯一出处**）
 */
import { readFileSync } from 'node:fs';
import { cardHtml, dataUri } from './template.ts';
import { renderHtmlToPng } from '../render/browser.ts';

/** 设计网格：和 template.ts 里的 W/H 一致。出图是它的 2 倍（--force-device-scale-factor）。 */
const W = 620;
const H = 1000;

/**
 * 卡面的宽高比 —— 给**正文里内嵌图片**的调用方用（M2.45）。
 *
 * markdown 的图片语法要同时给宽和高（`![alt #宽px #高px](url)`），
 * 而显示尺寸必须与设计网格同比例，否则卡面会被拉扁。
 * 让这一处派生，调用方就不必抄一份 620 / 1000。
 */
export const CARD_RATIO = W / H;
const SCALE = 2;

export interface CardBar { label: string; value: number; max: number; }
export interface CardField { label: string; value: string; }

export interface CharacterCardData {
  /** 卡片顶上的小字（默认「诡 秘 之 主」） */
  topLabel?: string;
  /** 已下载到本地的头像文件路径；没有就画首字纹章 */
  avatarPath?: string;
  /**
   * 卡面背景图（本地路径）。**由豆包那类工具出素材**，本渲染器只负责叠数据。
   * 给了就盖住默认雾面，并自动压一层暗色蒙版保证文字可读；不给就退回程序化雾面。
   * 建议尺寸 1240×2000 或同比例（竖版卡牌），别的比例会被裁切。
   */
  backgroundPath?: string;
  /**
   * 途径 id（seer / warrior / sleepless / sailor / perfect / reader / mother）。
   * 模板按它挑一个**主色**（只染辉光、刻度、仪表环，不染面）；认不出就退回中性灰金。
   */
  pathway?: string;
  name: string;
  genderTag?: string;
  pathwayLine: string;
  /**
   * 序列称号（如「占卜家」「午夜诗人」），画在序列标签里，宋体金色。
   *
   * ⚠️ 取值只能来自 `src/card/titles.ts` 的 `sequenceTitle()` ——
   * 那是逐格对齐原作的唯一出处；随手写一个名字就会与卡面规范脱节。
   */
  title?: string;
  /** 一句氛围话，画在页脚上方（居中，宋体主题色） */
  quote?: string;
  /** 所在地。卡面上单独占一行、配定位图标，和教会/虔诚那行分开 */
  city?: string;
  identity?: string;
  /** 序列标签的正条（如「序列 2」） */
  seqLabel?: string;
  /** 标签下面那行小注：本版够不到的序列要写明（如「本版不可达」） */
  seqNote?: string;
  bars: CardBar[];
  /** 数值并排的「代价」一栏（疯狂 / 污染 / 消化） */
  costs?: CardField[];
  fields: CardField[];
  footnote?: string;
}

/** 读一张本地图并转成 data URI；读不到就返回 undefined（卡面退回纹章/雾面，不报错）。 */
function assetUri(path: string | undefined): string | undefined {
  if (path === undefined || path.length === 0) return undefined;
  try {
    return dataUri(readFileSync(path));
  } catch {
    return undefined;
  }
}

/**
/**
 * 渲染角色卡，返回 PNG 字节。
 *
 * 出图本身（Edge 无头模式、profile 复用、PNG 落盘轮询、stderr 噪音）已经抽到
 * src/render/browser.ts，与 M2.54 的世界地图共用同一条通道 —— 那些坑不该踩第二遍。
 */
export function renderCharacterCard(data: CharacterCardData): Buffer {
  return renderHtmlToPng(
    cardHtml(
      { topLabel: '诡 秘 之 主', ...data },
      {
        avatar: assetUri(data.avatarPath),
        background: assetUri(data.backgroundPath),
      },
    ),
    { width: W, height: H, scale: SCALE, tag: 'card' },
  );
}
