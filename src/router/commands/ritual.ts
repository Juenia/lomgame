/**
 * .仪式 指令（M2.5）：晋升仪式。
 *
 *   .仪式 / .仪式 准备 / .仪式 地点 <地点名> / .仪式 时间 <时段> / .仪式 见证
 *   .仪式 开始（阶段 1 布置 + 阶段 2 引导）/ .仪式 融合（阶段 3，结算）/ .仪式 取消
 *
 * 与 .晋升 的关系（任务书 §3.5）：.晋升 是快速晋升，用 W5 基础公式直接判；
 * 仪式是「高投入高回报」—— 配置好能顶到 95%，配置差可能比直接晋升还低，
 * 但阶段 3 失败的代价也更重（材料损 50% + 重伤）。
 *
 * 这一层只做四件事：查库拼输入、调纯函数、落库、把结果拆成「群聊摘要 + 私聊明细」。
 * 所有算术都在 domain/ritual/ 里。
 */
import { NUMERIC } from '../../config/numeric.ts';
import { abilityFlag } from '../../domain/ability/ability.ts';
import { checkPromotion, promotionRequirement } from '../../domain/promotion/promotion.ts';
import { ritualProfileFor } from '../../domain/ritual/profile.ts';
import { createSeededRng, seedFrom } from '../../domain/rng.ts';
/*
 * M2.88：**仪式流程** —— 把「至少三百年」从一段文本变成要走的一串步骤。
 *
 * 用户否掉了计时模型（「拿现实时间去要求就是纯折磨」），改法是：
 * 每一步由玩家**去做**，每一步都可能失败，也都能被别人伸手搅掉。
 */
import {
  RITUAL_STEP_LABELS,
  advanceStep,
  currentStepIndex,
  flowLine,
  isFlowComplete,
  parseRitualSteps,
  type RitualProgress,
} from '../../domain/ritual/flow.ts';
import { FLAG_RITUAL_FLOW } from '../../infra/db/flags.ts';
import { worldClock, TIME_OF_DAY_LABELS, type TimeOfDay } from '../../domain/world/clock.ts';
import { weatherLabel, type WeatherId } from '../../domain/world/weather.ts';
import {
  emptyRitualConfig,
  materialGradeOf,
  outcomeLine,
  renderBreakdownLines,
  resolveRitualFuse,
  resolveRitualSetup,
  ritualChance,
  signedPct,
  timeBonusOf,
  witnessBonusOf,
  type RitualChanceInput,
  type RitualConfig,
} from '../../domain/ritual/index.ts';
import type { Menu, MenuOption } from '../../domain/menu/index.ts';
import { isInitiated, type CharacterState, type InitiatedCharacter } from '../../domain/character/types.ts';
import { mortalRefusal } from './mortal-guard.ts';
import { checkTaboosFor } from './taboo-hooks.ts';
/*
 * M2.89：`sabotageResultLine` 是新用的 —— 流程的每一步都可能被人伸手，
 * 而那一下的收场话与「融合那一刻」用的是同一句（同一件事不该有两种说法）。
 */
import { sabotageChance, sabotagePenalty, sabotageResultLine, sabotageTextFor } from '../../domain/ritual/sabotage.ts';
import type { MaterialNeed } from '../../domain/potion/recipe.ts';
import type { CommandContext, CommandResult, RouterDeps } from '../index.ts';
import { applyFor, npcSequenceOf, requireCharacter } from './common.ts';
import { renderDeltaSummary } from './render.ts';

export const RITUAL_USAGE =
  '用法：.仪式 准备（看选项）/ .仪式 地点 <地点名> / .仪式 时间 <夜晚|黎明|白天|黄昏> / ' +
  '.仪式 见证 / .仪式 开始 / .仪式 融合 / .仪式 取消';

const RITUAL = NUMERIC.ritual;

const TIME_ALIASES: Record<string, TimeOfDay> = {
  黎明: 'dawn', 白天: 'day', 黄昏: 'dusk', 夜晚: 'night',
  dawn: 'dawn', day: 'day', dusk: 'dusk', night: 'night',
};

export interface RitualInputs {
  chance: RitualChanceInput;
  materials: MaterialNeed[];
  targetSequence: number;
  requiredFlag: string;
  locationName: string | null;
  timeOfDay: TimeOfDay;
  weather: WeatherId;
  witnessCount: number;
  mainMaterialId: string | null;
  check: ReturnType<typeof checkPromotion>;
}

/** 把库里的状态拼成纯函数要的输入（这一层只查、不判） */
export function ritualInputs(
  deps: RouterDeps,
  /** M2.7.6：仪式是晋升的一部分，只有已入途径的角色有资格（守卫在命令入口） */
  character: InitiatedCharacter,
  config: RitualConfig,
  now: number,
): RitualInputs {
  deps.world.ensure(now, deps.worldSeed ?? 'world');
  const clock = worldClock(now, deps.world.seed());
  const recipe = deps.recipes
    .forPathway(character.pathway)
    .find((candidate) => candidate.seq === character.sequence);
  const locationId = config.locationId;
  const location = locationId ? deps.locations.get(locationId) : null;
  const weather: WeatherId = locationId ? (deps.world.weatherOf(locationId) as WeatherId) : 'clear';
  // 见证人 = 队伍里除自己以外的人（队伍上限 4 = 队长 + 3 见证人，正好对上 witnessMax）
  const party = deps.parties.partyOf(character.id);
  const witnessCount = party ? Math.max(0, deps.parties.members(party.id).length - 1) : 0;
  const materials: MaterialNeed[] = recipe
    ? recipe.main.map((need) => ({
        itemId: need.itemId,
        qty: need.qty * NUMERIC.promotion.mainMaterialMultiplier,
      }))
    : [];
  const mainMaterialId = recipe?.main[0]?.itemId ?? null;
  const chance: RitualChanceInput = {
    state: { dig: character.dig, sequence: character.sequence, mad: character.mad, cor: character.cor },
    fails: character.promotionFails ?? 0,
    locationId,
    timeOfDay: clock.timeOfDay,
    weather,
    witnessCount,
    mainMaterialId,
    interferenceCount: config.interferenceCount,
  };
  const requirement = recipe ? promotionRequirement(recipe, character) : null;
  const check: ReturnType<typeof checkPromotion> = requirement
    ? checkPromotion({
        state: character,
        requirement,
        ownedOf: (itemId) => deps.inventory.count(character.id, itemId),
        hasRequiredFlag: deps.flags.has(character.id, requirement.requiredFlag),
      })
    : { ok: false, reason: '这个序列暂时没有对应的晋升路径。' };
  return {
    chance,
    materials,
    targetSequence: requirement?.targetSequence ?? character.sequence,
    requiredFlag: requirement?.requiredFlag ?? '',
    locationName: location?.name ?? null,
    timeOfDay: clock.timeOfDay,
    weather,
    witnessCount,
    mainMaterialId,
    check,
  };
}

function configOf(deps: RouterDeps, character: InitiatedCharacter): RitualConfig {
  return deps.rituals.preparingOf(character.id)?.config ?? emptyRitualConfig();
}

/** 准备菜单：拆解 + 提醒 + 选项（任务书 §3.2 的预览 + §3.1 的布置入口） */
function renderPrepare(
  deps: RouterDeps,
  character: InitiatedCharacter,
  inputs: RitualInputs,
  config: RitualConfig,
  now: number,
): CommandResult {
  const breakdown = ritualChance(inputs.chance);
  const pct = (value: number): string => (value * 100).toFixed(1) + '%';
  const context: string[] = [];
  context.push(...renderBreakdownLines(breakdown, {
    location: inputs.locationName ?? '还没选',
    time: TIME_OF_DAY_LABELS[inputs.timeOfDay],
    weather: weatherLabel(inputs.weather),
    witness: inputs.witnessCount + ' 人',
    material: materialGradeOf(inputs.mainMaterialId),
  }));
  context.push('');
  context.push('最终成功率：' + (breakdown.final * 100).toFixed(1) + '%（上限 ' + (RITUAL.successCap * 100).toFixed(0) + '%）');
  const notes: string[] = [];
  // MAD / COR 惩罚提示 —— M2.4 发现的死循环 UX 缺口就补在这里
  if (breakdown.mad <= -0.05) {
    notes.push('MAD 惩罚正在压低你的成功率（' + pct(breakdown.mad) + '）：当前 MAD ' + Math.round(character.mad) + '，.休息 一次可降 5。');
  }
  if (breakdown.cor <= -0.03) {
    notes.push('COR 惩罚正在压低你的成功率（' + pct(breakdown.cor) + '）：当前 COR ' + Math.round(character.cor) + '，.净化 一次可降 15。');
  }
  if (config.interferenceCount > 0) {
    notes.push('这个仪式已经被干扰 ' + config.interferenceCount + ' 次（' + pct(breakdown.interference) + '）。');
  }
  if (breakdown.capped) notes.push('成功率已经顶到上限，再加配置也不会更高 —— 可以考虑省下材料。');
  if (!inputs.check.ok) notes.push('现在还开不了：' + inputs.check.reason);
  if (notes.length > 0) {
    context.push('');
    for (const note of notes) context.push('注意：' + note);
  }
  /*
   * M2.85 内容填充 P6：**原作记载的晋升仪式**。
   *
   * 数据源是 01-途径与序列/途径-*.yaml 的 advancement_ritual（132 条，22 途径 × 序列 5—0）。
   * 原作对**序列 6—9 没有记载** —— 遇到这种情况直说「原作未载」，
   * 既不假装有、也不留一行空白让人以为界面坏了。
   */
  const targetSeq = character.sequence - 1;
  const rite = targetSeq >= 0
    ? deps.advancementRites.find((entry) => entry.pathway === character.pathway && entry.seq === targetSeq) ?? null
    : null;
  if (rite) {
    context.push('', `【原作记载 · 晋升「${rite.sequenceTitle}」】`, rite.ritual);
  } else if (targetSeq >= 6) {
    context.push('', '（原作对序列 6—9 的晋升没有记载仪式 —— 原著里这一档是直接服食魔药）');
  }

  const locationTable = RITUAL.locationBonus as Record<string, number>;
  const candidates = Object.keys(locationTable)
    .map((id) => ({ id, bonus: locationTable[id] ?? 0, name: deps.locations.get(id)?.name ?? id }))
    .sort((a, b) => b.bonus - a.bonus);
  const options: MenuOption[] = [];
  let key = 1;
  for (const candidate of candidates) {
    const option: MenuOption = {
      key: String(key),
      label: '地点：' + candidate.name + '（' + signedPct(candidate.bonus) + '）',
      command: '仪式 地点 ' + candidate.name,
    };
    if (config.locationId === candidate.id) option.preview = '已选';
    options.push(option);
    key += 1;
  }
  const timeChoices: TimeOfDay[] = ['night', 'dawn', 'day', 'dusk'];
  options.push({
    key: String(key),
    label: '换个时间（现在：' + TIME_OF_DAY_LABELS[inputs.timeOfDay] + '）',
    command: '仪式 时间 ' + TIME_OF_DAY_LABELS[timeChoices[0]!],
    preview: '可选 ' + timeChoices.map((slot) => TIME_OF_DAY_LABELS[slot]).join('/'),
  });
  key += 1;
  options.push({
    key: String(key),
    label: '见证人：' + inputs.witnessCount + ' 人（' + signedPct(witnessBonusOf(inputs.witnessCount)) + '，最多 ' + RITUAL.witnessMax + ' 人）',
    command: '仪式 见证',
  });
  key += 1;
  const startOption: MenuOption = {
    key: String(key),
    label: '开始仪式（' + (breakdown.final * 100).toFixed(1) + '%）',
    command: '仪式 开始',
  };
  if (!inputs.check.ok) startOption.disabled = inputs.check.reason;
  options.push(startOption);
  key += 1;
  options.push({ key: String(key), label: '取消', command: '仪式 取消' });

  const menu: Menu = { title: '【仪式 · 准备】', context, options, allowFreeform: true };
  return {
    privateText: deps.pendingMenus.open(character.id, 'ritual', menu, now),
    groupText: '有人在准备一场仪式。',
    detailToPrivate: true,
    menuOpened: true,
  };
}

function stageLines(
  stages: ReadonlyArray<{
    stage: number;
    label: string;
    success: boolean;
    note: string;
    chance: number;
    roll: number;
  }>,
): string[] {
  return stages.map((stage) =>
    '阶段 ' + stage.stage + ' ' + stage.label + '：' + stage.note +
    '（成功率 ' + (stage.chance * 100).toFixed(1) + '%，抽样 ' + stage.roll.toFixed(3) + '）',
  );
}

export async function handleRitual(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const character = gate.character;
  const { deps, msg, now } = ctx;
  // M2.7.6：普通人没有序列，也就没有仪式可言（M2.7.7 起走统一入口守卫）
  if (!isInitiated(character)) return mortalRefusal(ctx, character, '仪式');
  const sub = (ctx.args[0] ?? '准备').trim();
  const rest = ctx.args.slice(1).join(' ').trim();

  if (sub === '地点') {
    if (!rest) return { privateText: '用法：.仪式 地点 <地点名>（.仪式 准备 里有候选）', detailToPrivate: true };
    const target = deps.locations.all().find((location) => location.name === rest || location.id === rest);
    if (!target) return { privateText: '没有这个地方：' + rest, detailToPrivate: true };
    const config: RitualConfig = { ...configOf(deps, character), locationId: target.id };
    deps.rituals.savePreparing(character.id, config, now);
    return renderPrepare(deps, character, ritualInputs(deps, character, config, now), config, now);
  }

  if (sub === '时间') {
    const wanted = TIME_ALIASES[rest];
    if (!wanted) return { privateText: '用法：.仪式 时间 <夜晚|黎明|白天|黄昏>', detailToPrivate: true };
    const config: RitualConfig = { ...configOf(deps, character), timeOfDay: wanted };
    deps.rituals.savePreparing(character.id, config, now);
    const inputs = ritualInputs(deps, character, config, now);
    const prepared = renderPrepare(deps, character, inputs, config, now);
    const head = wanted === inputs.timeOfDay
      ? '现在就是' + TIME_OF_DAY_LABELS[wanted] + '，可以开始了。'
      : '仪式定在「' + TIME_OF_DAY_LABELS[wanted] + '」，现在是' + TIME_OF_DAY_LABELS[inputs.timeOfDay] + ' —— 到点再来 .仪式 开始。';
    return { ...prepared, privateText: head + '\n\n' + prepared.privateText };
  }

  if (sub === '见证') {
    const party = deps.parties.partyOf(character.id);
    const members = party
      ? deps.parties.members(party.id).filter((member) => member.characterId !== character.id)
      : [];
    const witnesses = members.slice(0, RITUAL.witnessMax).map((member) => member.characterId);
    const config: RitualConfig = { ...configOf(deps, character), witnesses };
    deps.rituals.savePreparing(character.id, config, now);
    const inputs = ritualInputs(deps, character, config, now);
    const prepared = renderPrepare(deps, character, inputs, config, now);
    const head = witnesses.length === 0
      ? '你身边没有人 —— 先用 .队伍 拉一个队伍，队友会自动成为见证人。'
      : '已经请到 ' + witnesses.length + ' 位见证人（' + signedPct(witnessBonusOf(witnesses.length)) + '）。';
    return { ...prepared, privateText: head + '\n\n' + prepared.privateText };
  }

  if (sub === '取消') {
    deps.rituals.clearPreparing(character.id);
    return { privateText: '仪式配置已经丢掉。', detailToPrivate: true, suppressMenu: true };
  }

  if (sub === '开始') return startRitual(ctx, character);
  if (sub === '融合' || sub === '完成') return fuseRitual(ctx, character);
  // M2.88：流程与推进 —— 把「三百年」从文本变成要去做的事
  if (sub === '流程') return showFlow(ctx, character);
  if (sub === '推进') return advanceFlow(ctx, character);

  const config = configOf(deps, character);
  return renderPrepare(deps, character, ritualInputs(deps, character, config, now), config, now);
}

/* ---------------- M2.88：流程 ---------------- */

/** 目标序列的仪式与拆出来的步骤（拿不到就是「原作未载具体步骤」） */
function flowOf(deps: RouterDeps, character: InitiatedCharacter) {
  const rite = deps.advancementRites.find(
    (entry) => entry.pathway === character.pathway && entry.seq === character.sequence - 1,
  );
  if (rite === undefined) return null;
  const steps = parseRitualSteps(rite.ritual);
  return steps.length === 0 ? null : { rite, steps };
}

function readProgress(deps: RouterDeps, character: InitiatedCharacter): RitualProgress | null {
  const raw = deps.flags.value(character.id, FLAG_RITUAL_FLOW);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as RitualProgress;
  } catch {
    // 脏值当作没有 —— 宁可从头开始，也不要因为一个坏 JSON 让这个命令永远打不开
    return null;
  }
}

function writeProgress(deps: RouterDeps, character: InitiatedCharacter, p: RitualProgress, now: number): void {
  deps.flags.set(character.id, FLAG_RITUAL_FLOW, now, JSON.stringify(p));
}

function showFlow(ctx: CommandContext, character: InitiatedCharacter): CommandResult {
  const { deps } = ctx;
  const got = flowOf(deps, character);
  if (got === null) {
    return {
      privateText:
        '这一步没有可拆的流程 —— **原作未载具体要求**，直接准备仪式即可。\n' +
        '> 原作对低序列的晋升本就只写「服食魔药」，没有仪式流程。那不是缺口。',
      detailToPrivate: true,
    };
  }
  const { rite, steps } = got;
  const progress = readProgress(deps, character) ?? {
    riteId: rite.id,
    done: steps.map(() => 0),
    startedAt: ctx.now,
  };
  const idx = currentStepIndex(steps, progress);
  const done = isFlowComplete(steps, progress);
  const lines: string[] = [
    '【仪式 · 流程】晋升「' + rite.sequenceTitle + '」',
    '> 原作记载：' + rite.ritual,
    '',
    flowLine(steps, progress),
    '',
  ];
  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i]!;
    const d = progress.done[i] ?? 0;
    lines.push((d >= s.times ? '✓ ' : i === idx ? '▶ ' : '　 ') + RITUAL_STEP_LABELS[s.kind] +
      (s.times > 1 ? '　' + d + '/' + s.times : '') + '　' + s.what);
  }
  lines.push('');
  if (done) {
    lines.push('整条路走完了。现在可以去 `.仪式 融合` 了。');
  } else {
    lines.push(
      '下一步：' + RITUAL_STEP_LABELS[steps[idx]!.kind] + '　' + steps[idx]!.what,
      '> 发 `.仪式 推进` 去做一次。每做一次掷一次 —— **可能失败**，失败不倒退但要重来。',
      '> 别人也可能在这条路上伸手（交恶的高序列会搅你的仪式）。',
    );
  }
  return {
    privateText: lines.join('\n'),
    detailToPrivate: true,
    nextActions: done
      ? [{ label: '去融合', command: '仪式 融合' }, { label: '准备菜单', command: '仪式 准备' }]
      : [{ label: '推进一次', command: '仪式 推进' }, { label: '准备菜单', command: '仪式 准备' }],
  };
}

/**
 * 这一步会不会有人来搅。
 *
 * 逐个查「与这个人交恶的高序列」，按 `sabotageChance` 掷 ——
 * 命中就返回他是谁。**每掷一次都消耗 rng**，所以结果是确定的
 * （`ofCharacter` 的顺序稳定，同一条消息重放得到同一个结果）。
 */
function pickFlowSaboteur(
  ctx: CommandContext,
  character: InitiatedCharacter,
  rng: { next(): number },
): { npcId: string; name: string; sequence: number } | null {
  const rels = ctx.deps.npcRelations.ofCharacter(character.id);
  for (const rel of rels) {
    // ⚠️ 走 npcSequenceOf（设定层兜底 + 运行时覆盖）—— 直接读 npcProgress 会让所有人都是 9
    const sequence = npcSequenceOf(ctx.deps, rel.npcId);
    const chance = sabotageChance(sequence, rel.affinity, character.sequence);
    if (chance <= 0) continue;
    if (rng.next() >= chance) continue;
    const name = ctx.deps.npcRoster.nameOf(rel.npcId);
    return { npcId: rel.npcId, name, sequence };
  }
  return null;
}

/**
 * **掷一次流程判定**（M2.89）—— 从 `.仪式 推进` 里抽出来，因为**探索也要用**。
 *
 * ## 为什么要抽
 *
 * 用户否掉计时模型的原话是「拿现实时间去要求就是纯折磨」，而第一版改成流程之后，
 * 唯一的推进方式是 `.仪式 推进` —— **点 12 次**。
 * 那仍然不是「玩着玩着就走完了」，只是把折磨从时钟搬到了手指上。
 *
 * 所以真正的解法是：**日常动作也在推进它**。而只要有两处推进，逻辑就必须只有一份
 * （抄两遍的下场是「探索里的那一份改了、按钮那一份忘了」——这个项目里已经发生过很多次）。
 *
 * ## 返回值
 *
 * `lines` 是给玩家看的（调用方决定插在哪），`done` 表示这一步走没走成。
 */
export function runFlowStep(
  deps: RouterDeps,
  character: InitiatedCharacter,
  now: number,
  seedKey: string,
): { lines: string[]; advanced: boolean; sabotaged: boolean; complete: boolean } | null {
  const got = flowOf(deps, character);
  if (got === null) return null;
  const { rite, steps } = got;
  let progress = readProgress(deps, character);
  if (progress === null || progress.riteId !== rite.id) {
    progress = { riteId: rite.id, done: steps.map(() => 0), startedAt: now };
  }
  const idx = currentStepIndex(steps, progress);
  if (idx >= steps.length) return { lines: [], advanced: false, sabotaged: false, complete: true };
  const step = steps[idx]!;
  const rng = createSeededRng(seedFrom([seedKey, character.id, rite.id, String(idx), 'flow']));
  const saboteur = pickFlowSaboteur({ deps } as CommandContext, character, rng);
  if (saboteur !== null) {
    deps.npcRelations.bump(saboteur.npcId, character.id, -3, now);
    return {
      lines: [
        '**仪式 · 有人伸手**',
        sabotageResultLine(saboteur.name, false),
        sabotageTextFor(saboteur.sequence),
        '> ' + RITUAL_STEP_LABELS[step.kind] + ' 还是 ' + (progress.done[idx] ?? 0) + '/' + step.times,
      ],
      advanced: false,
      sabotaged: true,
      complete: false,
    };
  }
  const outcome = advanceStep(steps, progress, idx, rng.next());
  writeProgress(deps, character, outcome.progress, now);
  const after = outcome.progress.done[idx] ?? 0;
  if (outcome.kind === 'failed') {
    return {
      lines: ['**仪式 · 这一步没成**', '> ' + RITUAL_STEP_LABELS[step.kind] + ' ' + after + '/' + step.times + ' —— **失败不倒退**，但要重来。'],
      advanced: false,
      sabotaged: false,
      complete: false,
    };
  }
  if (outcome.kind === 'complete') {
    return {
      lines: ['**仪式 · 整条路走完了**', '> 现在可以去 `.仪式 融合` 了。'],
      advanced: true,
      sabotaged: false,
      complete: true,
    };
  }
  const stepDone = after >= step.times;
  return {
    lines: [
      '**仪式 · ' + RITUAL_STEP_LABELS[step.kind] + '**',
      '> ' + after + '/' + step.times + (stepDone ? '（这一步走完了）' : '') + '　' + step.what,
    ],
    advanced: true,
    sabotaged: false,
    complete: false,
  };
}

/**
 * **日常动作也在推进仪式流程**（M2.89 抽出，M2.90 铺到所有动作）。
 *
 * 用户否掉计时模型的原话是「拿现实时间去要求就是纯折磨」；而第一版改成流程之后，
 * 唯一的推进方式是 `.仪式 推进` —— **点 12 次**。那仍然不是「玩着玩着就走完了」，
 * 只是把折磨从时钟搬到了手指上。
 *
 * 所以凡是有分量的日常动作都推进它一次：探索 / 扮演 / 事件 / 战斗收场。
 * 判据是**这个动作是不是一次「在别处下的功夫」** —— 仪式流程的 sustain 步骤本来
 * 就写着「在做别的事时反复判定」，所以战斗输赢都算（失败的分量已经由战斗结算给过了，
 * 再叠加一次就是双重惩罚），而战斗**每一回合**不算（那只在同一个回合里重复掷骰）。
 *
 * ⚠️ **逻辑只有一份**：四个调用点全部走这个函数，谁都不许自己再拼一遍 ——
 * 抄两遍的下场是「探索那一份改了、别处忘了」，这个项目里已经发生过很多次。
 *
 * 返回要追加到回执的行：没有仪式 / 已经走完 ⇒ 空数组（调用方据此决定要不要那一行空行）。
 */
export function dailyFlowLines(
  deps: RouterDeps,
  character: CharacterState,
  now: number,
  seedKey: string,
): string[] {
  if (!isInitiated(character)) return [];
  const out = runFlowStep(deps, character, now, seedKey);
  return out === null ? [] : out.lines;
}

/**
 * `.仪式 推进` —— 玩家主动去做一次。
 *
 * ⚠️ **逻辑只有一份**：这里只负责把 `runFlowStep` 的结果翻译成回执，
 * 判定本身（掷骰 / 被人伸手 / 失败不倒退）全在 `runFlowStep` 里 ——
 * 因为**探索也在调用它**。抄两遍的下场是「探索那一份改了、按钮那一份忘了」。
 */
function advanceFlow(ctx: CommandContext, character: InitiatedCharacter): CommandResult {
  const { deps, msg, now } = ctx;
  const out = runFlowStep(deps, character, now, String(msg.messageId));
  if (out === null) {
    return { privateText: '这一步没有可推进的流程（原作未载具体要求）。', detailToPrivate: true };
  }
  if (out.lines.length === 0) {
    return { privateText: '整条路已经走完了 —— 发 `.仪式 融合` 吧。', detailToPrivate: true };
  }
  return {
    privateText: out.lines.join('\n'),
    detailToPrivate: true,
    nextActions: out.complete
      ? [{ label: '去融合', command: '仪式 融合' }, { label: '看流程', command: '仪式 流程' }]
      : [{ label: '再来一次', command: '仪式 推进' }, { label: '看流程', command: '仪式 流程' }],
  };
}

/* ---------------- 开始：阶段 1 + 阶段 2 ---------------- */

function startRitual(ctx: CommandContext, character: InitiatedCharacter): CommandResult {
  const { deps, msg, now } = ctx;
  const row = deps.rituals.preparingOf(character.id);
  if (!row) {
    return { privateText: '你还没有在准备仪式（先发 .仪式 准备 看看有哪些选择）。', detailToPrivate: true };
  }
  const config = row.config;
  const inputs = ritualInputs(deps, character, config, now);
  if (!config.locationId) {
    return { privateText: '还没有选地点（.仪式 准备 里有候选）。', detailToPrivate: true };
  }
  if (config.timeOfDay && config.timeOfDay !== inputs.timeOfDay) {
    return {
      privateText:
        '你把仪式定在了' + TIME_OF_DAY_LABELS[config.timeOfDay] + '，现在是' +
        TIME_OF_DAY_LABELS[inputs.timeOfDay] + ' —— 到点再来 .仪式 开始。',
      detailToPrivate: true,
    };
  }
  if (!inputs.check.ok) return { privateText: inputs.check.reason, detailToPrivate: true };

  /*
   * M2.76：取该序列对应的仪式档位。
   *
   * 档位决定**几关、每关多难、要几个见证人** —— 这些以前是全局常数，
   * 于是序列 9 与序列 3 做的是同一件事（只差公式里那一项序列惩罚）。
   */
  const profile = ritualProfileFor(deps.ritualProfiles, character.pathway, character.sequence);
  if (config.witnesses.length < profile.witnessMin) {
    return {
      privateText:
        profile.name + '至少要 ' + profile.witnessMin + ' 个见证人（你现在 ' +
        config.witnesses.length + ' 个）。' +
        '发 .仪式 见证 让队友站到你身边 —— 到这一档，「一个人躲起来偷偷升」不再成立。',
      detailToPrivate: true,
    };
  }

  const seed = seedFrom([msg.messageId, character.id, now, 'ritual-setup']);
  const setup = resolveRitualSetup({
    chance: inputs.chance,
    materials: inputs.materials,
    rng: createSeededRng(seed),
    profile,
  });
  /*
   * 把累积惩罚写进仪式配置 —— 融合关在**另一次调用**里跑，中间只共享这一份配置。
   * 不写下来，融合关就只能靠 `stage >= 2` 那个旧判据（它只在固定两关下成立）。
   */
  deps.rituals.updateConfig(row.id, { ...config, fusePenalty: setup.fusePenalty });
  const breakdown = ritualChance(inputs.chance);

  const events = [{
    type: 'ritual_setup',
    characterId: character.id,
    payload: {
      ritualId: row.id,
      locationId: config.locationId,
      chance: breakdown.final,
      reachedStage: setup.reachedStage,
      interrupted: setup.interrupted,
      rolls: setup.stages.map((stage) => stage.roll),
    },
    reason: '仪式阶段 1/2 判定',
    seed,
    createdAt: now,
  }];

  const lines: string[] = [];
  lines.push('【仪式 · 进行中】' + (inputs.locationName ?? ''));
  lines.push('');
  lines.push(...stageLines(setup.stages));

  if (setup.interrupted) {
    if (setup.materialLoss.length > 0) deps.inventory.tryRemoveMany(character.id, setup.materialLoss, now);
    deps.rituals.resolve(row.id, 'interrupted', '布置失败', now);
    deps.characters.appendEvents(events);
    lines.push('');
    lines.push(...setup.narrative);
    if (setup.materialLoss.length > 0) {
      lines.push('');
      lines.push('损失：' + setup.materialLoss.map((need) => need.itemId + ' ×' + need.qty).join('、'));
    }
    const line = outcomeLine('interrupt', character.name);
    return {
      privateText: lines.join('\n') + '\n\n' + line.private,
      groupText: line.group,
      detailToPrivate: true,
    };
  }

  deps.rituals.markRunning(row.id, setup.reachedStage, now);
  deps.characters.appendEvents(events);
  lines.push('');
  lines.push(...setup.narrative);
  if (setup.fusePenalty !== 0) {
    lines.push(
      '融合的成功率会是 ' + ((breakdown.final + setup.fusePenalty) * 100).toFixed(1) + '%' +
      '（前面有 ' + (setup.fusePenalty / -0.2).toFixed(0) + ' 关没稳住，累计 ' +
      (setup.fusePenalty * 100).toFixed(0) + '%）。',
    );
  }
  lines.push('');
  lines.push('发 .仪式 融合 做最后一步。' +
    '（' + Math.round(NUMERIC.interference.windowMs / 60000) + ' 分钟内，附近的人可能来搅局 —— 群里已经有人看见你了。）');
  /*
   * M2.17（任务 B2）：**教义检查点之三 —— 仪式开始之后**。
   *
   * location 用 config.locationId（仪式定在哪就在哪判）——
   * 与「不得在某某地举行仪式」这类判据的字面语义完全一致。
   */
  const taboo = checkTaboosFor(ctx, character, 'ritual', {
    locationId: config.locationId,
    cityId: deps.geo.cityOfLocation(config.locationId)?.id ?? character.currentCityId ?? null,
  });
  lines.push(...taboo.receipt);

  return {
    privateText: lines.join('\n'),
    // M2.5 §4.4：仪式开始要**匿名**播到群里 —— 它的价值就是给别人反应时间
    groupText: '某处有人在举行仪式。',
    detailToPrivate: true,
  };
}

/**
 * M2.85 RPG 化：**谁会来搅你的仪式**（用户拍板「某些强大的高序列交恶了可能破坏晋升仪式」）。
 *
 * 挑人规则见 domain/ritual/sabotage.ts：交恶（≤ −25）+ 序列 ≤ 6 + 掷骰。
 * 返回值带名字与序列，方便回执说清「是谁动的手」。
 */
function pickRitualSaboteur(
  deps: RouterDeps,
  character: InitiatedCharacter,
  now: number,
): { npcId: string; name: string; sequence: number } | null {
  const dispById = new Map(deps.npcDispositions.map((d) => [d.npcId, d]));
  const rng = createSeededRng(seedFrom([character.id, String(now), 'ritual-sabotage']));
  const playerSeq = character.sequence ?? 9;
  for (const rel of deps.npcRelations.ofCharacter(character.id)) {
    if (dispById.get(rel.npcId) === undefined) continue;
    // ⚠️ M2.90：同 pickFlowSaboteur —— 设定层兜底，不许再出现 `?? 9`
    const sequence = npcSequenceOf(deps, rel.npcId);
    const chance = sabotageChance(sequence, rel.affinity, playerSeq);
    if (chance <= 0) continue;
    if (rng.next() < chance) {
      return { npcId: rel.npcId, name: deps.npcRoster.nameOf(rel.npcId), sequence };
    }
  }
  return null;
}

/* ---------------- 融合：阶段 3 ---------------- */

function fuseRitual(ctx: CommandContext, character: InitiatedCharacter): CommandResult {
  const { deps, msg, now } = ctx;
  const row = deps.rituals.runningOf(character.id);
  if (!row) {
    return { privateText: '你现在没有正在进行的仪式（先 .仪式 准备 再 .仪式 开始）。', detailToPrivate: true };
  }
  // 超时没融合 = 仪式散了：把这条 running 记成中断，别让它永远挂着
  if ((row.startedAt ?? 0) + RITUAL.runTimeoutMs <= now) {
    deps.rituals.resolve(row.id, 'interrupted', '超时未融合', now);
    return {
      privateText:
        '这场仪式已经散了 —— 从开始到现在超过 ' + Math.round(RITUAL.runTimeoutMs / 60000) +
        ' 分钟都没融合，气机自己散掉了（材料没有损失，可以重新准备）。',
      detailToPrivate: true,
    };
  }
  const config = row.config;
  const inputs = ritualInputs(deps, character, config, now);
  const seed = seedFrom([msg.messageId, character.id, now, 'ritual-fuse']);
  const flagsToSet = [abilityFlag(character.pathway, inputs.targetSequence)];
  /*
   * M2.85：**在你最输不起的时刻伸手**。
   *
   * 晋升仪式是玩家把全部材料与前途押上去的那一刻 —— 交恶的高序列者会挑这里动手。
   * 惩罚直接加进 fusePenalty（与「布置没做好」的累积惩罚同一条路），
   * 于是「配置拉满 95%」也可能被压到翻车 —— 而那正是它的意义。
   */
  const saboteur = pickRitualSaboteur(deps, character, now);
  const sabotageLoss = saboteur === null ? 0 : sabotagePenalty(saboteur.sequence, character.sequence ?? 9);
  if (saboteur !== null) {
    deps.worldEvents.insert({
      id: 'ritual-sabotage-' + character.id + '-' + now,
      type: 'power',
      text: `【世界 · 仪式被搅】${saboteur.name}\n${sabotageTextFor(saboteur.sequence)}`,
      visibility: 'public',
      createdAt: now,
    });
    deps.characters.appendEvents([{
      type: 'ritual_sabotaged',
      characterId: character.id,
      payload: { npcId: saboteur.npcId, sequence: saboteur.sequence, penalty: sabotageLoss / 100 },
      reason: '晋升仪式被交恶者破坏',
      seed: null,
      createdAt: now,
    }]);
  }
  const fuse = resolveRitualFuse({
    chance: inputs.chance,
    setupStage: row.stage,
    // M2.76：优先用开始那一关算出来的累积惩罚（老行没有这一项，回落到 setupStage）
    // M2.85：再加上「有人来搅」的那一份
    fusePenalty: (config.fusePenalty ?? 0) + sabotageLoss / 100,
    materials: inputs.materials,
    targetSequence: inputs.targetSequence,
    flagsToSet,
    rng: createSeededRng(seed),
  });

  if (fuse.materialLoss.length > 0) deps.inventory.tryRemoveMany(character.id, fuse.materialLoss, now);
  const applied = applyFor(
    deps,
    character,
    fuse.deltas,
    '仪式:' + character.sequence + '->' + inputs.targetSequence,
    now,
    seed,
  );
  const state = {
    ...applied.newState,
    status: fuse.status,
    promotionFails: fuse.outcome === 'success' ? 0 : (character.promotionFails ?? 0) + 1,
    updatedAt: now,
  };
  if (fuse.flagsToSet.length > 0) deps.flags.setMany(character.id, fuse.flagsToSet, now);
  deps.characters.update(state);
  deps.characters.appendEvents([
    ...applied.events,
    {
      type: fuse.outcome === 'success' ? 'ritual_success' : 'ritual_fail',
      characterId: character.id,
      payload: {
        ritualId: row.id,
        locationId: config.locationId,
        from: character.sequence,
        to: inputs.targetSequence,
        chance: fuse.finalChance,
        roll: fuse.stage.roll,
        setupStage: row.stage,
        interferenceCount: config.interferenceCount,
      },
      reason: '仪式阶段 3 判定',
      seed,
      createdAt: now,
    },
  ]);
  deps.rituals.resolve(row.id, fuse.outcome === 'success' ? 'success' : 'failed', fuse.outcome, now);
  deps.rituals.clearPreparing(character.id);

  const lines: string[] = [];
  lines.push('【仪式 · 融合】' + (inputs.locationName ?? ''));
  lines.push('');
  lines.push(...stageLines([fuse.stage]));
  lines.push('');
  lines.push(...fuse.narrative);
  if (fuse.materialLoss.length > 0) {
    lines.push('');
    lines.push('材料损失：' + fuse.materialLoss.map((need) => need.itemId + ' ×' + need.qty).join('、'));
  }
  lines.push('');
  lines.push(...renderDeltaSummary(applied.events, false, (id) => deps.items.nameOf(id)));
  if (fuse.outcome === 'success') {
    const ability = deps.abilities.get(character.pathway + '_' + inputs.targetSequence);
    lines.push('');
    lines.push('你晋升为「' + (ability?.name ?? '未知') + '」。');
  } else {
    lines.push('');
    lines.push('你进入了重伤状态。连续失败 ' + state.promotionFails + ' 次。');
  }
  return {
    privateText: lines.join('\n'),
    // M2.5 §4.4：成功 / 失败都匿名播到群里（明细走私聊）
    groupText: outcomeLine(fuse.outcome, character.name).group,
    detailToPrivate: true,
  };
}
