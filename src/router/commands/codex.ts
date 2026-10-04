/**
 * `.图鉴` —— M2.85 内容填充的**统一读取点**。
 *
 * ## 为什么需要它
 *
 * AGENTS §3 与 K19 都禁止「只写着没人读」的内容表。原作数据填进来的几张设定表
 * （神明 / 塔罗，后续还有组织 / 人物 / 生物名录）**必须有玩家能看到的地方** ——
 * 否则它们只是后台里的一份 JSON。
 *
 * ## 形状
 *
 *   `.图鉴`              分类与条数
 *   `.图鉴 神明`          按原作分类分组列出（正神 / 支柱级旧日 / 隐秘存在与邪神）
 *   `.图鉴 神明 黑夜女神`  详查（尊名 / 真名 / 途径 / 神国 / 象征 / 教会 / 来源）
 *   `.图鉴 塔罗` / `.图鉴 塔罗 愚者`
 *
 * ⚠️ 这里**只做展示**：所有文字都来自内容表（原作数据），不在命令层拼设定。
 */
import { PATHWAY_LABELS } from '../../domain/character/rules.ts';
import { EMOJI, withEmoji } from '../../domain/emoji.ts';
import type { Deity } from '../../domain/world/pantheon.ts';
import type { TarotCard } from '../../domain/divination/tarot.ts';
import type { Organization } from '../../domain/world/organization.ts';
import type { Figure } from '../../domain/world/figure.ts';
import { bestiaryKindOf, type BestiaryEntry } from '../../domain/world/bestiary.ts';
import type { DivineAuthority } from '../../domain/world/divine-authority.ts';
import { creaturesProducing, recipesNeeding, type OriginalMaterial } from '../../domain/world/original-material.ts';
import { abilitiesOfPathway, type PathwayAbility } from '../../domain/world/pathway-ability.ts';
import { climbersOf, hasGodOnPathway } from '../../domain/world/npc-track.ts';
import { stepsToGodhoodFrom } from '../../domain/world/npc-advance.ts';
import { DEED_EFFECT_LABELS } from '../../domain/world/pathway-deed.ts';
import { HISTORY_EVENT_TYPE_LABELS, type HistoryEvent } from '../../domain/world/history.ts';
import type { CommandContext, CommandResult } from '../index.ts';

export const CODEX_USAGE = '用法：.图鉴 [神明/塔罗] [名字]（不带参数看分类）';

/**
 * 分类小标题（M2.86：用户「上色的地方也少，该用 emoji 的也不要省」）。
 *
 * 抽成一个函数而不是改六处：这个文件里有**六个分类标题**（神明 / 塔罗 / 组织 /
 * 人物 / 生物 / 权柄 / 材料 / 能力），模板一模一样，逐个手改迟早漏一个。
 *
 * 只加 emoji 不加颜色：标题本身已经在行首、还有 `—` 包着，再上色就太吵了
 * （与「全篇都亮 = 全篇都不亮」同一条纪律）。
 */
function sectionTitle(label: string, count: number): string {
  return withEmoji(EMOJI.book, `— ${label}（${count}）—`);
}

/** 途径 id → 展示名（项目口径）；未映射的原作途径名直接照抄 */
function pathwayLabel(id: string): string {
  return (PATHWAY_LABELS as Record<string, string>)[id] ?? id;
}

function deityLine(deity: Deity): string {
  const paths = deity.pathways.length > 0
    ? deity.pathways.map(pathwayLabel).join('、')
    : (deity.pathwayNames.join('、') || '—');
  return `· ${deity.name}（${deity.category}）—— ${paths}`;
}

function indexText(ctx: CommandContext): string {
  return [
    '【图鉴】',
    `神明 ${ctx.deps.pantheon.length} 位 —— .图鉴 神明`,
    `塔罗 ${ctx.deps.tarot.length} 张 —— .图鉴 塔罗`,
    `组织 ${ctx.deps.organizations.length} 个 —— .图鉴 组织`,
    `人物 ${ctx.deps.figures.length} 人 —— .图鉴 人物`,
    /*
     * ⚠️ M2.93 起「生物名录」只列真生物（342），而这张表有 544 条 ——
     * 首页写 544 会与点进去看到的 342 对不上。两个数都写出来，说清差额是什么。
     */
    `生物 ${ctx.deps.bestiary.filter((b) => bestiaryKindOf(b) !== 'other').length} 条` +
      `（另有 ${ctx.deps.bestiary.filter((b) => bestiaryKindOf(b) === 'other').length} 条是材料与设定整理）—— .图鉴 生物`,
    `权柄 ${ctx.deps.divineAuthorities.length} 条 —— .图鉴 权柄`,
    `历史 ${ctx.deps.historyIndex.events.length} 条 —— .图鉴 历史（这个世界是怎么变成现在这样的）`,
    `材料 ${ctx.deps.originalMaterials.length} 种 —— .图鉴 材料`,
    `能力 ${ctx.deps.pathwayAbilities.length} 条 —— .图鉴 能力 <途径> [序列]`,
    `途径 —— .图鉴 途径 [名字]（这条途径的神 / 走在上面的人 / 距登神几档）`,
    '',
    '看某一条：.图鉴 神明 黑夜女神',
  ].join('\n');
}

function deityList(ctx: CommandContext): string {
  const groups = new Map<string, Deity[]>();
  for (const deity of ctx.deps.pantheon) {
    const list = groups.get(deity.category) ?? [];
    list.push(deity);
    groups.set(deity.category, list);
  }
  const lines: string[] = [`【神明 · ${ctx.deps.pantheon.length} 位】`];
  for (const [category, list] of groups) {
    lines.push('');
    lines.push(sectionTitle(category, list.length));
    for (const deity of list) lines.push(deityLine(deity));
  }
  lines.push('');
  lines.push('详查：.图鉴 神明 <名号>');
  return lines.join('\n');
}

function deityDetail(ctx: CommandContext, name: string): string {
  const key = name.trim();
  const deity = ctx.deps.pantheon.find((d) => d.name === key || d.id === key || d.aliases.includes(key));
  if (!deity) return `图鉴里没有叫「${key}」的神明。发 .图鉴 神明 看全部名单。`;
  const lines: string[] = [`【${deity.name}】${deity.category}`];
  if (deity.tier) lines.push(deity.tier);
  if (deity.nameEn) lines.push(`真名：${deity.nameEn}`);
  if (deity.trueName) lines.push(`真名：${deity.trueName}`);
  const paths = deity.pathways.length > 0 ? deity.pathways.map(pathwayLabel) : deity.pathwayNames;
  if (paths.length > 0) lines.push(`途径：${paths.join('、')}`);
  if (deity.aliases.length > 0) lines.push(`别名：${deity.aliases.join('、')}`);
  if (deity.status) lines.push(`状态：${deity.status}`);
  if (deity.godNameFull.length > 0) {
    lines.push('');
    lines.push('尊名：');
    for (const segment of deity.godNameFull) lines.push(`> ${segment}`);
  }
  if (deity.divineKingdom) lines.push(`神国：${deity.divineKingdom}`);
  if (deity.symbols.length > 0) lines.push(`象征：${deity.symbols.join('、')}`);
  if (deity.church) lines.push(`教会：${deity.church}`);
  if (deity.churchIds.length > 0) lines.push(`教会引用：${deity.churchIds.map((id) => ctx.deps.churches.byId(id)?.name ?? id).join('、')}`);
  if (deity.beliefOrgs.length > 0) lines.push(`信仰组织：${deity.beliefOrgs.join('、')}`);
  if (deity.essence.length > 0) lines.push(`本质：${deity.essence.join('；')}`);
  if (deity.appearance.length > 0) lines.push(`外貌：${deity.appearance.join('；')}`);
  if (deity.source) lines.push('', `来源：${deity.source}`);
  return lines.join('\n');
}

function tarotLine(card: TarotCard): string {
  return `${card.number}. ${card.name}（${card.nameEn}）—— ${pathwayLabel(card.pathway)}`;
}

function tarotList(ctx: CommandContext): string {
  const lines: string[] = [`【塔罗 · 大阿卡那 ${ctx.deps.tarot.length} 张】`];
  for (const card of [...ctx.deps.tarot].sort((a, b) => a.number - b.number)) lines.push(tarotLine(card));
  lines.push('');
  lines.push('详查：.图鉴 塔罗 愚者');
  return lines.join('\n');
}

function tarotDetail(ctx: CommandContext, name: string): string {
  const key = name.trim();
  const card = ctx.deps.tarot.find((c) => c.name === key || c.id === key || c.nameEn === key);
  if (!card) return `图鉴里没有叫「${key}」的牌。发 .图鉴 塔罗 看全部 22 张。`;
  const lines: string[] = [
    `【${card.name}】${card.number} · ${card.nameEn}`,
    `对应途径：${pathwayLabel(card.pathway)}（原作「${card.pathwayName}」）`,
    `序列 0：${card.sequence0}　序列 9：${card.sequence9}`,
  ];
  if (card.organizations.length > 0) lines.push(`关联组织：${card.organizations.join('、')}`);
  if (card.holder) lines.push(`持有者：${card.holder}`);
  lines.push('', `象征：${card.symbolism}`);
  if (card.storyNote) lines.push('', `故事：${card.storyNote}`);
  lines.push('', `来源：${card.evidence}`);
  return lines.join('\n');
}

function orgLine(org: Organization): string {
  const paths = org.pathways.length > 0 ? org.pathways.map(pathwayLabel).join('、') : (org.pathwayNames.join('、') || '—');
  return `· ${org.name}（${org.nation ?? org.era ?? '—'}）—— ${paths}`;
}

function orgList(ctx: CommandContext): string {
  const groups = new Map<string, Organization[]>();
  for (const org of ctx.deps.organizations) {
    const list = groups.get(org.category) ?? [];
    list.push(org);
    groups.set(org.category, list);
  }
  const lines: string[] = [`【组织与势力 · ${ctx.deps.organizations.length} 个】`];
  for (const [category, list] of groups) {
    lines.push('');
    lines.push(sectionTitle(category, list.length));
    for (const org of list) lines.push(orgLine(org));
  }
  lines.push('');
  lines.push('详查：.图鉴 组织 <名字>');
  return lines.join('\n');
}

function orgDetail(ctx: CommandContext, name: string): string {
  const key = name.trim();
  const org = ctx.deps.organizations.find((o) => o.name === key || o.id === key);
  if (!org) return `图鉴里没有叫「${key}」的组织。发 .图鉴 组织 看全部名单。`;
  const lines: string[] = [`【${org.name}】${org.category}${org.nameEn ? `（${org.nameEn}）` : ''}`];
  if (org.nation) lines.push(`所属：${org.nation}`);
  if (org.era) lines.push(`纪元：${org.era}`);
  if (org.nature) lines.push(`性质：${org.nature}`);
  const paths = org.pathways.length > 0 ? org.pathways.map(pathwayLabel) : org.pathwayNames;
  if (paths.length > 0) lines.push(`涉及途径：${paths.join('、')}`);
  if (org.structure.length > 0) { lines.push('', '结构：'); for (const s of org.structure) lines.push(`> ${s}`); }
  if (org.doctrine.length > 0) { lines.push('', '教义 / 主张：'); for (const s of org.doctrine) lines.push(`> ${s}`); }
  if (org.members.length > 0) lines.push('', `成员：${org.members.join('；')}`);
  if (org.playerRelation) lines.push('', `与玩家的关系：${org.playerRelation}`);
  if (org.note.length > 0) lines.push('', `注记：${org.note.join('；')}`);
  if (org.disputed) lines.push('', `存疑：${org.disputed}`);
  const from = org.sources.length > 0 ? org.sources[0]! : org.source;
  if (from) lines.push('', `来源：${from}`);
  return lines.join('\n');
}

function figureLine(figure: Figure): string {
  const paths = figure.pathways.length > 0 ? figure.pathways.map(pathwayLabel).join('、') : (figure.pathwayNames.join('、') || '—');
  return `· ${figure.name}（${figure.occupation ?? figure.category}）—— ${paths}`;
}

function figureList(ctx: CommandContext): string {
  const groups = new Map<string, Figure[]>();
  for (const figure of ctx.deps.figures) {
    const list = groups.get(figure.category) ?? [];
    list.push(figure);
    groups.set(figure.category, list);
  }
  const lines: string[] = [`【人物 · ${ctx.deps.figures.length} 人】`];
  for (const [category, list] of groups) {
    lines.push('');
    lines.push(sectionTitle(category, list.length));
    for (const figure of list) lines.push(figureLine(figure));
  }
  lines.push('');
  lines.push('详查：.图鉴 人物 <名字>');
  return lines.join('\n');
}

function figureDetail(ctx: CommandContext, name: string): string {
  const key = name.trim();
    // M2.85 数据兼容对齐：支持简称（「克莱恩」→「克莱恩·莫雷蒂」）—— 原著人物多用全名，玩家多半只记得名
  const figure = ctx.deps.figures.find((entry) =>
    entry.name === key || entry.id === key || entry.aliases.includes(key) ||
    entry.name.startsWith(key) || entry.name.includes(key) && key.length >= 2,
  ) ?? null;
  if (!figure) return `图鉴里没有叫「${key}」的人。发 .图鉴 人物 看全部名单。`;
  const lines: string[] = [`【${figure.name}】${figure.category}`];
  if (figure.aliases.length > 0) lines.push(`别名：${figure.aliases.join('、')}`);
  if (figure.gender) lines.push(`性别：${figure.gender}`);
  if (figure.nation) lines.push(`国籍 / 出身：${figure.nation}`);
  if (figure.occupation) lines.push(`职业：${figure.occupation}`);
  const paths = figure.pathways.length > 0 ? figure.pathways.map(pathwayLabel) : figure.pathwayNames;
  if (paths.length > 0) lines.push(`途径：${paths.join('、')}`);
  if (figure.sequence) lines.push(`序列：${figure.sequence}`);
  if (figure.ascent) lines.push(`轨迹：${figure.ascent}`);
  if (figure.organization.length > 0) {
    // M2.85 数据兼容对齐：原文 + 解出来的组织 id（能对上的才写）
    const refs = figure.organizationIds.map((id) => `${orgNameOf(ctx, id)}`).join('、');
    lines.push(`所属：${figure.organization.join('、')}${refs === '' ? '' : `  →  ${refs}`}`);
  }
  if (figure.origin) lines.push(`出身地：${figure.origin}`);
  if (figure.identity) lines.push('', `身份：${figure.identity}`);
  if (figure.relation) lines.push('', `关系：${figure.relation}`);
  if (figure.ending) lines.push('', `结局：${figure.ending}`);
  if (figure.note.length > 0) { lines.push('', '注记：'); for (const n of figure.note) lines.push(`> ${n}`); }
  if (figure.sources.length > 0) lines.push('', `来源：${figure.sources[0]}`);
  return lines.join('\n');
}

function beastLine(entry: BestiaryEntry): string {
  const extra = entry.isExtraordinary === true ? '（非凡）' : '';
  const uses = entry.usedIn.length > 0 ? ` · 用在 ${entry.usedIn.slice(0, 2).join('、')}${entry.usedIn.length > 2 ? '…' : ''}` : '';
  return `· ${entry.name}${extra}（${entry.creatureCategory ?? entry.category}）${uses}`;
}

function beastList(ctx: CommandContext): string {
  /*
   * M2.93：**只列「生物」。**
   *
   * 这张表 544 条里混着四种东西（材料清单 / 神话生物形态 / 整理笔记 / 真生物）——
   * 它们共用一张表是有理由的，但整表按 category 铺出来，玩家在「生物名录」底下会读到
   * 「血月与红月的关系」「红葡萄酒100毫升」这种东西（用户：「底部数据依旧有乱七八糟的数据」）。
   *
   * 现在按 `bestiaryKindOf` 分三类：creature 与 form 进列表，其余**不列**
   * —— 但仍可用 `.图鉴 生物 <名字>` 详查（主动查询与摆给人看是两件事）。
   */
  const groups = new Map<string, BestiaryEntry[]>();
  let listed = 0;
  for (const entry of ctx.deps.bestiary) {
    if (bestiaryKindOf(entry) === 'other') continue;
    const list = groups.get(entry.category) ?? [];
    list.push(entry);
    groups.set(entry.category, list);
    listed += 1;
  }
  const hidden = ctx.deps.bestiary.length - listed;
  const lines: string[] = [`【生物名录 · ${listed} 条】`];
  for (const [category, list] of groups) {
    lines.push('');
    lines.push(sectionTitle(category, list.length));
    // 大表只列前 5 条，避免一条消息刷屏
    for (const entry of list.slice(0, 5)) lines.push(beastLine(entry));
    if (list.length > 5) lines.push(`  …还有 ${list.length - 5} 条，发 .图鉴 生物 <名字> 详查`);
  }
  if (hidden > 0) {
    lines.push('');
    /*
     * 把「没列出来的那些是什么」说清楚 —— 不说的话，读过旧版的人会以为内容丢了。
     * 数字是**算出来的**（总量减掉列出的），不是写死的。
     */
    lines.push(`（另有 ${hidden} 条和生物共用一张表，但它们不是生物 ——` +
      '一部分是**材料清单**（魔药要用的那些原料与物种），一部分是**设定整理**' +
      '（资料里的存疑记录、事件案例、变异向量…）。');
    lines.push('找材料发 .图鉴 材料；要找某一条的具体记载，直接 .图鉴 生物 <名字>。');
  }
  lines.push('');
  lines.push('详查：.图鉴 生物 <名字>');
  return lines.join('\n');
}

function beastDetail(ctx: CommandContext, name: string): string {
  const key = name.trim();
  const entry = ctx.deps.bestiary.find((b) => b.name === key || b.id === key || b.aliases.includes(key));
  if (!entry) return `名录里没有叫「${key}」的生物。发 .图鉴 生物 看全部。`;
  const lines: string[] = [`【${entry.name}】${entry.category}${entry.creatureCategory ? `（${entry.creatureCategory}）` : ''}`];
  if (entry.aliases.length > 0) lines.push(`别名：${entry.aliases.join('、')}`);
  const paths = entry.pathways.length > 0 ? entry.pathways.map(pathwayLabel) : entry.pathwayNames;
  if (paths.length > 0) lines.push(`涉及途径：${paths.join('、')}`);
  // M2.85 数据兼容对齐：这条生物在机制层能不能遇到
  const live = ctx.deps.creatureIndex.all().find((c) => c.bestiaryId === entry.id || c.name === entry.name);
  if (live) lines.push(`可遭遇：是（物种 ${live.id}，序列 ${live.baseSequence}，HP ${live.baseHp}）—— 发 .战斗 会遇到它`);
  /*
   * M2.93：只有**真生物**才说「可遭遇：否」。材料清单与设定整理（整理笔记 / 事件案例…）
   * 本来就不是拿来遭遇的，对它们说「本版没有把它做成遭遇生物」是答非所问。
   */
  else if (bestiaryKindOf(entry) !== 'other') lines.push('可遭遇：否（设定层记载，本版没有把它做成遭遇生物）');
  if (entry.materials.length > 0) { lines.push('', '产出材料：'); for (const m of entry.materials) lines.push(`> ${m}`); }
  if (entry.usedIn.length > 0) lines.push(`用在：${entry.usedIn.slice(0, 12).join('、')}${entry.usedIn.length > 12 ? ' …' : ''}`);
  if (entry.habitat) lines.push(`栖息地：${entry.habitat}`);
  if (entry.appearance) lines.push(`外形：${entry.appearance}`);
  if (entry.detail) lines.push('', entry.detail);
  if (entry.note.length > 0) { lines.push('', '注记：'); for (const n of entry.note) lines.push(`> ${n}`); }
  if (entry.sources.length > 0) lines.push('', `来源：${entry.sources[0]}`);
  if (!entry.habitat && !entry.appearance) lines.push('', '（原作未记载它的栖息地与外形 —— 这一栏是空的，不是漏了）');
  return lines.join('\n');
}

function authorityList(ctx: CommandContext): string {
  const groups = new Map<string, DivineAuthority[]>();
  for (const entry of ctx.deps.divineAuthorities) {
    const key = entry.pathwayName;
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }
  const lines: string[] = [`【权柄与象征 · ${ctx.deps.divineAuthorities.length} 条】`, '（真神层次的能力概念；与会改天气的「权柄事件」不是一回事）'];
  for (const [pathway, list] of groups) {
    lines.push('');
    lines.push(sectionTitle(pathway, list.length));
    lines.push('  ' + list.map((e) => e.name.replace(/^象征：/, '')).join('、'));
  }
  lines.push('');
  lines.push('详查：.图鉴 权柄 <名字>');
  return lines.join('\n');
}

function authorityDetail(ctx: CommandContext, name: string): string {
  const key = name.trim();
  const entry = ctx.deps.divineAuthorities.find((e) => e.name === key || e.name.replace(/^象征：/, '') === key || e.id === key);
  if (!entry) return `没有叫「${key}」的权柄。发 .图鉴 权柄 看全部。`;
  return [
    `【${entry.name}】${entry.kind}`,
    `途径：${entry.pathway ? pathwayLabel(entry.pathway) : entry.pathwayName}（原作「${entry.pathwayName}」）`,
    '',
    entry.description || '（原作未附描述）',
    '',
    `来源：${entry.source ?? '—'}`,
  ].join('\n');
}

/*
 * M2.85 内容填充 P4：**原作材料全表**的读取点。
 *
 * 它把三样东西连起来：
 *   材料 → 需求它的配方（usedIn 的 途径:序列）
 *   材料 → 产出它的生物（反查 bestiary.materials 的文本）
 *   材料 → 原作的用法（用量写法 / 原文写法）
 */
function materialList(ctx: CommandContext): string {
  const groups = new Map<string, OriginalMaterial[]>();
  for (const material of ctx.deps.originalMaterials) {
    const key = material.kind === '' ? '其他' : material.kind;
    const list = groups.get(key) ?? [];
    list.push(material);
    groups.set(key, list);
  }
  const lines: string[] = [`【原作材料 · ${ctx.deps.originalMaterials.length} 种】`];
  for (const [kind, list] of groups) {
    lines.push('', sectionTitle(kind, list.length));
    // 只列被配方引用最多的那几种，避免一条消息刷屏
    const top = [...list].sort((a, b) => b.occurrenceCount - a.occurrenceCount).slice(0, 8);
    for (const material of top) lines.push(`· ${material.name}（${material.occurrenceCount} 处配方）`);
    if (list.length > 8) lines.push(`  …还有 ${list.length - 8} 种，发 .图鉴 材料 <名字> 详查`);
  }
  lines.push('', '详查：.图鉴 材料 <名字>');
  return lines.join('\n');
}

function materialDetail(ctx: CommandContext, name: string): string {
  const key = name.trim();
  const material = ctx.deps.originalMaterials.find((entry) => entry.name === key || entry.id === key);
  if (!material) return `材料表里没有「${key}」。发 .图鉴 材料 看全部。`;
  const lines: string[] = [`【${material.name}】${material.kind}`];
  const recipes = recipesNeeding(material);
  if (recipes.length > 0) {
    lines.push('需求它的配方：' + recipes.map((cell) => {
      const [pathway, seq] = cell.split(':');
      return `${pathway === undefined ? '?' : pathwayLabel(pathway)} 序列 ${seq ?? '?'}`;
    }).join('、'));
  }
  const creatures = creaturesProducing(ctx.deps.originalMaterials, ctx.deps.bestiary, material.name);
  lines.push('', creatures.length > 0
    ? `产出它的生物：${creatures.slice(0, 6).join('、')}${creatures.length > 6 ? ` 等 ${creatures.length} 种` : ''}`
    : '产出它的生物：原作没有把这种材料挂到任何生物身上 —— 那是原作的空白，不是漏了');
  // M2.85 数据兼容对齐：设定层材料 ↔ 玩法层物品
  lines.push('', material.itemId === null || material.itemId === ''
    ? '对应玩法物品：无（原著材料，本版没有做成可掉落的物品）'
    : `对应玩法物品：${material.itemId} —— 掉落 / 交易 / 配方都指向它`);
  if (material.quantitySamples.length > 0) lines.push('', `用量写法：${material.quantitySamples.join('、')}`);
  if (material.rawForms.length > 0) lines.push(`原文写法：${material.rawForms.join('、')}`);
  return lines.join('\n');
}

/**
 * M2.85 内容填充 P5：**原作能力清单**的读取点。
 *
 * `.图鉴 能力`               → 22 条途径各有多少条原著能力
 * `.图鉴 能力 愚者`          → 该途径 10 档的清单
 * `.图鉴 能力 愚者 8`        → 序列 8 那几条原文
 *
 * ⚠️ 这里显示的是**原著里这个序列能做什么**，不是项目给的数值 ——
 * 数值在 .状态 / 晋升回执里（abilities.yaml 那一层）。
 */
function pathwayIdOf(text: string): string | null {
  const key = text.trim();
  const labels = PATHWAY_LABELS as Record<string, string>;
  if (labels[key] !== undefined) return key;
  for (const [id, name] of Object.entries(labels)) {
    if (name === key || name.includes(key) && key.length >= 2) return id;
  }
  return null;
}

function abilityList(ctx: CommandContext, arg: string): string {
  const all = ctx.deps.pathwayAbilities;
  if (arg === '') {
    const byPath = new Map<string, number>();
    for (const ability of all) byPath.set(ability.pathway, (byPath.get(ability.pathway) ?? 0) + 1);
    const lines: string[] = [`【原作能力清单 · ${all.length} 条】`];
    for (const [id, count] of [...byPath.entries()].sort()) lines.push(`· ${pathwayLabel(id)}：${count} 条`);
    lines.push('', '详查：.图鉴 能力 <途径> [序列]');
    return lines.join('\n');
  }
  const parts = arg.split(/\s+/);
  const pathway = pathwayIdOf(parts[0] ?? '');
  if (pathway === null) return `没有这条途径：${parts[0] ?? arg}。发 .图鉴 能力 看全部途径。`;
  const seqRaw = parts[1];
  const seq = seqRaw === undefined ? undefined : Number(seqRaw);
  if (seq !== undefined && (!Number.isInteger(seq) || seq < 0 || seq > 9)) {
    return `序列要写 0—9（你写的是「${seqRaw}」）。`;
  }
  const list = abilitiesOfPathway(all, pathway, seq);
  if (list.length === 0) return `${pathwayLabel(pathway)} 序列 ${seq} 在原著里没有能力记载。`;
  const lines: string[] = [`【${pathwayLabel(pathway)}${seq === undefined ? '' : ' · 序列 ' + seq} · ${list.length} 条】（原作原文）`];
  let lastSeq = -1;
  for (const ability of list) {
    if (ability.seq !== lastSeq) {
      lines.push('', `— 序列 ${ability.seq}「${ability.sequenceTitle}」—`);
      lastSeq = ability.seq;
    }
    lines.push(`· ${ability.text}`);
  }
  return lines.join('\n');
}

/** M2.85 数据兼容对齐：组织 id → 中文名（找不到就退回 id） */
function orgNameOf(ctx: CommandContext, id: string): string {
  return ctx.deps.organizations.find((o) => o.id === id)?.name ?? id;
}

/**
 * M2.85 世界演化：**途径总览**（`.图鉴 途径`）。
 *
 * 回答的是这一个问题：**哪条途径有神、哪条没有、谁最接近补上那个位置**。
 * 数据来自两处：`pantheon.yaml`（原作里已经坐在神位上的 27 位）与 `npc-tracks.yaml`（还走在路上的人）。
 *
 * ⚠️ 目前是**静态**的 —— 表里写的「序列 1」不会随时间变。让它推进（NPC 登神 → 世界事件）
 * 是世界演化的下一步，本用例的末行会如实说明这一点。
 */
function pathwayOverview(ctx: CommandContext, arg: string): string {
  const labels = PATHWAY_LABELS as Record<string, string>;
  const idByName = (text: string): string | null => {
    const key = text.trim();
    if (labels[key] !== undefined) return key;
    for (const [id, entryName] of Object.entries(labels)) if (entryName === key || (key.length >= 2 && entryName.includes(key))) return id;
    return null;
  };
  const godsOf = (pid: string): string[] => ctx.deps.pantheon.filter((d) => (d.pathways as readonly string[]).includes(pid)).map((d) => d.name);
  if (arg === '') {
    const lines: string[] = [`【途径 · ${Object.keys(labels).length} 条】`];
    for (const pid of Object.keys(labels)) {
      const gods = godsOf(pid);
      const climbers = climbersOf(ctx.deps.npcTracks, pid);
      const top = climbers[0];
      lines.push(`· ${labels[pid]}：${gods.length > 0 ? `有神（${gods[0]}）` : '**无神**'}` +
        `｜走在上面的人 ${climbers.length}${top ? `，最深 ${top.name}（序列 ${top.currentSequence}）` : ''}`);
    }
    lines.push('', '详查：.图鉴 途径 <途径名>');
    return lines.join('\n');
  }
  const pid = idByName(arg);
  if (pid === null) return `没有这条途径：${arg}。发 .图鉴 途径 看全部。`;
  const gods = godsOf(pid);
  const climbers = climbersOf(ctx.deps.npcTracks, pid);
  const godOnPath = hasGodOnPathway(ctx.deps.npcTracks, pid);
  /*
   * M2.85 世界演化：**神位与序列都读世界当前状态，不读静态记载**。
   * 原作写的是「他是序列 1」，而世界可能已经让他走到序列 0 —— 两者冲突时，**世界优先**
   * （这正是「NPC 参与演化」的意思：他登神了，世界就得记住）。
   */
  const progressOf = (id: string) => ctx.deps.npcProgress.of(id);
  const worldGods = climbers.filter((c) => progressOf(c.id)?.sequence === 0 && progressOf(c.id)?.godhoodAt !== null);
  const lines: string[] = [`【${labels[pid]}】途径`];
  if (worldGods.length > 0) {
    lines.push('', `神位：${gods.join('、')}${gods.length > 0 ? '＋' : ''}${worldGods.map((g) => `**${g.name}**（世界演化 · 第 ${Math.max(0, Math.floor((progressOf(g.id)!.godhoodAt! - ctx.deps.npcProgress.all()[0]?.since! ) / 86_400_000))} 天前后登神）`).join('、')}`);
  } else {
    lines.push('', gods.length > 0 ? `神位：${gods.join('、')}` : '神位：**暂无**（原作里这条途径没有神）');
  }
  if (climbers.length === 0) lines.push('走在上面的人：原作没有记载这条途径上的人物。');
  else {
    lines.push('', `走在上面的人（${climbers.length}）：`);
    for (const c of climbers.slice(0, 6)) {
      const live = progressOf(c.id);
      // 世界当前序列优先于原作记载 —— 两者不同就明说「按原著是 X，世界已走到 Y」
      const cur = live === null ? c.currentSequence : live.sequence;
      const steps = stepsToGodhoodFrom(cur);
      const diff = live !== null && c.currentSequence !== null && live.sequence !== c.currentSequence
        ? `（按原著 ${c.currentSequence} → 世界当前 ${live.sequence}）`
        : `（原作记载 ${c.raw}）`;
      lines.push(`> ${c.name}｜序列 ${cur ?? '未载'}｜距登神 ${steps === null ? '——（已在神位或未载）' : steps + ' 档'}${diff}`);
    }
  }
  if (godOnPath) lines.push('', `⚠️ ${godOnPath.name} 在当前序列记载里已经是序列 0。`);
  else if (climbers.length > 0 && gods.length === 0) {
    const top = climbers[0]!;
    lines.push('', `⚠️ 这条途径**没有神**，而 ${top.name} 已经走到序列 ${top.currentSequence} —— 若此人登神，这条途径就有神了。`);
  }
  /*
   * M2.85：**这条途径上的人会做什么**（用户拍板「NPC 也要会做出符合自己途径的行为」）。
   * 读的是 pathway-deeds.yaml —— 每条途径 2 条，例：愚者「占卜」、猎人「猎杀」、死神「收尸」。
   */
  const deedsOfPath = ctx.deps.pathwayDeeds.filter((d) => d.pathway === pid);
  if (deedsOfPath.length > 0) {
    lines.push('', '这条途径上的人会做的事：');
    for (const d of deedsOfPath) {
      // 行为名与效果名相同时（如「猎杀」）只说一次，免得出现「猎杀（猎杀）」
      const effectLabel = DEED_EFFECT_LABELS[d.effect] === d.name ? '' : `（${DEED_EFFECT_LABELS[d.effect]}）`;
      lines.push(`> ${d.name}${effectLabel}｜序列 ${d.minSequence} 起｜${d.text.replace(/\{name\}/g, '他')}`);
    }
  }
  const deeds = ctx.deps.npcDeeds.recent(3);
  if (deeds.length > 0) {
    lines.push('', '【世界演化 · 最近】');
    for (const d of deeds) lines.push(`> ${d.detail}`);
  }
  lines.push('', '（这些 NPC 会**随世界时间自己往上走** —— 按原著进度，低序列按月、高序列按年。走到序列 0 就会发全服事件。）');
  return lines.join('\n');
}

/**
 * **世界历史**（M2.96）。
 *
 * ## 为什么补这一条入口
 *
 * `history.yaml` 27 条（含最近几批补的远古段：「最初」苏醒 / 九份源质 / 西大陆封印 /
 * 八大古神 / 夜之国 / 亵渎石板 / 黑铁纪元）在这之前**只影响机制** ——
 * 它们给出危险度加成、埋下封印物、写下势力旧仇，而**玩家在任何地方都读不到**：
 *
 *   `.图鉴 历史` → 「没有『历史』这一类」
 *   `.世界 地点 X` → 只有天气与危险度，没有「这里发生过什么」
 *
 * 也就是说：玩家脚下的每一寸地都带着几千年的因果，而他看不见。
 * 这是「显示个文本但没机制」的反面，同样是缺口。
 *
 * ## 一条纪律：`taboo_knowledge` 只报条数
 *
 * 「不该被知道的事」如果在这里写出来，设定就塌了 —— 所以详查只说
 * 「有 N 件事至今被按着」，不说是什么。谁按着、按的什么，得玩家自己在世界里撞。
 */
/** 距今多少年（`year` 是「距今年数」，0 = 现在这个纪元） */
function yearLabel(year: number): string {
  return year === 0 ? '现在' : year + ' 年前';
}

function historyLine(event: HistoryEvent): string {
  const brief = event.result.length > 44 ? event.result.slice(0, 44) + '…' : event.result;
  return `· ${event.name}（${yearLabel(event.year)}）—— ${brief}`;
}

function historyList(ctx: CommandContext): string {
  // 距今近的在前（year 小的在前）
  const events = [...ctx.deps.historyIndex.events].sort((a, b) => a.year - b.year);
  const groups = new Map<string, HistoryEvent[]>();
  for (const event of events) {
    const list = groups.get(event.type) ?? [];
    list.push(event);
    groups.set(event.type, list);
  }
  const lines: string[] = [
    `【世界历史 · ${events.length} 条】`,
    '（距今近的在前。每一条都改过这个世界的某个角落 —— 危险度、埋在地下的东西、谁跟谁结的仇。）',
  ];
  for (const [type, list] of groups) {
    lines.push('');
    lines.push(sectionTitle(HISTORY_EVENT_TYPE_LABELS[type as keyof typeof HISTORY_EVENT_TYPE_LABELS] ?? type, list.length));
    for (const event of list) lines.push(historyLine(event));
  }
  lines.push('');
  lines.push('详查：.图鉴 历史 <名字>');
  return lines.join('\n');
}

function historyDetail(ctx: CommandContext, name: string): string {
  const key = name.trim();
  const event = ctx.deps.historyIndex.events.find((e) => e.name === key || e.id === key);
  if (!event) return `历史里没有叫「${key}」的事。发 .图鉴 历史 看全部。`;
  const lines: string[] = [
    `【${event.name}】${HISTORY_EVENT_TYPE_LABELS[event.type as keyof typeof HISTORY_EVENT_TYPE_LABELS] ?? event.type} · ${yearLabel(event.year)}`,
    '',
    event.result,
  ];
  if (event.locations.length > 0) {
    const names = event.locations.map((id) => ctx.deps.locations.get(id)?.name ?? id);
    lines.push('', `涉及地方：${names.join('、')}`);
  }
  if (event.parties.length > 0) {
    const names = event.parties.map((id) => ctx.deps.powerIndex.byId(id)?.name ?? id);
    lines.push(`涉及势力：${names.join('、')}`);
  }
  const bits: string[] = [];
  if (event.effects.location_scars.length > 0) {
    bits.push(`${event.effects.location_scars.length} 处地方留了痕 —— 危险度与生态参数到今天还没退`);
  }
  if (event.effects.sealed.length > 0) bits.push(`${event.effects.sealed.length} 处底下还埋着东西（能挖出来）`);
  if (event.effects.power_relations.length > 0) {
    bits.push(`${event.effects.power_relations.length} 条势力关系是从这件事来的`);
  }
  if (event.effects.taboo_knowledge.length > 0) {
    bits.push(`${event.effects.taboo_knowledge.length} 件事至今被按着 —— 是谁按的、按的什么，这里不写`);
  }
  if (bits.length > 0) {
    lines.push('', '它留下的：');
    for (const bit of bits) lines.push(`> ${bit}`);
  }
  return lines.join('\n');
}

export async function handleCodex(ctx: CommandContext): Promise<CommandResult> {
  const [category, ...rest] = ctx.args;
  const name = rest.join(' ').trim();
  if (!category) return { privateText: indexText(ctx), detailToPrivate: true };
  if (category === '神明') {
    return { privateText: name ? deityDetail(ctx, name) : deityList(ctx), detailToPrivate: true };
  }
  if (category === '塔罗') {
    return { privateText: name ? tarotDetail(ctx, name) : tarotList(ctx), detailToPrivate: true };
  }
  if (category === '组织') {
    return { privateText: name ? orgDetail(ctx, name) : orgList(ctx), detailToPrivate: true };
  }
  if (category === '人物') {
    return { privateText: name ? figureDetail(ctx, name) : figureList(ctx), detailToPrivate: true };
  }
  if (category === '生物') {
    return { privateText: name ? beastDetail(ctx, name) : beastList(ctx), detailToPrivate: true };
  }
  if (category === '权柄') {
    return { privateText: name ? authorityDetail(ctx, name) : authorityList(ctx), detailToPrivate: true };
  }
  if (category === '历史') {
    return { privateText: name ? historyDetail(ctx, name) : historyList(ctx), detailToPrivate: true };
  }
  if (category === '材料') {
    return { privateText: name ? materialDetail(ctx, name) : materialList(ctx), detailToPrivate: true };
  }
  if (category === '能力') {
    return { privateText: abilityList(ctx, name), detailToPrivate: true };
  }
  if (category === '途径') {
    return { privateText: pathwayOverview(ctx, name), detailToPrivate: true };
  }
  return { privateText: `没有「${category}」这一类。\n\n` + indexText(ctx), detailToPrivate: true };
}
