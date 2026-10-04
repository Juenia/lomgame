import { PATHWAY_LABELS } from '../../domain/character/rules.ts';
import { potionMpCost, resolveBrew } from '../../domain/potion/potion.ts';
import { recipeMaterials } from '../../domain/potion/recipe.ts';
import { recipeDisplayName } from '../../domain/display.ts';
import { createSeededRng, seedFrom } from '../../domain/rng.ts';
import type { CommandContext, CommandResult } from '../index.ts';
import { weatherLabel } from '../../domain/world/weather.ts';
import { applyFor, requireCharacter, worldViewFor } from './common.ts';
import { isInitiated, type PathwayId } from '../../domain/character/types.ts';
import { recipePathwaysOf } from './initiation-hooks.ts';
import { mortalGuard } from './mortal-guard.ts';
import { renderDeltaSummary } from './render.ts';
import { hl } from '../../adapter/highlight.ts';
import { EMOJI, withEmoji } from '../../domain/emoji.ts';

export const BREW_USAGE = '用法：.魔药 [配方]（例：.魔药 愚者9）；不带参数默认调本途径当前序列的配方';

export async function handleBrew(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const character = gate.character;
  const { deps, msg, now } = ctx;

  /*
   * M2.7.7：**普通人入口校验**（命令层，不进判定）。
   *
   * allowWhen 是这条规则唯一的例外：手里真有一张纸（配方线索）的
   * 普通人**必须**能调 —— 那是「自己找到配方」这条路的最后一步。
   * 没有那张纸的人拿到的是一句「你还没有走上途径，不知道魔药为何物」，
   * 而不是「材料不足」——后者会让他以为凑齐材料就能调。
   */
  const guard = mortalGuard(ctx, '魔药', {
    allowWhen: recipePathwaysOf(deps, character).length > 0,
  });
  if (guard) return guard;

  const query = ctx.args.join(' ').trim();

  /*
   * M2.7.6：普通人调的是**入途径那一瓶**（序列 9）。
   *
   * 「本途径当前序列」这个说法对他不成立 —— 他没有途径。他能调什么，
   * 完全取决于手上翻到过哪张线索（M2.85 起这是唯一的配方来源）。
   * 这一步也是「拿到配方」与「走上途径」之间唯一的门槛：
   * 配方到手 ≠ 材料到手，材料要他自己去凑（任务书 §2.3 路径 B）。
   */
  const initiated = isInitiated(character);
  const recipePathways: PathwayId[] = initiated
    ? [character.pathway]
    : recipePathwaysOf(deps, character);

  if (recipePathways.length === 0) {
    return {
      privateText: [
        '你手上没有配方。',
        '',
        '调制不是凭感觉能做出来的事 —— 你还没翻到过那张写着配方的纸。',
        '（去 .探索 —— 5% 能翻到；满 5 天后必出。发 .线索 看进展。）',
      ].join('\n'),
      detailToPrivate: true,
    };
  }

  const candidates = recipePathways.flatMap((pathway) => deps.recipes.forPathway(pathway));
  const recipe = query
    ? deps.recipes.find(query, initiated ? character.pathway : undefined)
    : initiated
      ? (candidates.find((entry) => entry.seq === character.sequence) ?? null)
      : (candidates.find((entry) => entry.seq === 9) ?? null);

  if (!recipe || !recipePathways.includes(recipe.pathway)) {
    /*
     * 两种「没有」，说法不一样：
     *   - 手上根本没有这份配方（普通人还没翻到那张纸）；
     *   - 有配方，但那不是他的途径（已入途径的人点了别人的配方）。
     * 合成一句会让第二种情况的人以为是系统没找到东西，而其实是「这不是你的路」。
     */
    if (recipe && initiated) {
      return {
        privateText: `${recipeDisplayName(recipe, deps.items)} 属于${PATHWAY_LABELS[recipe.pathway]}途径，你是${PATHWAY_LABELS[character.pathway!]}。`,
        detailToPrivate: true,
      };
    }
    // M2.40：候选清单念**魔药名**，不念配方 id
    const available = candidates.map((entry) => `${recipeDisplayName(entry, deps.items)}（序列 ${entry.seq}）`).join('、');
    return {
      privateText: `没有这份配方：${query || '默认'}\n你手上的配方：${available || '暂无'}`,
      detailToPrivate: true,
    };
  }
  if (initiated && recipe.seq !== character.sequence) {
    return {
      privateText: `这瓶魔药对应序列 ${recipe.seq}，你当前是序列 ${character.sequence}。`,
      detailToPrivate: true,
    };
  }

  // 材料与灵性：先校验，再扣（先扣后执行）
  const needs = recipeMaterials(recipe);
  const missing = needs.filter((need) => deps.inventory.count(character.id, need.itemId) < need.qty);
  if (missing.length > 0) {
    const detail = missing
      .map((need) => `${deps.items.nameOf(need.itemId)}（需要 ${need.qty}，现有 ${deps.inventory.count(character.id, need.itemId)}）`)
      .join('\n  ');
    return { privateText: `材料不足：\n  ${detail}`, detailToPrivate: true };
  }
  if (character.mp < potionMpCost()) {
    return {
      privateText: `灵性不足（需要 ${potionMpCost()}，当前 ${character.mp}），先休息或喝点东西。`,
      detailToPrivate: true,
    };
  }

  const seed = seedFrom([msg.messageId, character.id, now, 'brew']);
  // M2.2：月圆仪式成功率 +15%，天气也可能加减（都在 numeric.world.weather 里）
  const world = worldViewFor(deps, now, undefined, character.pathway ?? undefined);
  const outcome = resolveBrew({
    state: character,
    recipe,
    rng: createSeededRng(seed),
    seed,
    world: {
      successBonus: world.modifiers.potionSuccessBonus,
      lossOfControlMultiplier: world.modifiers.lossOfControlMultiplier,
    },
  });

  if (!deps.inventory.tryRemoveMany(character.id, outcome.consumed, now)) {
    return { privateText: '材料扣除失败，调制中止（未消耗任何材料）。', detailToPrivate: true };
  }

  const applied = applyFor(deps, character, outcome.deltas, `魔药:${recipe.id}`, now, seed);
  const state = applied.newState;
  const events = [...applied.events];
  for (const need of outcome.consumed) {
    events.push({
      type: 'item_delta',
      characterId: character.id,
      payload: { itemId: need.itemId, quantity: -need.qty },
      reason: `魔药:${recipe.id}`,
      seed,
      createdAt: now,
    });
  }
  if (outcome.success) {
    deps.inventory.add(character.id, outcome.productItemId, 1, 'unbound', now);
    events.push({
      type: 'item_gain',
      characterId: character.id,
      payload: { itemId: outcome.productItemId, quantity: 1, bindType: 'unbound' },
      reason: `魔药:${recipe.id}`,
      seed,
      createdAt: now,
    });
  }

  deps.characters.update(state);
  deps.characters.appendEvents(events);

  /*
   * M2.86：**分层 + 颜色 + 适应化按钮**（用户：「魔药模板的信息也要做分层格式化，
   * 带字体颜色和 >，底部的信息尾不需要附带，按钮做适应化」）。
   *
   * 层次：
   *   · 抬头 —— 成功率，成败上色；
   *   · `>` 引用块 —— 仪式与世界加成，它们是「条件」不是「事情」；
   *   · 正文 —— 叙事，一个字不动；
   *   · 结果行 —— 获得的东西上色。
   *
   * **尾注删掉**：原来那句「发送 .服用 魔药 把它喝下去。」是**教玩家打字**，
   * 而下面的按钮里就有「服用 XXX」。说一遍、按钮再说一遍是重复，
   * 而且玩家真去打字时还得把物品名抄对。
   */
  const bc = deps.supportsColor === true;
  const lines: string[] = [];
  lines.push(
    withEmoji(EMOJI.arcane, '调制 · ' + recipeDisplayName(recipe, deps.items))
      + ' · 成功率 ' + hl((outcome.successChance * 100).toFixed(1) + '%', outcome.success ? 'ok' : 'warn', bc),
  );
  lines.push(`> 仪式：${recipe.ritual}`);
  if (world.clock.fullMoon || world.modifiers.potionSuccessBonus !== 0) {
    lines.push(
      '> 世界加成：成功率 '
        + (world.modifiers.potionSuccessBonus >= 0 ? '+' : '') + (world.modifiers.potionSuccessBonus * 100).toFixed(0) + '% '
        + `（${world.clock.fullMoon ? '月圆' : weatherLabel(world.weather)}）`,
    );
  }
  lines.push('');
  lines.push(...outcome.narrative);
  lines.push('');
  if (outcome.success) {
    // 尾注（「发送 .服用 魔药 把它喝下去。」）已删 —— 按钮里就有「服用 XXX」
    lines.push(withEmoji(EMOJI.gain, '获得 ' + hl(deps.items.nameOf(outcome.productItemId), 'gain', bc) + ' × 1（非绑定）'));
  } else {
    lines.push(withEmoji(EMOJI.danger, hl('调制失败：材料没有回来。', 'danger', bc)));
  }
  const deltaLines = renderDeltaSummary(applied.events, bc, (id) => deps.items.nameOf(id));
  if (deltaLines.length > 0) lines.push(...deltaLines);
  lines.push('');
  lines.push(
    `当前：灵性 ${hl(state.mp + '/100', 'info', bc)} · 疯狂 ${hl(String(state.mad), state.mad >= 50 ? 'danger' : 'ok', bc)} · 污染 ${hl(String(state.cor), state.cor >= 50 ? 'danger' : 'ok', bc)}`,
  );

  return {
    privateText: lines.join('\n'),
    groupText: outcome.success
      ? `【${state.name}】的实验室里传出一声轻响，然后安静了。`
      : `【${state.name}】那边有东西烧糊了。`,
    detailToPrivate: true,
    /*
     * M2.86：**按钮适应化** —— 刚调完药，下一步就是「喝掉这一瓶」。
     *
     * 物品名要用**真正产出的那瓶**（`outcome.productItemId`），不是配方名 ——
     * `服用` 认的是背包里的物品 id。标签截到 6 字（官方按钮上限 10 字符）。
     */
    nextActions: outcome.success
      ? [
          {
            label: '服用' + deps.items.nameOf(outcome.productItemId).slice(0, 6),
            command: '服用 ' + outcome.productItemId,
            preview: '成为非凡者',
          },
          { label: '翻翻背包', command: '背包' },
          { label: '状态', command: '状态' },
          { label: '今日', command: '今日' },
        ]
      : [
          { label: '再试一次', command: '魔药 ' + recipe.pathway, preview: '材料够的话' },
          { label: '翻翻背包', command: '背包' },
          { label: '状态', command: '状态' },
        ],
  };
}
