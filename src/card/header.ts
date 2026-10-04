/**
 * 顶部玩家信息条（M2.86）：头像 + 昵称 + 性别符号 + 地点，**自绘成一张图**。
 *
 * ## 用户拍板
 *
 * > 「顶部玩家信息 <头像+昵称+性别符号抽象显示+换行+所在地点> 长久化图片绘制，置顶部，做常驻显示，
 * >   只有角色卡不显示，图片自绘增加缓存，不要每次都重画，没变化则不花」
 *
 * > 「信息头的文字太挤了 放开一点」
 *
 * ## 为什么是图片（而不是像以前那样用 markdown 拼）
 *
 * `adapter/official.ts` 里那段注释是血泪：为了在 markdown 里把「头像 + 右边两行文字」摆对，
 * **试了十五版**，最后只能压成一行 —— 因为 markdown 没有 float、没有 vertical-align、
 * 换行后文字从段落左边缘开始而不是从图片右边缘开始。合成一张图之后这些问题全部消失。
 *
 * ## 版式（第二轮放宽）
 *
 * 第一版偏挤：内边距 20 / 头像 72 / 昵称 30 / 地点 21 / 行距 8。
 * 用户实机看到「文字太挤」后整体放大一档：**30 / 80 / 36 / 25 / 12**。
 *
 * ## 缓存纪律：**没变化就不重画**
 *
 * 键 = 昵称 + 性别 + 地点 + 途径 + **头像内容哈希**。任何一项变了才出新图。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataPath } from '../infra/paths.ts';
import { renderHtmlToPng } from '../render/browser.ts';

/** 设计网格（宽与角色卡一致，出图 2 倍） */
export const HEADER_W = 620;
export const HEADER_H = 116;
/** 宽高比 —— 正文内嵌时要用（markdown 的图片语法必须给宽和高） */
export const HEADER_RATIO = HEADER_W / HEADER_H;

/** 信息条缓存目录 */
export const DEFAULT_HEADER_DIR = dataPath('cards', 'header');

export interface HeaderInput {
  nickname: string;
  gender: 'male' | 'female' | 'other';
  locationName: string;
  /** 途径与序列（可选，挂在昵称后） */
  pathwayLabel?: string;
  /** 头像的 data URI（没有就画名字首字的纹章） */
  avatarDataUri?: string;
}

/** 性别符号（**抽象显示**：一个符号 + 一种颜色，不用汉字） */
const GENDER_GLYPH: Record<HeaderInput['gender'], { glyph: string; color: string }> = {
  male: { glyph: '\u2642', color: '#6f9fd8' },
  female: { glyph: '\u2640', color: '#d88fa8' },
  other: { glyph: '\u26A7', color: '#a89cc8' },
};

const CSS = "html,body{margin:0;padding:0;background:transparent;}.wrap{width:620px;height:116px;box-sizing:border-box;display:flex;align-items:center;gap:22px;padding:18px 30px;font-family:\"Microsoft YaHei\",\"PingFang SC\",system-ui,sans-serif;background:linear-gradient(100deg,#1b1a20 0%,#242129 55%,#2b2620 100%);border-bottom:1px solid #3a332a;}.av{width:80px;height:80px;border-radius:50%;object-fit:cover;flex:0 0 80px;border:2px solid #5a4d38;box-shadow:0 0 0 4px rgba(200,164,92,.14);}.av.mono{display:flex;align-items:center;justify-content:center;font-size:38px;color:#c8a45c;background:#2a2620;}.txt{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;justify-content:center;}.l1{display:flex;align-items:baseline;gap:12px;}.name{font-size:36px;font-weight:700;color:#f0e6d2;letter-spacing:.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:430px;line-height:1.2;}.sex{font-size:28px;font-weight:700;line-height:1;}.pw{font-size:19px;color:#8d8577;letter-spacing:.3px;}.l2{margin-top:12px;font-size:25px;color:#c8a45c;letter-spacing:.4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2;}.l2::before{content:\"\\2316\";margin-right:10px;color:#8a7a52;}";

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 信息条的 HTML（**纯函数** —— 画什么全在这里，渲染器只管交给 Edge）。
 *
 * 版式：左侧圆头像（80px），右侧两行 —— 第一行昵称 + 性别符号，第二行地点。
 * 这正是 markdown 做不到的形状，也是这张图存在的理由。
 */
export function headerHtml(input: HeaderInput): string {
  const g = GENDER_GLYPH[input.gender];
  const initial = input.nickname.trim().slice(0, 1) || '\uFF1F';
  const avatar = input.avatarDataUri !== undefined
    ? '<img class="av" src="' + input.avatarDataUri + '" alt="">'
    : '<div class="av mono">' + escapeHtml(initial) + '</div>';
  const pathway = input.pathwayLabel !== undefined && input.pathwayLabel.length > 0
    ? '<span class="pw">' + escapeHtml(input.pathwayLabel) + '</span>'
    : '';
  return '<!doctype html><html><head><meta charset="utf-8"><style>' + CSS + '</style></head><body>'
    + '<div class="wrap">' + avatar + '<div class="txt">'
    + '<div class="l1"><span class="name">' + escapeHtml(input.nickname) + '</span>'
    + '<span class="sex" style="color:' + g.color + '">' + g.glyph + '</span>' + pathway + '</div>'
    + '<div class="l2">' + escapeHtml(input.locationName) + '</div>'
    + '</div></div></body></html>';
}

/** 缓存键：任何一项变了才重画（**这就是「没变化则不花」**） */
/**
 * **版式版本**：改了 CSS / 字号 / 间距就把它 +1。
 *
 * ⚠️ 不加这一项会出一个很难发现的问题：缓存键只看内容（昵称/性别/地点/途径/头像），
 * 所以**改了版式之后，所有老玩家拿到的还是旧版式的缓存图** ——
 * 明明代码改了、测试也过了，实机看上去却「根本没生效」。
 * 改动视觉就该让缓存失效，这是缓存设计里最容易漏的一条。
 */
export const HEADER_LAYOUT_VERSION = 'v2';

export function headerCacheKey(input: HeaderInput): string {
  const h = createHash('sha256');
  h.update(HEADER_LAYOUT_VERSION);
  h.update('|' + input.nickname);
  h.update('|' + input.gender);
  h.update('|' + input.locationName);
  h.update('|' + (input.pathwayLabel ?? ''));
  // 头像内容也进键：换了头像就该出新图，但没换就别重画
  h.update('|' + (input.avatarDataUri ?? ''));
  return h.digest('hex').slice(0, 32);
}

export interface HeaderOutcome {
  png: Buffer;
  /** true = 命中了缓存（这一次**没有**重新渲染） */
  fromCache: boolean;
  key: string;
  file: string;
}

/**
 * 出图（带缓存）。
 *
 * 渲染失败一律返回 undefined —— 与按钮/头像同一条纪律：
 * **信息条画不出来时，正文照常发**，绝不因为一张装饰图把消息卡死。
 */
export async function renderHeader(
  input: HeaderInput,
  options: { dir?: string; force?: boolean; scale?: number } = {},
): Promise<HeaderOutcome | undefined> {
  const dir = options.dir ?? DEFAULT_HEADER_DIR;
  const key = headerCacheKey(input);
  const file = join(dir, key + '.png');
  if (options.force !== true && existsSync(file)) {
    try {
      return { png: readFileSync(file), fromCache: true, key, file };
    } catch {
      // 读不出来就当没缓存（装饰图不值得让整条消息失败）
    }
  }
  /*
   * `renderHtmlToPng` 是**同步**的，而且失败时**抛异常**（超时 / Edge 挂起 / profile 被锁）。
   * 与卡片渲染同一条纪律：catch 住、返回 undefined、正文照常发。
   */
  let png: Buffer | undefined;
  try {
    png = renderHtmlToPng(headerHtml(input), { width: HEADER_W, height: HEADER_H, scale: options.scale ?? 2, tag: 'header' });
  } catch {
    return undefined;
  }
  if (png === undefined || png.length === 0) return undefined;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, png);
  } catch {
    // 写不进去也要把图发出去（缓存是优化，不是前提）
  }
  return { png, fromCache: false, key, file };
}

/** QQ 的 raw_url（COS 链接）**24 小时过期** —— 缓存必须早于此失效 */
export const HEADER_URL_TTL_MS = 20 * 60 * 60 * 1000;

/**
 * 读缓存的 URL。
 *
 * ⚠️ **必须检查时效**：QQ 富媒体上传拿到的 raw_url 是 24 小时有效的 COS 链接。
 * 把 URL 当永久缓存写下来，意味着**第二天整批信息条集体裂图** ——
 * 而裂图只表现成「挂了个破图」，不报错、极难归因。
 * 所以缓存文件里除了 URL 还写一行时间戳，超过 TTL 就当没缓存。
 */
export function readHeaderUrl(key: string, dir: string = DEFAULT_HEADER_DIR, now: number = Date.now()): string | undefined {
  try {
    const file = join(dir, key + '.url');
    if (!existsSync(file)) return undefined;
    const raw = readFileSync(file, 'utf8');
    const [url = '', at = '0'] = raw.split('\n');
    if (url.trim().length === 0) return undefined;
    if (now - Number(at) > HEADER_URL_TTL_MS) return undefined;
    return url.trim();
  } catch {
    return undefined;
  }
}

export function writeHeaderUrl(key: string, url: string, dir: string = DEFAULT_HEADER_DIR, now: number = Date.now()): void {
  try {
    mkdirSync(dir, { recursive: true });
    // 第二行是写入时刻，读的时候按 TTL 判过期
    writeFileSync(join(dir, key + '.url'), url + '\n' + now, 'utf8');
  } catch {
    // 写不进去只是下次再传一遍，不影响出图
  }
}

/**
 * 出图 + 拿 URL（**带两层缓存**：图片一次、URL 一次）。
 *
 * upload 由调用方注入（各通道的上传不同）—— 这里不猜通道，只负责「图有了、URL 有了、下次别再花」。
 */
export async function renderHeaderUrl(
  input: HeaderInput,
  upload: (png: Buffer, key: string) => Promise<string | undefined>,
  options: { dir?: string; force?: boolean; scale?: number } = {},
): Promise<{ url: string; fromUrlCache: boolean; fromImageCache: boolean } | undefined> {
  const dir = options.dir ?? DEFAULT_HEADER_DIR;
  const key = headerCacheKey(input);
  if (options.force !== true) {
    const cached = readHeaderUrl(key, dir);
    if (cached !== undefined) return { url: cached, fromUrlCache: true, fromImageCache: true };
  }
  const image = await renderHeader(input, options);
  if (image === undefined) return undefined;
  let url: string | undefined;
  try {
    url = await upload(image.png, key);
  } catch {
    return undefined;
  }
  if (url === undefined || url.length === 0) return undefined;
  writeHeaderUrl(key, url, dir);
  return { url, fromUrlCache: false, fromImageCache: image.fromCache };
}
