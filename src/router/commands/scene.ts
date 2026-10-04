/**
 * `.看` 与 `.走`（M2.85 RPG 化）—— **把玩家放进空间里**。
 *
 * 用户拍板三件事：
 *   ① 要「游戏视角」而不是推事件卡（RPG 感）
 *   ② **普通人不知道非凡生物与非凡者的存在** —— 这是原著的世界观基石
 *   ③ 人称用**第三人称**（群友要能围观剧情）
 *
 * 于是这里最关键的一行是 `awareness`：
 *
 *   未入途径（mortal）   到一个有非凡生物的巷子里，只写「有什么东西就在近处」
 *   非凡者（initiated）  能看到「古老怨灵（序列 5）」
 *
 * ⚠️ 与既有指令的关系：**不替代任何东西**。`.探索` 仍是深入碰运气，`.移动` 仍是长途。
 */
import type { CommandContext, CommandResult } from '../index.ts';
import { requireCharacter } from './common.ts';
import { loadLocations } from '../../data/loader.ts';
import { isInitiated } from '../../domain/character/types.ts';
import { omenTextFor } from '../../domain/world/scheme-narrative.ts';
// M2.169：世界伤痕（神陨落 / 神战）叠加到地点上 —— 场景里的危险度也要算它
import { mergeScars } from '../../domain/world/world-scar.ts';
import { dangerWordOf } from '../../domain/scene/scene.ts';
import {
  atmosphereOf, findExit, mortalHintOf, pronounOf, renderScene,
  type Awareness, type Scene, type SceneBeast, type SceneExit,
} from '../../domain/scene/scene.ts';
import { worldSnapshotFor } from '../menu.ts';
import { weatherLabel } from '../../domain/world/weather.ts';
import { TIME_OF_DAY_LABELS } from '../../domain/world/clock.ts';

function whereOf(character: { currentLocationId?: string | null; currentCityId?: string | null }): string | null {
  return character.currentLocationId ?? character.currentCityId ?? null;
}

function worldOf(ctx: CommandContext, character: unknown, locationId: string | null) {
  // ⚠️ 必须传**真实角色**：worldSnapshotFor 会读角色卡（途径 / 序列）来算天时加成，
  //    第一版传了个空对象，运行时直接炸成「系统繁忙」。
  return worldSnapshotFor(ctx.deps, ctx.now, character as never, locationId ?? undefined);
}

/** 组一个场景（.看 与 .走 共用，保证两条路看到的画面一致） */
function sceneAt(ctx: CommandContext, locationId: string, character: { id: string; gender?: string | null }, awareness: Awareness): Scene | null {
  const all = loadLocations().locations;
  const byId = new Map(all.map((l) => [l.id, l]));
  // M2.169：场景里显示的危险度也要是**叠加伤痕之后**的
  const rawLoc = byId.get(locationId);
  const loc = rawLoc === undefined ? undefined : mergeScars(rawLoc, ctx.deps.worldScars?.atLocation(rawLoc.id) ?? []);
  if (!loc) return null;
  const isNight = worldOf(ctx, character, loc.id).clock.timeOfDay === 'night';
  const exits: SceneExit[] = (loc.adjacent ?? [])
    .map((id) => byId.get(id))
    .filter((l): l is NonNullable<typeof l> => l !== undefined)
    .map((l) => ({ locationId: l.id, name: l.name, danger: l.danger ?? 1 }));
  /*
   * 危险度过滤：安全街区不该站着高阶怪物（danger 1—2 只出序列 7 以上；3 → 5；4 → 3；5 → 不限）。
   * 判据取 danger 与地点自己的 min_seq 中更严格的那个 —— 内容表两处都写了，取严的不会错。
   */
  const danger = loc.danger ?? 1;
  /*
   * ⚠️ 稀有度（用户：「原作里非凡生物没有在城市里过度出现吧？」）。
   *
   * 生态机制把 293 个物种摊到 97 个地点上，于是每条街都有好几只 —— 那是**生态表**的形状，
   * 不是**世界**的形状。非凡生物在原著里是稀罕的、藏着的：城里多半什么都没有。
   * 所以这里按危险度同时压两件事：**能出现的有多强**，以及**最多出现几种**。
   *
   *   danger 1—2（安全街区）  序列 8 以上，最多 1 种 —— 而且多数时候一种也没有
   *   danger 3（不太平）      序列 6 以上，最多 2 种
   *   danger 4—5（危险/禁区）  放手，最多 4 种
   */
  const weakestAllowed = Math.max(
    danger <= 2 ? 8 : danger === 3 ? 6 : danger === 4 ? 4 : 1,
    Math.min(9, loc.min_seq ?? 9),
  );
  const maxKinds = danger <= 2 ? 1 : danger === 3 ? 2 : 4;
  const present = ctx.deps.creatures
    .atLocation(loc.id)
    .filter((c: { sequence: number }) => c.sequence >= weakestAllowed);
  // 同一物种来了三只就写「×3」——场景是画面，不是表格
  const beasts: SceneBeast[] = [];
  for (const c of present as Array<{ speciesId: string; sequence: number }>) {
    const name = ctx.deps.creatureIndex.byId(c.speciesId)?.name ?? c.speciesId;
    const hit = beasts.find((b) => b.name === name);
    if (hit === undefined) beasts.push({ name, sequence: c.sequence, note: '' });
    else hit.note = `×${(Number(hit.note.replace('×', '')) || 1) + 1}`;
  }
  beasts.sort((a, b) => a.sequence - b.sequence);
  /*
   * 凡人只看到**迹象**（而且只在这一格真的有东西时才给迹象）—— 绝不写物种名与序列。
   * 这正是「普通人不知道非凡生物的存在」在场景层的落地。
   */
  // 安全街区对凡人**完全正常**（没有「影子在动」这种东西）—— 只有不太平的地方才会露出迹象
  const hints = awareness === 'mortal' && beasts.length > 0 && danger >= 3
    ? [mortalHintOf(danger, locationId.length)]
    : [];
  /*
   * M2.85：**针对这个人的阴谋，现在露出端倪了吗**。
   *
   * 这是「有智慧的对立者」与「随机挨一刀」的分界线：
   * 阴谋走到 omen 阶段时，场景里会出现**不对劲的细节** —— 而它是可以用 .查 去追的。
   * 没有这一段，玩家只能等着挨打；有了它，反制才有落点。
   */
  const omens = ctx.deps.npcSchemes
    .activeOf(character.id)
    .filter((s) => s.stage === 'omen')
    .map((s) => omenTextFor(s.kind, {}));
  const others = ctx.deps.characters
    .all()
    .filter((c: { id: string; currentLocationId?: string | null }) => c.id !== character.id && c.currentLocationId === loc.id)
    .map((c: { name: string }) => c.name);
  /*
   * M2.85：**这里站着的人**。
   *
   * 在这之前场景里只有怪物 —— 街上没有人，那不叫世界。现在按 npc_progress.location_id 找出
   * 同地点的 NPC；凡人只看到「有个人」，非凡者能看到他是谁、走到哪一档。
   */
  /*
   * ⚠️ M2.164：名字走 npcRoster（轨道 + 名册两张表），不再只查轨道 ——
   * 否则住在这条街上的 120 位居民**一个都显示不出来**，而没有东西会报错。
   */
  // M2.164：街上不站死人（死者仍在 npc_progress 里 —— 那张表答的是「他走到哪一档」）
  const deadHere = ctx.deps.npcLife.deadIds();
  const here = ctx.deps.npcProgress
    .atLocation(loc.id)
    .flatMap((p) => {
      if (deadHere.has(p.npcId)) return [];
      const entry = ctx.deps.npcRoster.byId(p.npcId);
      return entry === null ? [] : [{ name: entry.name, sequence: p.sequence }];
    })
    .sort((a, b) => a.sequence - b.sequence);
  return {
    location: { id: loc.id, name: loc.name, danger, minSeq: loc.min_seq ?? 9, maxSeq: loc.max_seq ?? 1 },
    // M2.86：危不危险是「要不要继续待着」的唯一依据，正文里要有它
    danger,
    dangerLabel: dangerWordOf(danger),
    exits,
    beasts: awareness === 'initiated' ? beasts.slice(0, maxKinds) : [],
    // 凡人只知道「有人在那里」；非凡者（或对方主动表明身份时）才看得到名字与序列
    people: awareness === 'initiated'
      ? here.slice(0, 4).map((p) => `${p.name}（序列 ${p.sequence}）`)
      : here.slice(0, 4).map(() => '一个人'),
    hints,
    others,
    atmosphere: atmosphereOf(danger, isNight),
    omens,
  };
}

/** 回执头：天时三件套 */
function headOf(ctx: CommandContext, character: unknown, locationId: string | null): { time: string; weather: string; calamity: string } {
  const world = worldOf(ctx, character, locationId);
  return {
    time: TIME_OF_DAY_LABELS[world.clock.timeOfDay],
    weather: weatherLabel(world.weather),
    calamity: '',
  };
}

export async function handleLook(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const here = whereOf(gate.character);
  if (here === null) return { privateText: '这个角色还不知道自己站在哪 —— 先发 .创建 选一座城住下。', detailToPrivate: true };
  const awareness: Awareness = isInitiated(gate.character) ? 'initiated' : 'mortal';
  const scene = sceneAt(ctx, here, gate.character, awareness);
  if (scene === null) return { privateText: '这里查不到任何东西 —— 像是一个没有被画在地图上的地方。', detailToPrivate: true };
  const who = { name: gate.character.name, pronoun: pronounOf(gate.character.gender), awareness };
  // M2.86：只有走 markdown 的通道才上色（纯文本通道看到 <font> 字面量反而更糟）
  const body = renderScene(scene, headOf(ctx, gate.character, here), who, { supportsColor: ctx.deps.supportsColor === true });
  return {
    privateText: body,
    // M2.86：把正文里那批出口交出去 —— 「下一步」的按钮要用它，两边必须说同一批地方
    nextExits: scene.exits.map((exit) => ({ name: exit.name, danger: exit.danger })),
    /*
     * ⚠️ M2.86：这里**故意不挂 `interactive`**。
     *
     * 第一版在这里塞了 `{ options: [], quickButtons: scene那一套 }` —— 但 router 只在
     * `interactive.options.length > 0` 时才采用它（见 `sendReplies`），于是**整块被丢掉**，
     * 真机上仍然是「下一步菜单」那四个通用按钮。
     *
     * 而且那四个（状态/查线索/背包/今日）与「眼前有什么」无关，不算适应化。
     * 正确位置是 `domain/menu/next-menu.ts` 的 `buildLookNextMenu`：
     * 它拿得到 `world` 与 `after`，能给真正的「走往 X」。
     */
    detailToPrivate: true,
  };
}

export async function handleWalk(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const here = whereOf(gate.character);
  if (here === null) return { privateText: '这个角色还不知道自己站在哪 —— 先发 .创建。', detailToPrivate: true };
  const want = ctx.args.join(' ').trim();
  if (want === '') return { privateText: '走去哪？发 .看 看这一带能往哪走。', detailToPrivate: true };
  const awareness: Awareness = isInitiated(gate.character) ? 'initiated' : 'mortal';
  const from = sceneAt(ctx, here, gate.character, awareness);
  if (from === null) return { privateText: '这里没有路。', detailToPrivate: true };
  const exit = findExit(from.exits, want);
  if (exit === null) {
    return {
      privateText: `从【${from.location.name}】走不到「${want}」。这里通向：${from.exits.map((e) => e.name).join('、')}。`,
      detailToPrivate: true,
    };
  }
  ctx.deps.characters.update({ ...gate.character, currentLocationId: exit.locationId, updatedAt: ctx.now });
  const to = sceneAt(ctx, exit.locationId, gate.character, awareness);
  const pronoun = pronounOf(gate.character.gender);
  if (to === null) return { privateText: `${gate.character.name}走到了【${exit.name}】。`, detailToPrivate: true };
  const who = { name: gate.character.name, pronoun, awareness };
  return {
    /*
     * M2.86：**到达之后直接给「探索这里」**（用户：「减少不必要的指令交互」）。
     *
     * 原来的三步循环要打三次字：
     *   `.看` →（读出口）→ `.走 迷雾街区` →（到了）→ `.探索 迷雾街区`
     * 而第三步的地点名**刚刚就在正文里**，让玩家再抄一遍纯属浪费。
     * 给了这个按钮之后：`.看` 点「走往X」→ 点「探索这里」，**全程零打字**。
     */
    nextActions: [
      { label: '探索这里', command: '探索 ' + exit.name, preview: to.dangerLabel + ' · 这一带有什么' },
      { label: '看看四周', command: '看', preview: '还能往哪走' },
      { label: '状态', command: '状态' },
    ],
    privateText: `${gate.character.name}从【${from.location.name}】走到了【${exit.name}】。\n\n` + renderScene(to, headOf(ctx, gate.character, exit.locationId), who),
    detailToPrivate: true,
  };
}
