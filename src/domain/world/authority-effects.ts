/**
 * **权柄的读取器（M2.87）** —— 把「神明出手了」翻译成各处能用的一句查询。
 *
 * ## 用户的要求
 *
 * > 「神明的权柄是能够影响整个世界的，这点你要设计的让玩家都能直白的感受到神明权柄的强大」
 *
 * 「直白地感受到」意味着三件事同时成立：
 *
 *   ① **看得见** —— 玩家在自己的界面里能看到「现在有谁在出手」（`.世界` / `.状态`）；
 *   ② **摸得到** —— 他的**日常动作**被改写了（这一带占卜不灵、物资更贵、理智掉得更快）；
 *   ③ **不是随机事件** —— 权柄是**持续一段时间的处境**，不是一闪而过的播报。
 *
 * 而在这之前只有 ① 的一半（一条播报）和天气。
 *
 * ## 为什么集中在这里读
 *
 * 每个读点各自写一遍 `overrideValueOf(kind, ...)` 会有两个问题：
 *   · 值类型各异（'1.5' / '占卜' / '0.7'），各写各的解析必然分叉；
 *   · 加一个新维度时不知道该改哪几处 —— 漏一处的症状是「内容写了、世界没变」。
 *
 * 所以：**`world_overrides` 是存储，这里是语义**。读的人只调这几个函数。
 */

/** 读覆盖的最小接口 —— 只要这一个方法，便于测试替身 */
export interface OverrideReader {
  overrideValueOf(kind: string, scope: string, now: number): string | null;
  /** 同一维度的全部生效值 —— 禁令要用并集，取最新会让先写的那条无声失效 */
  overrideValuesOf?: (kind: string, scope: string, now: number) => string[];
  activeOverrides(now: number): Array<{ kind: string; scope: string; value: string; until: number; source: string }>;
}

/* ═══════════ 维度一：禁令（banCommand）═══════════ */

/**
 * 这一带有没有禁止某条命令。
 *
 * 值形状：命令名（如 `占卜`），支持 `|` 分隔多个。
 * 命中时返回**权柄给的说明**（由调用方拼进回执），没命中返回 null。
 *
 * ⚠️ 这条是最「直白」的一个维度：玩家发命令，系统回一句「这里不行，而且不行的原因是别人」——
 * 那一下的体感远强于读一条播报。
 */
export function commandBanAt(
  reader: OverrideReader,
  locationId: string | null,
  commandName: string,
  now: number,
): string | null {
  if (locationId === null) return null;
  /*
   * ⚠️ 用**全部**生效值取并集，不是取最新一条。
   *
   * 取最新的后果：两个神明同时出手时，先写的那条禁令**无声失效** ——
   * 玩家会发现「上次这里不能占卜，这次又能了」，而没有任何日志解释为什么。
   */
  const raws = reader.overrideValuesOf !== undefined
    ? reader.overrideValuesOf('banCommand', locationId, now)
    : (() => { const one = reader.overrideValueOf('banCommand', locationId, now); return one === null ? [] : [one]; })();
  const hit: string[] = [];
  for (const raw of raws) {
    const banned = raw.split('|').map((s) => s.trim()).filter((s) => s.length > 0);
    if (banned.includes(commandName)) hit.push(raw);
  }
  return hit.length > 0 ? hit.join('|') : null;
}

/* ═══════════ 维度二：疯狂倍率（madRate）═══════════ */

/**
 * 这一带的疯狂增长倍率（默认 1）。
 *
 * 值形状：一个正数（`1.5` = 涨得快一半，`0.5` = 减半）。
 * 解析不了就退回 1 —— **宁可没效果，也不要因为一个脏值把玩家的理智乘成 NaN**。
 */
export function madRateAt(reader: OverrideReader, locationId: string | null, now: number): number {
  if (locationId === null) return 1;
  const raw = reader.overrideValueOf('madRate', locationId, now);
  if (raw === null) return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1;
  // 上限压住：神明能让理智掉得更快，但不该一次把玩家按死
  return Math.max(0.1, Math.min(4, n));
}

/* ═══════════ 维度三：物价（priceFactor）═══════════ */

/**
 * 这一带的物价倍率（默认 1）。
 *
 * `0.7` = 打了七折（大地母神让东西变便宜），`1.5` = 涨五成（深渊收代价）。
 */
export function priceFactorAt(reader: OverrideReader, locationId: string | null, now: number): number {
  if (locationId === null) return 1;
  const raw = reader.overrideValueOf('priceFactor', locationId, now);
  if (raw === null) return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.max(0.1, Math.min(10, n));
}

/** 把一个价格按倍率算出来（至少 1 便士 —— 免费的定价会让 `.买` 变成刷钱漏洞）*/
export function applyPriceFactor(penny: number, factor: number): number {
  return Math.max(1, Math.round(penny * factor));
}

/* ═══════════ 维度四：遭遇（encounterRate）═══════════ */

/**
 * 这一带的遭遇倍率（默认 1）。
 *
 * 值形状同 madRate。危险地带被权柄压过时，怪会变多变少。
 */
export function encounterRateAt(reader: OverrideReader, locationId: string | null, now: number): number {
  if (locationId === null) return 1;
  const raw = reader.overrideValueOf('encounterRate', locationId, now);
  if (raw === null) return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 1;
  return Math.max(0, Math.min(5, n));
}

/* ═══════════ 玩家看得见的那一层 ═══════════ */

/** 一条正在生效的权柄（给 `.世界` / `.状态` 用） */
export interface ActiveAuthority {
  /** 来源（`authority:<id>`）—— 从里面取回权柄 id */
  source: string;
  kinds: string[];
  scope: string;
  until: number;
}

/** 当前生效的权柄，按来源归并（同一个权柄会写多条覆盖：天气 + 若干 effects） */
export function activeAuthorities(reader: OverrideReader, now: number): ActiveAuthority[] {
  const bySource = new Map<string, ActiveAuthority>();
  for (const o of reader.activeOverrides(now)) {
    if (!o.source.startsWith('authority:')) continue;
    const cur = bySource.get(o.source) ?? { source: o.source, kinds: [], scope: o.scope, until: o.until };
    if (!cur.kinds.includes(o.kind)) cur.kinds.push(o.kind);
    // 取最晚的到期时刻：一个权柄的几条覆盖是同刻写的，但取 max 更稳
    cur.until = Math.max(cur.until, o.until);
    bySource.set(o.source, cur);
  }
  return [...bySource.values()].sort((a, b) => a.until - b.until);
}

/** 把剩余小时数说成人话（给玩家看） */
export function hoursLeft(until: number, now: number): string {
  const ms = until - now;
  if (ms <= 0) return '即将结束';
  const h = ms / 3_600_000;
  if (h < 1) return '不到一小时';
  return '约 ' + Math.round(h) + ' 小时';
}

/**
 * 维度 kind → 给玩家看的中文名。
 *
 * ⚠️ 这份映射**必须**覆盖 `authorities.yaml` 里出现的每一个 kind ——
 * 漏一个的症状是界面上显示 `madRate` 这种英文 id。测试里有守着。
 */
export const AUTHORITY_KIND_LABELS: Readonly<Record<string, string>> = {
  weather: '天象',
  banCommand: '禁令',
  madRate: '理智',
  priceFactor: '物价',
  encounterRate: '遭遇',
};