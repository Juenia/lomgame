/**
 * 角色卡卡面模板（M2.48）：卡面数据 → 自包含 HTML，交给 Edge 无头出图。
 *
 * ## 分工（本文件最重要的约束）
 *
 * **美术归出图工具，排版归这里。** 见 docs/角色卡-卡面规范.md §3 素材契约：
 * 黄铜做旧、灰雾、羊皮纸颗粒、油画质感那一层，**代码画不出来** —— 拿 SVG 去追
 * 只会得到一堆干净的几何图形，怎么调都不像。所以：
 *
 *   有 backgroundPath（AI 出的底图）→ 铺底图 + 压暗蒙版保可读，程序化美术全部让位
 *   没有                            → 程序化星盘兜底，保证「没素材时不是一张白板」
 *
 * ## 排版不许崩（用户原话：「你做的排版后期铁定会崩」）
 *
 * 上一版的坐标是对着「克莱恩·莫雷蒂 + 8 个字段」手调出来的魔数，换个人就散。
 * 这一版所有位置和字号**从内容推导**：
 *
 * | 崩法 | 这里怎么办 |
 * |---|---|
 * | 名字 1—10 字 | 先量宽度，超出可用弧长就整行缩字号 |
 * | 数值 3 位（100/100） | 同上，数值一起参与量宽 |
 * | identity 为空（没城市没教会） | 该行**不构造**，剩余行重新分配高度 |
 * | 普通人（无 title / seqLabel） | 氛围行按存在的字段拼接，空串不画 |
 * | 没有头像 | 名字首字纹章兜底，不留空洞 |
 * | 教会名 / 单行字段过多 | 参与缩字号，永不溢出画布 |
 *
 * 判据很硬：**任何字段都不许决定另一个字段的坐标**。行距由「剩余垂直空间 ÷ 实际行数」
 * 算出来，所以少一行不留空洞，多一行不叠字。
 */

import type { CharacterCardData } from './render.ts';

/* ------------------------------------------------------------------ *
 * 调色（用户给的配色口径：冷灰 + 暗黄铜 + 幽蓝银星光）
 * ------------------------------------------------------------------ */

const BRASS = '#c9a961';
const STAR_BLUE = '#8fb8e6';
const STAR_PALE = '#cfe4ff';

/** 途径主色：只染刻度与头像光晕，不染面 */
const ACCENT: Record<string, string> = {
  seer: '#9fc4e8', warrior: '#c08a6a', sleepless: '#93a8c4', sailor: '#5a94a6',
  perfect: '#c2a565', reader: '#9184b8', mother: '#7fa06a', mortal: '#a89878',
};

/* ------------------------------------------------------------------ *
 * 画布与几何
 * ------------------------------------------------------------------ */

const W = 620, H = 1000;
/** 头像与星盘同心 */
const CX = 310, CY = 318;
/** 头像半径。直径 472 < 头像原图 640 —— 超过原图尺寸就是放大，脸会糊 */
const AR = 236;
/**
 * 数据层的弧心，远在画面上方。
 *
 * 为什么不用星盘的圆心：以 (310,318) 为心、r≈370 排一行长名字，两端会爬升 58px
 * （实测「莫雷蒂」直接飘到右上角）。弧心挪到 y=-180、半径 870 之后整行只弯 9px ——
 * 既不是横排，又读得出来。
 */
const DCX = 310, DCY = -180;
/** 数据区上下界；行高在区间内按实际行数分配 */
const DATA_TOP = 664, DATA_BOTTOM = 970;
/** 单行最多占多少像素（左右各留 40） */
const DATA_MAX_PX = 540;

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 按魔数定 MIME，不看扩展名 —— qlogo 的 /qqapp/<appid>/<openid>/640 返回的是 JPEG，
 * 哪怕你把它存成 .png。按扩展名写 data:image/png，Chromium 会静默丢弃这张图。
 */
export function sniffMime(bytes: Buffer): string {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length > 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return 'image/png';
}

export function dataUri(bytes: Buffer): string {
  return 'data:' + sniffMime(bytes) + ';base64,' + bytes.toString('base64');
}

const rad = (d: number): number => (d * Math.PI) / 180;
const f1 = (n: number): string => n.toFixed(1);
/** 标签自带前缀符号（"† 生命"），画面上不要 */
const bare = (label: string): string => label.replace(/^[^\p{L}\p{N}]+/u, '');

/** 固定种子的伪随机：星光每次出图位置必须一致，否则同一张卡两天两个样 */
function seeded(seed: number): () => number {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

const ptOn = (r: number, t: number, cx: number, cy: number): [number, number] =>
  [cx + r * Math.cos(rad(t)), cy + r * Math.sin(rad(t))];

/* ------------------------------------------------------------------ *
 * 沿环排字
 * ------------------------------------------------------------------ */

interface RingOpts {
  cx: number; cy: number; r: number;
  t0: number;
  dir: 1 | -1;
  color: string;
  weight: number;
  /** 远端淡化：星盘上的氛围字要若隐若现，数据层的字必须清晰 */
  fade: number;
  /** 近端/远端大小差；0 = 不做透视缩放 */
  depth: number;
  /** 量宽超限时由调用方传入的缩字号系数 */
  scale?: number;
}

const degPerChar = (size: number, spacing: number, r: number): number => (size * spacing) / ((r * Math.PI) / 180);
const measureArc = (text: string, size: number, spacing: number, r: number): number =>
  [...text].reduce((a) => a + degPerChar(size, spacing, r), 0);

/** 把一串字沿环排：每个字单独定位、按切线旋转、按接近度缩放与明暗 */
function textOnRing(text: string, size: number, spacing: number, o: RingOpts): { html: string; tEnd: number } {
  const sc = o.scale ?? 1;
  const out: string[] = [];
  let t = o.t0;
  for (const ch of [...text]) {
    const step = o.dir * degPerChar(size * sc, spacing, o.r);
    if (ch !== ' ') {
      const [x, y] = ptOn(o.r, t, o.cx, o.cy);
      const [x2, y2] = ptOn(o.r, t + o.dir * 0.6, o.cx, o.cy);
      let ang = (Math.atan2(y2 - y, x2 - x) * 180) / Math.PI;
      if (ang > 90) ang -= 180;
      if (ang < -90) ang += 180;
      const prox = (Math.sin(rad(t)) + 1) / 2;
      out.push('<text transform="translate(' + f1(x) + ',' + f1(y) + ') rotate(' + f1(ang) + ') scale(' +
        ((1 - o.depth) + prox * o.depth).toFixed(3) + ')" font-size="' + (size * sc).toFixed(1) +
        '" fill="' + o.color + '" opacity="' + ((0.24 + prox * 0.76) * o.fade).toFixed(3) +
        '" text-anchor="middle" dominant-baseline="central" style="font-weight:' + o.weight + '">' + escapeHtml(ch) + '</text>');
    }
    t += step;
  }
  return { html: out.join(''), tEnd: t };
}

/** 一段数据：文字 / 字号 / 颜色 / 字重 / 字距 */
type Part = [string, number, string, number, number];

/**
 * 数据行 = **量宽 → 超限就整体缩字号 → 按弧居中**。
 *
 * 这三步就是「排版不崩」的全部：字号不是常量，而是由这份内容在弧上占多宽反推出来的。
 * 名字从 2 字变 10 字、数值从 1 位变 3 位，只是让 scale 变小，坐标一个都不动。
 */
function dataRow(y: number, parts: Part[], gapDeg = 1.4, fade = 1): string {
  const r = y - DCY;
  const maxDeg = DATA_MAX_PX / ((r * Math.PI) / 180);
  const gaps = gapDeg * Math.max(0, parts.length - 1);
  const raw = parts.reduce((a, [txt, size, , , sp]) => a + measureArc(txt, size, sp, r), 0) + gaps;
  const scale = raw > maxDeg ? maxDeg / raw : 1;

  /*
   * 逐字排位置，然后按**首末字的实际 x** 居中。
   *
   * 为什么不能"按字步长总和居中"：一行的宽度是 **n−1** 个步长（首字中心 → 末字中心），
   * 不是 n 个。拿 n 个去算，整行会偏左**半个字** —— 实测名字行偏 36px、代价行 24px、
   * 页脚行 11px，字号越大偏得越多。这是量出来的，不是估的（扫描亮像素求 bbox）。
   */
  const slots: Array<{ ch: string; t: number; size: number; color: string; weight: number; sp: number }> = [];
  let t = 0;
  for (const [txt, size, color, weight, sp] of parts) {
    for (const ch of [...txt]) {
      if (ch !== ' ') slots.push({ ch, t, size, color, weight, sp });
      t -= degPerChar(size * scale, sp, r);
    }
    t -= gapDeg * scale;
  }
  if (slots.length === 0) return '';
  const xAt = (off: number): number => DCX + r * Math.cos(rad(90 + off));
  const pxPerDeg = (r * Math.PI) / 180;
  // 迭代三次足够：这个小角度范围里 x(t) 几乎是线性的
  for (let i = 0; i < 3; i += 1) {
    const first = slots[0]!;
    const last = slots[slots.length - 1]!;
    const shift = (xAt(first.t) + xAt(last.t)) / 2 - DCX;
    if (Math.abs(shift) < 0.3) break;
    for (const s of slots) s.t += shift / pxPerDeg;
  }

  return slots.map((s) => {
    const [x, y2] = ptOn(r, 90 + s.t, DCX, DCY);
    return textOnRing(s.ch, s.size, s.sp, {
      cx: DCX, cy: DCY, r, t0: 90 + s.t, dir: -1, color: s.color, weight: s.weight, fade, depth: 0.22, scale,
    }).html;
  }).join('');
}

/** 一行的高度需求，用来分配行距 */
const rowHeight = (parts: Part[]): number => Math.max(...parts.map((p) => p[1])) * 1.44;

/* ------------------------------------------------------------------ *
 * 星盘 —— 没有 AI 底图时的兜底美术
 *
 * 说清楚：这几段画出来的只是「干净的几何图形」，做旧黄铜、灰雾、纸张颗粒
 * 那种质感它给不了。它的职责是**没素材时不是一张白板**，不是替代出图工具。
 * ------------------------------------------------------------------ */

const circle = (r: number, o: number, w: number, dash = ''): string =>
  '<circle cx="' + CX + '" cy="' + CY + '" r="' + r + '" fill="none" stroke="' + BRASS + '" stroke-opacity="' + o +
  '" stroke-width="' + w + '"' + (dash ? ' stroke-dasharray="' + dash + '"' : '') + '/>';

/** 刻度环：每 6 根加长。近端更亮更长，让环有前后而非常量 */
function ticks(r: number, count: number, len: number, wide: number, o: number, t1 = 0, t2 = 360): string {
  const out: string[] = [];
  for (let i = 0; i <= count; i += 1) {
    const t = t1 + ((t2 - t1) * i) / count;
    const [x1, y1] = ptOn(r, t, CX, CY);
    const [x2, y2] = ptOn(r + len, t, CX, CY);
    const major = i % 6 === 0;
    out.push('<line x1="' + f1(x1) + '" y1="' + f1(y1) + '" x2="' + f1(x2) + '" y2="' + f1(y2) +
      '" stroke="' + BRASS + '" stroke-width="' + (major ? wide * 1.7 : wide) + '" opacity="' + (major ? Math.min(1, o * 1.7) : o) + '"/>');
  }
  return out.join('');
}

/** 十二宫分区 + 不该有名字的符号 */
function zodiac(r1: number, r2: number, o: number): string {
  const out: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const t = (360 * i) / 12 - 90;
    const [x1, y1] = ptOn(r1, t, CX, CY);
    const [x2, y2] = ptOn(r2, t, CX, CY);
    out.push('<line x1="' + f1(x1) + '" y1="' + f1(y1) + '" x2="' + f1(x2) + '" y2="' + f1(y2) +
      '" stroke="' + BRASS + '" stroke-opacity="' + o + '" stroke-width="0.9"/>');
    const [gx, gy] = ptOn((r1 + r2) / 2, t + 15, CX, CY);
    const s = 6;
    const k = i % 4;
    const shapes = [
      'M' + gx + ' ' + (gy - s) + ' L' + (gx + s * 0.8) + ' ' + (gy + s * 0.6) + ' L' + (gx - s * 0.8) + ' ' + (gy + s * 0.6) + ' Z',
      'M' + (gx - s) + ' ' + gy + ' L' + (gx + s) + ' ' + gy + ' M' + gx + ' ' + (gy - s) + ' L' + gx + ' ' + (gy + s),
      'M' + gx + ' ' + (gy - s * 0.9) + ' L' + (gx + s * 0.9) + ' ' + gy + ' L' + gx + ' ' + (gy + s * 0.9) + ' L' + (gx - s * 0.9) + ' ' + gy + ' Z',
      'M' + (gx - s) + ' ' + (gy - s) + ' L' + (gx + s) + ' ' + (gy + s) + ' M' + (gx + s) + ' ' + (gy - s) + ' L' + (gx - s) + ' ' + (gy + s),
    ];
    out.push('<path d="' + shapes[k] + '" fill="none" stroke="' + BRASS + '" stroke-opacity="' + (o * 1.5) + '" stroke-width="1.1"/>');
  }
  return out.join('');
}

/** 幽蓝星点。只画点的话读起来是噪点，加十字芒才读成「星」 */
function starfield(): string {
  const rnd = seeded(20260928);
  const out: string[] = [];
  for (let i = 0; i < 78; i += 1) {
    const t = rnd() * 360;
    const r = AR + 10 + rnd() * 120;
    const [x, y] = ptOn(r, t, CX, CY);
    if (x < -8 || x > W + 8 || y < -8 || y > H + 8) continue;
    const near = Math.max(0.18, 1 - Math.abs(r - (AR + 58)) / 88);
    const sz = 0.5 + rnd() * 1.8 * near;
    const op = (0.08 + rnd() * 0.5) * near;
    const blue = rnd() > 0.7 ? STAR_PALE : STAR_BLUE;
    out.push('<circle cx="' + f1(x) + '" cy="' + f1(y) + '" r="' + sz.toFixed(2) + '" fill="' + blue + '" opacity="' + op.toFixed(3) + '"/>');
    if (sz > 1.45) {
      const L = sz * 4.2;
      out.push('<path d="M' + f1(x - L) + ' ' + f1(y) + 'L' + f1(x + L) + ' ' + f1(y) + 'M' + f1(x) + ' ' + f1(y - L) +
        'L' + f1(x) + ' ' + f1(y + L) + '" stroke="' + STAR_PALE + '" stroke-width="0.6" opacity="' + (op * 0.5).toFixed(3) + '"/>');
      out.push('<circle cx="' + f1(x) + '" cy="' + f1(y) + '" r="' + (sz * 3.6).toFixed(1) + '" fill="' + STAR_BLUE + '" opacity="' + (op * 0.14).toFixed(3) + '"/>');
    }
  }
  return out.join('');
}

/* ------------------------------------------------------------------ *
 * 主模板
 * ------------------------------------------------------------------ */

export interface CardAssets {
  /** 头像的 data URI；没有就画首字纹章 */
  avatar?: string;
  /** AI 出的卡面底图；给了就让位，程序化星盘与雾全部不画 */
  background?: string;
}

export function cardHtml(data: CharacterCardData, assets: CardAssets = {}): string {
  const accent = ACCENT[data.pathway ?? 'mortal'] ?? ACCENT.mortal!;
  const hasArt = assets.background !== undefined;

  /* ── 数据行：只构造**存在**的行，空字段不留占位 ─────────────── */
  const specs: Part[][] = [];
  let cityRow = -1;
  specs.push([[data.name, 38, '#f6f1e4', 900, 1.02]]);
  // 地点紧跟名字：它是"我在哪"，属于身份而不是数值，混在资源行里没人看得出
  if (data.city !== undefined && data.city.length > 0) {
    /*
     * 定位针用 SVG 画，不用 emoji：📍 会被系统渲染成**粉红色**，
     * 一张暗金配墨绿的卡上突然一个粉图钉，很跳。这里跟着金线走。
     */
    const pin = '<path d="M0 -20 C-8.5 -20 -15 -13 -15 -4.5 C-15 6 0 18 0 18 C0 18 15 6 15 -4.5 C15 -13 8.5 -20 0 -20 Z" ' +
      'fill="none" stroke="#c9a961" stroke-width="2.4" stroke-linejoin="round"/>' +
      '<circle cx="0" cy="-5" r="5.4" fill="#c9a961" fill-opacity="0.5"/>';
    cityRow = specs.length;
    specs.push([[data.city, 15, '#b9cdbd', 400, 1.1]]);
  }

  const bars = data.bars ?? [];
  const first = bars[0];
  if (first !== undefined) {
    specs.push([
      [bare(first.label), 15, BRASS, 400, 1.12],
      [String(first.value), 56, '#f8f3e8', 900, 1.0],
      ['/' + first.max, 14, '#8d8a7e', 400, 0.7],
    ]);
  }
  if (bars.length > 1) {
    const parts: Part[] = [];
    bars.slice(1).forEach((b, i) => {
      if (i > 0) parts.push(['·', 15, '#6a6860', 400, 1.0]);
      parts.push([bare(b.label), 19, BRASS, 500, 1.06]);
      parts.push([String(b.value), 22, '#eae4d4', 700, 1.0]);
    });
    specs.push(parts);
  }
  const costs = data.costs ?? [];
  if (costs.length > 0) {
    const parts: Part[] = [];
    costs.forEach((c, i) => {
      if (i > 0) parts.push(['·', 13, '#5f5d56', 400, 1.0]);
      parts.push([bare(c.label), 15, '#b9b3a4', 500, 1.06]);
      parts.push([c.value, 17, '#d9d3c4', 700, 1.0]);
    });
    specs.push(parts);
  }
  const fields = data.fields ?? [];
  const metaText = fields.map((f) => bare(f.label) + ' ' + f.value).join('    ');
  const metaJoined = [metaText, data.identity].filter((s) => s !== undefined && s.length > 0).join('    ·    ');
  if (metaJoined.length > 0) specs.push([[metaJoined, 12, '#9d9a8c', 400, 1.0]]);
  if (data.footnote !== undefined && data.footnote.length > 0) specs.push([[data.footnote, 11, '#78766c', 400, 1.0]]);
  if (data.quote !== undefined && data.quote.length > 0) specs.push([[data.quote, 15, '#c9c2ae', 400, 1.06]]);
  specs.push([['/状态', 14, BRASS, 500, 1.0], ['/晋升', 14, BRASS, 500, 1.0], ['/探索', 14, BRASS, 500, 1.0], ['/帮助', 14, BRASS, 500, 1.0]]);

  /* 行距 = 剩余垂直空间 ÷ 实际行数。少一行不留空洞，多一行不叠字 */
  const heights = specs.map(rowHeight);
  const used = heights.reduce((a, b) => a + b, 0);
  const slack = Math.max(0, DATA_BOTTOM - DATA_TOP - used);
  const gap = specs.length > 1 ? slack / (specs.length - 1) : 0;
  let cursor = DATA_TOP;
  const rowY: number[] = [];
  const dataRows = specs.map((spec, i) => {
    const h = heights[i] ?? 0;
    const y = cursor + h / 2;
    rowY.push(y);
    cursor += h + gap;
    return dataRow(y, spec);
  }).join('');
  /*
   * 定位针画在城市名**正上方**，不塞进行内。
   * 不用 emoji：📍 由系统字体渲染成粉红色，一张暗金配墨绿的卡上突然一个粉图钉，很跳。
   */
  /*
   * 定位针和城市名**并排**，在它左边。
   * 上一版把针放在城市行上方 27px —— 行距不够，直接压在名字的"经"字上。
   * 城市名这一行是居中的，所以它的左边界能从字数反推出来。
   */
  const cityPin = cityRow >= 0 && data.city !== undefined
    // -26 而不是 -13：图标自身半宽约 11.7px（15×0.78），减 13 的话只剩 1.3px 缝，看着像粘在一起
    ? '<g transform="translate(' + (CX - (data.city.length * 15 * 1.1) / 2 - 26) + ' ' + (rowY[cityRow] ?? 0) + ') scale(0.78)">' +
      '<path d="M0 -20 C-8.5 -20 -15 -13 -15 -4.5 C-15 6 0 18 0 18 C0 18 15 6 15 -4.5 C15 -13 8.5 -20 0 -20 Z" ' +
      'fill="none" stroke="#c9a961" stroke-opacity="0.8" stroke-width="2.6" stroke-linejoin="round"/>' +
      '<circle cx="0" cy="-5" r="5.2" fill="#c9a961" fill-opacity="0.45"/></g>'
    : '';

  /*
   * ── 氛围层：头像的**上方**与**下方**各一条弧 ────────────────────
   *
   * 为什么不在左右两侧：头像直径 472 之后，左右各只剩 74px。上一版把途径字挂在
   * AR+78 的弧上，算出来 x=3 —— 直接贴到画边，「还没有途径」被裁掉半行。
   * 上下各有 82px / 110px，放得下，而且走 dataRow 同一套量宽逻辑，同样不会溢出。
   */
  const amb: string[] = [];
  const pathwayTag = data.pathwayLine.split('·')[0]?.trim() ?? '';
  const seqText = [data.seqLabel, data.title].filter((s) => s !== undefined && s.length > 0).join(' · ');
  const ambTop = [pathwayTag, seqText].filter((s) => s.length > 0).join('    ·    ');
  if (ambTop.length > 0) amb.push(dataRow(46, [[ambTop, 15, '#cfd8cd', 400, 1.24]], 0, 0.62));
  const ambBottom = [data.title, data.seqNote].filter((s) => s !== undefined && s.length > 0).join('    ·    ');
  if (ambBottom.length > 0) amb.push(dataRow(608, [[ambBottom, 13, '#cfd8cd', 400, 1.2]], 0, 0.46));

  /*
   * 星盘：一圈**有厚度的黄铜环**，不是几条细线。
   *
   * 照着用户给的那张 AI 底图改的：环本身是一圈金属带子（环心半径 AR+34、带宽 30），
   * 带子上压刻度与十二宫，环内是暗的，头像嵌在环里。
   * 上一版用三条 1px 细环 —— 那个读起来是"靶子"，不是"盘"。
   */
  const chartBack = '<g>' +
    '<circle cx="' + CX + '" cy="' + CY + '" r="' + (AR + 34) + '" fill="none" stroke="#4a3c1c" stroke-opacity="0.42" stroke-width="30"/>' +
    '<circle cx="' + CX + '" cy="' + CY + '" r="' + (AR + 34) + '" fill="none" stroke="#2a2212" stroke-opacity="0.55" stroke-width="40"/>' +
    circle(AR + 19, 0.34, 2) + circle(AR + 50, 0.3, 1.5) + circle(AR + 64, 0.09, 1, '2 10') +
    zodiac(AR + 19, AR + 50, 0.18) + ticks(AR + 50, 72, 10, 0.9, 0.2) + '</g>';
  const chartFront = '<g>' + circle(AR + 19, 0.46, 2.2) + circle(AR + 50, 0.4, 1.8) +
    ticks(AR + 50, 36, 13, 1.2, 0.34, 0, 180) + '</g>';

  const avatarLayer = assets.avatar !== undefined
    ? '<img src="' + assets.avatar + '" alt="" style="width:100%;height:100%;object-fit:cover;display:block;filter:saturate(.55) brightness(.9) contrast(1.05) sepia(.24)">'
    : '<div class="monogram">' + escapeHtml(data.name.slice(0, 1)) + '</div>';

  const artBackdrop = hasArt
    ? '<div class="art-bg" style="background-image:url(' + assets.background + ')"></div><div class="art-scrim"></div>'
    : '<div class="base"></div>' +
      '<svg class="layer" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" style="z-index:2">' + starfield() + '</svg>' +
      '<svg class="layer" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" style="z-index:2">' + chartBack + '</svg>';

  const artOverlay = hasArt ? '' :
    '<svg class="layer" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" style="z-index:5">' + chartFront + '</svg>' +
    shadeLayer() + fogLayer() + '<div class="fogblob b1"></div><div class="fogblob b2"></div><div class="fogblob b3"></div>';

  return [
    '<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>',
    style(accent, hasArt),
    '</style></head><body><div class="stage">',
    artBackdrop,
    '<div class="art' + (assets.avatar !== undefined ? '' : ' plain') + '">' + avatarLayer +
      '<div class="grade"></div><div class="hue"></div><div class="vig"></div></div>',
    amb.length > 0 ? '<svg class="layer" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" style="z-index:4">' + amb.join('') + '</svg>' : '',
    artOverlay,
    '<div class="dataBg"></div>',
    '<svg class="dataTex" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '">' + cityPin + dataRows + '</svg>',
    '<div class="grain"></div>',
    '</div></body></html>',
  ].join('');
}

/* ------------------------------------------------------------------ *
 * 样式
 * ------------------------------------------------------------------ */

/** 雾的云纹：feTurbulence 的分形噪声，alpha 由 R 通道映射 —— 决定雾哪块浓、哪块淡 */
/**
 * 雾的丝：**各向异性**的分形噪声。
 *
 * x 方向频率压到 0.0022、y 方向留 0.026 —— 差十倍，噪声就沿水平**拉成丝**，那才是烟。
 * 频率给成 0.007/0.011 那种近乎各向同性的值，出来是一块块的斑，看着像给画面打了个白底。
 * 两层叠：粗丝决定走向，细丝加层次。
 */
/**
 * 雾 = 内联 SVG 的分形噪声，**各向异性**才拉得出丝。
 *
 * x 方向频率 0.0022、y 方向 0.026，差十倍 —— 噪声沿水平拉成条，那才是烟。
 * 上一版给的是 0.007/0.011 这种近乎各向同性的值，出来是一块块的斑，看着就是给画面打了个白底。
 *
 * 为什么不写成 CSS 的 data URI：那一串要同时躲开 %、井号、双引号、反斜杠四种转义，写一次错一次。
 * 内联 svg 是普通标记，一个转义都不用。
 */
/**
 * 雾里的人影：**人形轮廓**，不是头像重影（这两个差得很远 —— 后者只是把脸糊一遍，
 * 前者才是"雾里站着别的东西"）。一个披长衣的剪影，模糊 + 极淡 + 下半身融进雾。
 * 位置挑在雾最浓的地方，太小太正会变成装饰图案。
 */
function shadeLayer(): string {
  const shade = (x: number, y: number, s: number, o: number, blur: number, flip: boolean): string =>
    '<g transform="translate(' + x + ' ' + y + ') scale(' + (flip ? -s : s) + ' ' + s + ')" opacity="' + o +
    '" filter="url(#shadeBlur' + blur + ')">' +
    '<ellipse cx="0" cy="-62" rx="15" ry="19"/>' +
    '<path d="M-15 -50 C-26 -44 -36 -30 -41 -8 L-48 78 L48 78 L41 -8 C36 -30 26 -44 15 -50 Z"/>' +
    '</g>';
  return '<svg class="shades" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '">' +
    '<defs>' +
    '<filter id="shadeBlur8" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="8"/></filter>' +
    '<filter id="shadeBlur14" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="14"/></filter>' +
    // 下半身融进雾：人影不该有脚，有脚就站实了
    '<linearGradient id="shadeFade" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#fff" stop-opacity="0.95"/>' +
    '<stop offset="0.55" stop-color="#fff" stop-opacity="0.5"/>' +
    '<stop offset="1" stop-color="#fff" stop-opacity="0"/>' +
    '</linearGradient>' +
    '<mask id="shadeMask"><rect width="' + W + '" height="' + H + '" fill="url(#shadeFade)"/></mask>' +
    '</defs>' +
    // 影子比雾**暗**才有'挡在雾里'的感觉；用 screen 会把它做成发光的，那就是鬼火不是人影
    '<g fill="#232b24" mask="url(#shadeMask)">' +
    // 位置是被几何逼出来的：头像直径 472 之后，只有左右各 74px、和头像下缘到数据区那 110px
    // 是空的。放在头像圆里的影子会被人像整个盖住（第一次就是这么白做的）。
    shade(62, 262, 0.36, 0.55, 8, false) +
    shade(64, 640, 0.42, 0.62, 10, false) +
    shade(558, 626, 0.38, 0.58, 10, true) +
    '</g></svg>';
}

function fogLayer(): string {
  const rect = (id: string, o: string): string =>
    '<rect width="' + W + '" height="' + H + '" filter="url(#' + id + ')" opacity="' + o + '"/>';
  return '<svg class="fogsvg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" preserveAspectRatio="none">' +
    '<defs>' +
    '<filter id="fogA" x="0" y="0" width="100%" height="100%">' +
    '<feTurbulence type="fractalNoise" baseFrequency="0.0022 0.026" numOctaves="4" seed="11"/>' +
    '<feColorMatrix type="matrix" values="0 0 0 0 0.90  0 0 0 0 0.93  0 0 0 0 0.90  1.25 0 0 0 -0.55"/>' +
    '</filter>' +
    '<filter id="fogB" x="0" y="0" width="100%" height="100%">' +
    '<feTurbulence type="fractalNoise" baseFrequency="0.004 0.055" numOctaves="3" seed="29"/>' +
    '<feColorMatrix type="matrix" values="0 0 0 0 0.92  0 0 0 0 0.95  0 0 0 0 0.92  1.0 0 0 0 -0.62"/>' +
    '</filter>' +
    '</defs>' + rect('fogA', '0.9') + rect('fogB', '0.55') + '</svg>';
}

function style(accent: string, hasArt: boolean): string {
  return [
    ':root{--serif:"Noto Serif SC","Source Han Serif SC",SimSun,serif;--accent:' + accent + ';}',
    '*{margin:0;padding:0;box-sizing:border-box}',
    'html,body{width:' + W + 'px;height:' + H + 'px;overflow:hidden;background:#000}',
    '.stage{position:relative;width:' + W + 'px;height:' + H + 'px;overflow:hidden;background:#0c100e;',
    'font-family:var(--serif);color:#eee7d6;-webkit-font-smoothing:antialiased}',
    hasArt
      ? '.art-bg{position:absolute;inset:0;z-index:0;background-size:cover;background-position:center}'
      + '.art-scrim{position:absolute;inset:0;z-index:1;background:linear-gradient(180deg,rgba(6,9,7,.62) 0%,rgba(6,9,7,.34) 30%,rgba(6,9,7,.78) 62%,rgba(5,8,6,.96) 100%)}'
      : '.base{position:absolute;inset:0;z-index:0;background:radial-gradient(122% 70% at 48% 28%,#182019 0%,#0f1511 46%,#070a08 100%)}',
    '.layer{position:absolute;left:0;top:0;pointer-events:none}',
    '.art{position:absolute;left:' + (CX - AR) + 'px;top:' + (CY - AR) + 'px;width:' + AR * 2 + 'px;height:' + AR * 2 + 'px;',
    'border-radius:50%;overflow:hidden;isolation:isolate;z-index:3;box-shadow:0 0 70px 22px rgba(6,9,7,.85)}',
    '.art.plain{background:radial-gradient(circle at 50% 42%,#1b241d 0%,#101610 56%,#080b09 100%)}',
    '.grade{position:absolute;inset:0;background:linear-gradient(165deg,rgba(22,42,34,.34),rgba(6,9,7,.56));mix-blend-mode:multiply}',
    '.hue{position:absolute;inset:0;background:var(--accent);mix-blend-mode:color;opacity:.22}',
    '.vig{position:absolute;inset:0;border-radius:50%;',
    'background:radial-gradient(circle at 50% 40%,transparent 32%,rgba(5,8,6,.4) 66%,rgba(8,12,9,.88) 92%,#0c100e 100%)}',
    '.monogram{width:100%;height:100%;display:flex;align-items:center;justify-content:center;',
    'font-size:200px;font-weight:900;line-height:1;padding-bottom:.1em;',
    'background:linear-gradient(178deg,#e8d5a2,#8b7748);-webkit-background-clip:text;background-clip:text;',
    'color:transparent;filter:drop-shadow(0 0 34px rgba(201,169,97,.4))}',
    /*
     * 雾 = 分形噪声的浓淡 × 径向的形状。
     *
     * 上一版只写了一层 radial-gradient —— 那出来的是一圈**均匀的白**，
     * 视觉上就是"给画面打了个白底"，不是雾。真实雾气的关键是**浓淡不均**，
     * 所以叠一张 feTurbulence 的云纹：噪声决定哪块浓、哪块淡，径向决定雾在哪。
     */
    // 雾是 SVG 画的（见 fogLayer）。mask 决定雾在哪 —— 中心 54% 掏空，盖住脸就成磨砂玻璃了
    // 人影压在雾**之上**：暗剪影浮在雾面，下半身由 shadeMask 渐隐融进雾里
    '.shades{position:absolute;z-index:7;left:0;top:0;pointer-events:none}',
    '.fogsvg{position:absolute;z-index:6;left:-34px;top:-34px;width:' + (W + 68) + 'px;height:' + (H + 68) + 'px;',
    'pointer-events:none;mix-blend-mode:screen;opacity:.52;filter:blur(7px);',
    '-webkit-mask-image:radial-gradient(ellipse 46% 40% at 50% 42%,transparent 54%,#000 68%,#000 82%,rgba(0,0,0,.45) 92%,transparent 100%);',
    'mask-image:radial-gradient(ellipse 46% 40% at 50% 42%,transparent 54%,#000 68%,#000 82%,rgba(0,0,0,.45) 92%,transparent 100%)}',
    '.fogblob{position:absolute;z-index:6;pointer-events:none;filter:blur(28px)}',
    '.b1{left:-130px;top:150px;width:310px;height:420px;background:radial-gradient(closest-side,rgba(228,234,230,.20),transparent)}',
    '.b2{right:-130px;top:150px;width:310px;height:420px;background:radial-gradient(closest-side,rgba(228,234,230,.20),transparent)}',
    '.b3{left:110px;right:110px;bottom:-160px;height:300px;background:radial-gradient(ellipse at 50% 50%,rgba(228,234,230,.16),transparent)}',
    '.dataBg{position:absolute;z-index:8;left:0;right:0;bottom:0;height:404px;pointer-events:none;',
    'background:linear-gradient(180deg,transparent 0%,rgba(8,12,9,.66) 13%,rgba(7,10,8,.92) 30%,rgba(5,8,6,.98) 100%)}',
    '.dataTex{position:absolute;z-index:9;left:0;top:0;pointer-events:none}',
    '.grain{position:absolute;z-index:20;inset:0;pointer-events:none;mix-blend-mode:overlay;opacity:.32;',
    'background-image:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'180\' height=\'180\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'.9\' numOctaves=\'3\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'180\' height=\'180\' filter=\'url(%23n)\' opacity=\'.55\'/%3E%3C/svg%3E")}',
  ].join('');
}

