/**
 * M2.1 可见性取证：从回归轮行为日志里数「失控发生在谁身上、他们当时在干什么」。
 *
 * 全部判据都来自服务端的真实回执，没有模型假设：
 *   - 失控发生：每日结算的私聊里出现「你失控了。」（tick 通知在玩家当天第一条指令时被收进收件箱）
 *   - 失控中还在玩：该玩家日里出现过 .扮演 / .事件 —— 只有这时才可能抽到 lost_*
 *   - 立刻解除：该玩家日的第一条动作指令是 .净化 / .休息（两条恢复路径都会清除失控）
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_BASE_EPOCH } from './measured.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 从服务端库取「谁在哪一天失控过」。
 *
 * 为什么不用私聊通知来数：虚拟玩家跑批时服务端是 `startOps=false`，每日结算由
 * POST /admin/tick 手动触发，**而这条路由只跑结算、不发通知**（通知在 ops 循环里发），
 * 所以实例测试里玩家其实收不到「你失控了」那条私聊。lost_control_events 才是权威账本。
 */
export function lostDaysFromDatabase(dbPath: string, baseEpoch: number = DEFAULT_BASE_EPOCH): Set<string> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return lostDaysOf(db, baseEpoch);
  } finally {
    db.close();
  }
}

/** 同上，但直接吃一个已打开的库（单测用内存库，实例测试用服务端库） */
export function lostDaysOf(
  db: { prepare: (sql: string) => { all: () => unknown[] } },
  baseEpoch: number = DEFAULT_BASE_EPOCH,
): Set<string> {
  const rows = db
    .prepare(
      'SELECT c.user_id AS user_id, e.date AS date FROM lost_control_events e ' +
        'JOIN characters c ON c.id = e.character_id',
    )
    .all() as Array<{ user_id: string; date: string }>;
  const out = new Set<string>();
  for (const row of rows) {
    const playerId = Number(String(row.user_id)) - 700000;
    const day = Math.round((Date.parse(row.date + 'T00:00:00+08:00') - baseEpoch) / DAY_MS);
    out.add(playerId + '#' + day);
  }
  return out;
}

export interface LostControlDay {
  key: string;
  persona: string;
  /** 当天全部 .扮演 次数（含解除之后打的） */
  plays: number;
  events: number;
  firstAction: string | null;
  /** 第一条动作就是净化/休息 —— 失控状态活不过这一条 */
  curedImmediately: boolean;
  /**
   * **失控窗口内**的 .扮演 / .事件 次数。
   * 窗口 = 当天开始到第一条解除动作为止（失控是结算时点上的状态，玩家一解除窗口就关闭）。
   * 只有这个数才是真正的抽卡机会 —— 解除之后打的扮演抽不到 lost_*。
   */
  playsWhileLost: number;
  eventsWhileLost: number;
  /** 失控窗口里第一条动作的序号（0 = 第一条；用来量「活了多久」） */
  cureAtAction: number | null;
  lost: boolean;
  recovered: boolean;
}

export interface PersonaEvidence {
  persona: string;
  lostDays: number;
  /** 失控窗口内还有 .扮演 / .事件 的玩家日（真正有抽卡机会的） */
  playedDays: number;
  /** 第一条动作就是净化/休息、当场解除的玩家日 */
  curedDays: number;
  playsWhileLost: number;
  eventsWhileLost: number;
}

export interface VisibilityEvidence {
  log: string;
  playerDays: number;
  lostDays: LostControlDay[];
  byPersona: PersonaEvidence[];
  playsInLostWindow: number;
  eventsInLostWindow: number;
  tickRecoveries: number;
}

const ACTION_COMMANDS = ['净化', '休息', '扮演', '探索', '事件', '服用', '魔药', '晋升', '占卜'];

export async function collectVisibilityEvidence(
  log: string,
  options: { lostDays?: ReadonlySet<string> } = {},
): Promise<VisibilityEvidence> {
  const days = new Map<string, LostControlDay>();
  const reader = createInterface({ input: createReadStream(log, { encoding: 'utf8' }), crlfDelay: Infinity });
  let playerDays = 0;
  for await (const line of reader) {
    if (!line.trim()) continue;
    let record: {
      playerId: number;
      persona: string;
      day: number;
      command: string;
      reason?: string;
      replyTexts: string[];
    };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue;
    }
    const key = record.playerId + '#' + record.day;
    const state: LostControlDay =
      days.get(key) ??
      ({
        key,
        persona: record.persona,
        plays: 0,
        events: 0,
        firstAction: null,
        curedImmediately: false,
        playsWhileLost: 0,
        eventsWhileLost: 0,
        cureAtAction: null,
        lost: false,
        recovered: false,
      } satisfies LostControlDay);
    if (!days.has(key)) {
      days.set(key, state);
      playerDays += 1;
    }
    // 三条独立的信号，任意一条命中就算这天失控过：
    //   1) 服务端库的 lost_control_events（权威，--db 时可用）
    //   2) 虚拟玩家自己的决策理由（decide.ts 第 2 步在失控时的固定话术）
    //   3) 结算私聊文本（只有 ops 循环触发结算时才会发到玩家手里，实例测试里通常收不到）
    if (options.lostDays?.has(key) === true) state.lost = true;
    if ((record.reason ?? '').includes('失控中')) state.lost = true;
    const text = (record.replyTexts ?? []).join(String.fromCharCode(10));
    if (text.includes('你失控了。')) state.lost = true;
    if (text.includes('你从失控里缓过来了')) state.recovered = true;
    const name = String(record.command).replace(/^[.。．]/, '').split(/\s+/)[0] ?? '';
    // 窗口还开着（还没解除）时记的扮演/事件才算抽卡机会
    const windowOpen = state.cureAtAction === null;
    if (name === '扮演') {
      state.plays += 1;
      if (windowOpen) state.playsWhileLost += 1;
    }
    if (name === '事件') {
      state.events += 1;
      if (windowOpen) state.eventsWhileLost += 1;
    }
    if (state.firstAction === null && ACTION_COMMANDS.includes(name)) {
      state.firstAction = name;
      state.curedImmediately = name === '净化' || name === '休息';
      state.cureAtAction = state.plays + state.events;
    }
    if ((name === '净化' || name === '休息') && state.cureAtAction === null) {
      state.cureAtAction = state.plays + state.events;
    }
  }

  const lostDays = [...days.values()].filter((day) => day.lost);
  const byPersona = new Map<string, PersonaEvidence>();
  for (const day of lostDays) {
    const bucket =
      byPersona.get(day.persona) ??
      ({ persona: day.persona, lostDays: 0, playedDays: 0, curedDays: 0, playsWhileLost: 0, eventsWhileLost: 0 } as PersonaEvidence);
    bucket.lostDays += 1;
    if (day.playsWhileLost + day.eventsWhileLost > 0) bucket.playedDays += 1;
    if (day.curedImmediately) bucket.curedDays += 1;
    bucket.playsWhileLost += day.playsWhileLost;
    bucket.eventsWhileLost += day.eventsWhileLost;
    byPersona.set(day.persona, bucket);
  }

  return {
    log,
    playerDays,
    lostDays,
    byPersona: [...byPersona.values()].sort((a, b) => (a.persona < b.persona ? -1 : 1)),
    playsInLostWindow: lostDays.reduce((sum, day) => sum + day.playsWhileLost, 0),
    eventsInLostWindow: lostDays.reduce((sum, day) => sum + day.eventsWhileLost, 0),
    tickRecoveries: [...days.values()].filter((day) => day.recovered).length,
  };
}

/** 证据 → markdown 表（报告直接用） */
export function renderVisibilityEvidence(evidence: VisibilityEvidence, exposureChance: number): string[] {
  const lines: string[] = [];
  lines.push('| 画像 | 失控玩家日 | 失控窗口内还在扮演/事件（**真正有抽卡机会**） | 第一条动作就净化/休息（当场解除） | 窗口内扮演次数 |');
  lines.push('|---|---|---|---|---|');
  for (const row of evidence.byPersona) {
    lines.push(
      '| ' + row.persona + ' | ' + row.lostDays + ' | ' + row.playedDays + ' | ' + row.curedDays + ' | ' + row.playsWhileLost + ' |',
    );
  }
  if (evidence.byPersona.length === 0) lines.push('| — | 0 | 0 | 0 | 0 |');
  lines.push('');
  lines.push(
    '失控玩家日合计 ' + evidence.lostDays.length + '（' + evidence.playerDays + ' 个玩家日）；' +
      '**失控窗口内**的 .扮演 ' + evidence.playsInLostWindow + ' 次、.事件 ' + evidence.eventsInLostWindow + ' 次' +
      '（暴露概率 ' + exposureChance + ' → 理论抽卡 ' + (evidence.playsInLostWindow * exposureChance).toFixed(1) + ' 次）。',
  );
  return lines;
}
/**
 * 假设推演：如果「失控卡只认失控当天」而不是「只认失控窗口」（候选方案 A），
 * 这些失控日能带来多少次抽卡机会？
 *
 * 与 collectVisibilityEvidence 的区别只有一个：窗口取**整天的 .扮演/.事件**（方案 A 的语义），
 * 而不是「从失控开始到第一条解除动作为止」。用同一批实测日志算，不引入任何新假设。
 */
export interface FullDayExposure {
  persona: string;
  lostDays: number;
  /** 失控当天的 .扮演 次数合计（方案 A 下这些都算抽卡机会） */
  plays: number;
  events: number;
  /** 每个失控日的 .扮演 次数 */
  playsPerLostDay: number;
}

export async function fullDayExposure(log: string, options: { lostDays?: ReadonlySet<string> } = {}): Promise<FullDayExposure[]> {
  const days = new Map<string, { persona: string; plays: number; events: number; lost: boolean }>();
  const reader = createInterface({ input: createReadStream(log, { encoding: 'utf8' }), crlfDelay: Infinity });
  const lost = new Set<string>(options.lostDays ?? []);
  for await (const line of reader) {
    if (!line.trim()) continue;
    let record: { playerId: number; persona: string; day: number; command: string; reason?: string; replyTexts?: string[] };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue;
    }
    const key = record.playerId + '#' + record.day;
    const state = days.get(key) ?? { persona: record.persona, plays: 0, events: 0, lost: false };
    if (!days.has(key)) days.set(key, state);
    if (lost.has(key) || (record.reason ?? '').includes('失控中')) state.lost = true;
    const name = String(record.command).replace(/^[.。．]/, '').split(/\s+/)[0] ?? '';
    if (name === '扮演') state.plays += 1;
    if (name === '事件') state.events += 1;
  }

  const byPersona = new Map<string, FullDayExposure>();
  for (const state of days.values()) {
    if (!state.lost) continue;
    const bucket =
      byPersona.get(state.persona) ??
      ({ persona: state.persona, lostDays: 0, plays: 0, events: 0, playsPerLostDay: 0 } as FullDayExposure);
    bucket.lostDays += 1;
    bucket.plays += state.plays;
    bucket.events += state.events;
    byPersona.set(state.persona, bucket);
  }
  for (const bucket of byPersona.values()) {
    bucket.playsPerLostDay = bucket.lostDays === 0 ? 0 : Number((bucket.plays / bucket.lostDays).toFixed(2));
  }
  return [...byPersona.values()].sort((a, b) => (a.persona < b.persona ? -1 : 1));
}
/**
 * 失控日的**动作构成**（相对于普通日）。
 *
 * 这是候选方案 E（把 lost_* 接进探索抽卡路径）的依据：
 * lost_* 现在只能从「.扮演 暴露抽卡」出来，而实测失控日玩家几乎不扮演 —— 他们在交易与探索。
 */
export interface ActionMixRow {
  command: string;
  lostPerDay: number;
  normalPerDay: number;
  /** 普通日 → 失控日的倍数（0 表示失控日完全没有这条指令） */
  ratio: number;
}

export interface ActionMix {
  lostDays: number;
  normalDays: number;
  rows: ActionMixRow[];
}

export async function lostDayActionMix(log: string): Promise<ActionMix> {
  const days = new Map<string, { lost: boolean; mix: Map<string, number> }>();
  const reader = createInterface({ input: createReadStream(log, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of reader) {
    if (!line.trim()) continue;
    let record: { playerId: number; day: number; command: string; reason?: string };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue;
    }
    const key = record.playerId + '#' + record.day;
    const state = days.get(key) ?? { lost: false, mix: new Map<string, number>() };
    if (!days.has(key)) days.set(key, state);
    if ((record.reason ?? '').includes('失控中')) state.lost = true;
    const name = String(record.command).replace(/^[.。．]/, '').split(/\s+/)[0] ?? '';
    state.mix.set(name, (state.mix.get(name) ?? 0) + 1);
  }

  const lost = [...days.values()].filter((day) => day.lost);
  const normal = [...days.values()].filter((day) => !day.lost);
  const average = (rows: Array<{ mix: Map<string, number> }>, command: string): number => {
    if (rows.length === 0) return 0;
    const total = rows.reduce((sum, row) => sum + (row.mix.get(command) ?? 0), 0);
    return Number((total / rows.length).toFixed(2));
  };
  const commands = [...new Set([...lost, ...normal].flatMap((day) => [...day.mix.keys()]))];
  const rows: ActionMixRow[] = commands
    .map((command) => {
      const lostPerDay = average(lost, command);
      const normalPerDay = average(normal, command);
      return {
        command,
        lostPerDay,
        normalPerDay,
        ratio: normalPerDay === 0 ? 0 : Number((lostPerDay / normalPerDay).toFixed(2)),
      };
    })
    .sort((a, b) => b.normalPerDay - a.normalPerDay);
  return { lostDays: lost.length, normalDays: normal.length, rows };
}
