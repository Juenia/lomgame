/**
 * **一键修复**（M2.86，用户拍板）。
 *
 * ## 用户的原话
 *
 * > 「修复内容检验里的问题，同时新增一键修复功能 —— **切记是一键修复，不是点了后一键修坏**」
 *
 * 最后半句是这份文件存在的全部理由。一键修复最容易变成一键修坏，路径有三条，逐条堵：
 *
 * | 修坏的方式 | 这里的堵法 |
 * | --- | --- |
 * | **猜内容**（没绑卡就随便编一张卡的名字） | **绝不编卡** —— 只从**同类型已绑卡的地点**里借，
 *   没有同类就退回**确定性抽**（`hash(地点id) % 池子`），抽出来的卡**真实存在** |
 * | **顺手改了别的行** | 只做**行级插入/替换**：给没有 `events` 的地点补一行，
 *   已有 `events` 的地点**逐字跳过**；不动注释、不动顺序、不动别的字段 |
 * | **重复执行越修越乱** | **幂等**：跑第二次时没有「缺失的地点」，因此产出**空计划**（用测试守着） |
 *
 * 另外两条纪律：
 *
 *   ① **先给计划、再落盘**（`plan` / `apply` 分开）。预览里能看到「哪一行会变成什么」，
 *      点下去之前就知道会发生什么；
 *   ② **落盘前留备份**（`.bak`）。改内容文件是这个仓库最不可逆的操作之一（AGENTS §3.6 记着一次
 *      中文全乱码的事故），留一份就能退回去。
 *
 * ## 不管的那些
 *
 * 「不属于任何城市」那 57 条**故意不修** —— 看名字就知道尺子不对：
 * `hornacis_peak`（山峰）、`interior_sea`（内海）、`ruen_great_river`（大河）
 * **本来就不该属于任何城市**。那不是内容缺陷，是**校验规则太宽**，改的是校验不是数据。
 * 「够不到」那 5 条同理：它是**跑批诊断**（告诉你有几层的机制验不到），不是待修项。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FixChange {
  /** 文件（相对仓库根） */
  file: string;
  /** 1 起的行号 */
  line: number;
  /** 这一行现在长什么样（预览用） */
  before: string;
  /**
   * `replace` = 改掉这一行（原来就有 `events:`，只是空的）；
   * `insert`  = 在这一行**前面**插一行（原来连字段都没有）。
   *
   * ⚠️ 第一版**只有 insert**，于是「`events: []`」被当成「插在 `adjacent` 前」——
   * 空数组那一行**原样留着**，下一次扫描又判它缺卡，**再插一遍**。
   * 表现就是「点两次一键修复，文件里堆出两行 events，还有一行空的」。
   */
  mode: 'replace' | 'insert';
  /** 改完长什么样 */
  after: string;
  /** 为什么这么改（给运营看的一句话） */
  reason: string;
}

export interface FixPlan {
  /** 计划要改的每一处 */
  changes: FixChange[];
  /** 已经被跳过、不需要动的数量（幂等的证据：第二次跑时它 = 全部） */
  skipped: number;
  /** 计划本身的说明 */
  summary: string;
}

/** 给「没绑卡」的地点抽卡：从**真实存在**的卡 id 池里按地点 id 确定性抽 */
export function pickCardsFor(locationId: string, pool: readonly string[], count = 3): string[] {
  if (pool.length === 0) return [];
  // FNV-1a：确定性（同一个地点永远抽到同一批卡），且不依赖 Math.random 的全局状态
  let h = 2166136261;
  for (const ch of locationId) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  const picked: string[] = [];
  for (let i = 0; i < count && i < pool.length; i += 1) {
    const idx = (h + i * 7919) % pool.length;
    const id = pool[idx]!;
    if (!picked.includes(id)) picked.push(id);
  }
  return picked;
}

/**
 * **只出计划，不落盘**。
 *
 * `contentDir` 传内容目录（默认 `src/data`），`dryRun` 为 true 时连读都不写（本函数从来不写）。
 */
export function planEventCardFix(contentDir: string): FixPlan {
  const file = join(contentDir, 'locations.yaml');
  if (!existsSync(file)) return { changes: [], skipped: 0, summary: '找不到 locations.yaml' };
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');

  /*
   * ① 收「**可以绑给任何地点的卡**」—— 绝不编卡名，也绝不张冠李戴。
   *
   * 第一版是从 `registry.yaml` 收**全部**卡 id，预演时抽出了 `seq7_001`
   * （**序列 7 专属卡**）要绑到一个序列 9 的地点 —— **那就是修坏**。
   * 所以池子限定成 `cards/daily/` 里 **`trigger.cond` 为空**的那些：
   * 它们没有途径/序列/地点门槛，绑到哪里都成立。
   */
  const pool: string[] = [];
  const dailyDir = join(contentDir, '..', 'cards', 'daily');
  if (existsSync(dailyDir)) {
    for (const name of readdirSync(dailyDir)) {
      if (!name.endsWith('.yaml')) continue;
      /*
       * ⚠️ **用前缀白名单，不要用「排除法」**。
       *
       * 第一版写的是「读 `cards/registry.yaml` 收全部卡 id」，预演里抽出了 `seq7_001`
       * —— 序列 7 专属卡绑到序列 9 的地点，**那就是修坏**。
       * 第二版改成按目录收 + 一个正则判 `cond`，但判断写得绕，跑出来的池子里
       * 混进了 `lost_*` / `random_*` / `seq7_*`（21 种），而长度读数还是 51 ——
       * **读数和内容对不上**。
       * 现在：**只认 `daily_` 前缀**，一眼看得出收的是什么。
       */
      if (!name.startsWith('daily_')) continue;
      const cardText = readFileSync(join(dailyDir, name), 'utf8');
      // 万一有 card 是 daily_ 前缀却带条件，照样不收
      if (/\n\s*cond:\s*\[\s*[^\s\]]/.test(cardText)) continue;
      pool.push(name.replace(/\.yaml$/, ''));
      continue;
    }
  }

  const changes: FixChange[] = [];
  let skipped = 0;
  let currentId = '';
  /**
   * ⚠️ **空的 `events: []` 也算「没有绑卡」**（第一版只看有没有这个键，于是全被跳过）。
   *
   * 这是踩出来的：`contentView` 报 95 个地点没绑卡，而我的扫描说「154 个都绑了」——
   * 因为内容表里那些地点写的是 `events: []`（有键、没值），
   * 而 loader 的判据是 `events.length === 0`。**两边对「没有」的定义不一致**，
   * 结果就是修复工具安静地什么都不做。
   */
  let eventsLine = -1;
  let eventsEmpty = false;
  let adjacentLine = -1;
  const flush = (): void => {
    if (currentId === '') return;
    const missing = eventsLine < 0 || eventsEmpty;
    if (!missing) { skipped += 1; return; }
    const picked = pickCardsFor(currentId, pool);
    if (picked.length === 0) { skipped += 1; return; }
    const target = eventsLine >= 0 ? eventsLine : adjacentLine;
    if (target < 0) { skipped += 1; return; }
    changes.push({
      file: 'src/data/locations.yaml',
      mode: eventsLine >= 0 ? 'replace' : 'insert',
      line: target,
      before: lines[target] ?? '',
      after: '    events: [' + picked.join(', ') + ']',
      reason: (eventsLine >= 0 ? '这个地点的 events 是空的' : '这个地点没有 events 字段')
        + '（探索到这里没有内容），填上 ' + picked.join('/'),
    });
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const idMatch = /^  - id:\s*(\S+)/.exec(line);
    if (idMatch) {
      flush();
      currentId = idMatch[1]!;
      eventsLine = -1;
      eventsEmpty = false;
      adjacentLine = -1;
      continue;
    }
    if (/^\s+events:\s*\[/.test(line)) {
      eventsLine = i;
      // `events: []` / `events: [ ]` 都是空 —— 与 loader 的 `length === 0` 对齐
      eventsEmpty = /^\s+events:\s*\[\s*\]\s*$/.test(line);
    }
    if (/^\s+adjacent:\s*\[/.test(line)) adjacentLine = i;
  }
  flush();
  return {
    changes,
    skipped,
    summary: changes.length === 0
      ? '没有需要修的地方（' + skipped + ' 个地点都已经绑了事件卡）'
      : '要给 ' + changes.length + ' 个地点补事件卡（另有 ' + skipped + ' 个不用动）',
  };
}

/**
 * **落盘**。
 *
 * 三条保护：
 *
 *   1. 只按 `plan.changes` 的行号动 —— 计划之外一行都不碰；
 *   2. 落盘前写 `.bak`（同目录 `locations.yaml.bak`）；
 *   3. 行号**从后往前**改，避免前面的插入把后面的行号顶偏。
 *
 * 返回实际写入的行数 —— 幂等时它是 0。
 */
export function applyEventCardFix(contentDir: string, plan: FixPlan): { written: number; backup: string | null } {
  if (plan.changes.length === 0) return { written: 0, backup: null };
  const file = join(contentDir, 'locations.yaml');
  const text = readFileSync(file, 'utf8');
  /*
   * ⚠️ **备份只在不存在时写**。
   *
   * 第一版每次都覆盖 `.bak`，于是「点两次一键修复」之后，备份里是**已被改过一次的文件** ——
   * 想退回去时发现备份也是坏的。备份的意义就在于它必须是**改动之前**那一份，
   * 所以它一旦存在就不许再被写。
   */
  const backup = file + '.bak';
  if (!existsSync(backup)) writeFileSync(backup, text, 'utf8');
  const lines = text.split('\n');
  const ordered = [...plan.changes].sort((a, b) => b.line - a.line);
  let written = 0;
  for (const change of ordered) {
    // 只在该行的确还是计划里那一行时插入（计划过期就跳过，宁可不改也不改错）
    if (lines[change.line] !== change.before) continue;
    // replace 换掉那一行；insert 在它前面插一行（计划里已经定好，这里不猜）
    if (change.mode === 'replace') lines.splice(change.line, 1, change.after);
    else lines.splice(change.line, 0, change.after);
    written += 1;
  }
  writeFileSync(file, lines.join('\n'), 'utf8');
  return { written, backup };
}
