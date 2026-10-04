import { NUMERIC } from '../../config/numeric.ts';
import { formatCurrency } from '../../domain/currency/index.ts';
import { CURRENCY_ITEM_ID } from '../../domain/item/item.ts';
import { hl } from '../../adapter/highlight.ts';
import type { CommandContext, CommandResult } from '../index.ts';
import { parsePositiveInt } from '../args.ts';
import { requireCharacter } from './common.ts';
// M2.101：背包按钮与菜单选项同源（两处各写一份迟早漂移）
// M2.103：markdown 的「参数指令」标签 —— 表格里那一格物品名本身就能点
import { canUseCmdTag, canUseCmdTags, cmdInputTag } from '../../domain/text-interaction.ts';

export const BAG_USAGE = '用法：.背包 [页码]';

export async function handleBag(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const character = gate.character;
  const page = parsePositiveInt(ctx.args[0]) ?? 1;

  const gold = ctx.deps.inventory.count(character.id, CURRENCY_ITEM_ID);
  // 货币单独一行显示，不计入格子数，也不出现在分页里
  const { slots, total, page: current, pages } = ctx.deps.inventory.paginate(
    character.id,
    page,
    NUMERIC.inventory.pageSize,
    { exclude: [CURRENCY_ITEM_ID] },
  );
  if (total === 0 && gold === 0) {
    return {
      privateText: '背包是空的。去 .探索 地点 找点东西回来。',
      groupText: `【${character.name}】的背包是空的。`,
      detailToPrivate: true,
    };
  }

  /*
   * M2.86：**风格化上色**（用户：「颜色也要做风格化，信息高光可以不仅仅用加粗了」）。
   *
   * 上色只给「一眼要看见的」：
   *   · 货币数字 → 金（它是背包里唯一的钱）
   *   · 绑定状态 → 「绑定」红（卖不掉、丢不得，是要紧事）
   *   · 物品名 → 亮色（一列名字里最好扫）
   * 其余保持原色 —— 表格本身已经是层次，全上色反而乱。
   */
  const c = ctx.deps.supportsColor === true;
  const lines: string[] = [`【背包】（第 ${current}/${pages} 页 · 共 ${total} 格）`];
  // M2.5 追加：货币按三层显示（金镑 / 苏勒 / 便士），存储仍然是便士整数
  lines.push('');
  lines.push('**货币**　' + hl(formatCurrency(gold), 'gain', c));
  if (slots.length > 0) {
    /*
     * ⚠️ 物品改成**表格**。原来是一列缩进的纯文本：
     *      主材料·战火余烬 × 1（非绑定）
     * 三样信息（名称 / 数量 / 绑定）挤在一行里，一屏十几件时根本扫不出哪件是哪件。
     * 表格让它们各占一列，而且与 .状态 的属性表是同一套视觉语言 ——
     * 玩家在两个命令里看到的结构一致，才不用重新学怎么读。
     */
    /*
     * M2.45 第七版：**「物品」这个小标题删掉了**。
     * 它正下方就是表头 `| 物品 | 数量 | 状态 |` —— 同一件事写两遍，
     * 而且两条竖线之间夹一行粗体字，视觉重量比表格本身还大。
     * 表头自己就是标题（与 `.状态` 的属性表是同一套视觉语言）。
     */
    /*
   * ⚠️ M2.105：**markdown 通道下不用表格，改成逐行列表**（实机截图给的证据）。
   *
   * 上一版把 `<qqbot-cmd-input>` 标签放进表格的单元格里，真机上**原样显示源码**：
   *
   *     <qqbot-cmd-input text=".
   *     %E8%A3%85%E5%A4%87%20...
   *
   * ⇒ **平台不解析表格单元格里的标签**（文档只写「指令操作目前仅在 markdown 支持」，
   *   没提表格；实测表格里的标签就是普通文本）。
   *
   * 所以 markdown 通道改成**一行一件**：标签在行首（客户端会把 `show` 渲染成可点标签），
   * 数量与绑定跟在后面。`show` 用**短名** —— 标签越长越容易折行，折了就不成标签了。
   *
   * 不支持 markdown 的通道（OneBot / 内存）仍然用表格：那边标签无效，表格是更好的读物。
   */
    const markdown = canUseCmdTags(c);
    lines.push('');
    if (!markdown) {
      lines.push('| 物品 | 数量 | 状态 |');
      lines.push('| :-- | --: | :-- |');
    }
    for (const slot of slots) {
      const bind = slot.bindType === 'bound' ? hl('绑定', 'danger', c) : '非绑定';
      const name = ctx.deps.items.nameOf(slot.itemId);
      const command = commandForSlot((id) => ctx.deps.items.get(id), slot.itemId);
      if (!markdown) {
        lines.push('| ' + name + ' | ' + slot.quantity + ' | ' + bind + ' |');
        continue;
      }
      /*
       * 短名给 `show`：标签按文本宽度占位，长了会折行，折行之后平台就不再把它当标签。
       * 完整名在 `command` 里（命令层认的是它）。
       */
      const short = shortBagName(name);
      // ⚠️ 长度超限就不给标签（官方限制 100 字符，见 canUseCmdTag 的注释）
      const usable = command !== null && canUseCmdTag(command, short);
      const head = usable ? cmdInputTag(command, short) : name;
      lines.push('· ' + head + '　×' + slot.quantity + '　' + bind);
    }
  }
  /*
   * M2.86：**线索不再列在这里**（用户：「背包里不应该附带线索的显示」）。
   *
   * 原来这一段会把每张线索的原文整段铺在背包里（任务书 §5.4 的旧口径）。
   * 问题有两个：
   *   · 背包是**物品清单**，线索不是物品 —— 它不占格子，混在里面是两套东西；
   *   · 线索原文一段就三四行，三张就把背包撑到接近通道的长度上限，
   *     而线索本身已经有 `.线索` 这个专门命令（还带翻页与产出地）。
   *
   * 但**不能一声不吭地撤掉** —— 玩家会以为线索丢了。所以留一行指路。
   */
  const clueCount = ctx.deps.clues.unusedOf(character.id).length;

  if (clueCount > 0) {
    lines.push('', `> 手上有 ${clueCount} 张配方线索 —— 发送 .线索 查看`);
  }
  // 空行不能省：表格只认空行作为终止（通道层 `blankAfterTables` 也会兜一道底）

  /*
   * ⚠️ M2.104：**底部翻页是 key 响应按钮，不是正文标签**（用户第五次说明）。
   *
   * 他说得很清楚：「**下一页要用 key 响应按钮**啊！谁让你把响应按钮删了的？
   * **我只让你改表格那里的**啊」——
   *
   * 也就是说这一处**分工是固定的**：
   *   表格里那一格物品名   ⇒ `<qqbot-cmd-input>`（点了把指令插进输入框）
   *   底部的翻页           ⇒ **keyboard 按钮**（消息下方那一排，`quickButtons`）
   *
   * 两件事**互不替代**：表格里的标签是「物品名本身就是入口」，
   * 底部的按钮是「这条消息的导航」。把后者也改成标签，等于把按钮区删了 —— 那是错的。
   */
  const navButtons = bagNavButtons(current, pages);
  /*
   * M2.104：**这一处的分工**（用户连续五轮把它说清楚了）——
   *
   *   表格里那一格物品名   `<qqbot-cmd-input>` 标签（点了把 `.使用 驱邪符` 插进输入框）
   *   底部的翻页           **key 响应按钮**（`quickButtons` → `commandButton`，type=2）
   *
   * 两件事互不替代：前者是「物品名本身就是入口」，后者是「这条消息的导航」。
   */
  return {
    privateText: lines.join('\n'),
    groupText: `【${character.name}】查看了背包（共 ${total} 格）。`,
    /*
     * 表格里的物品名已经自带入口（`<qqbot-cmd-input>`）⇒ 这里**只交翻页按钮**。
     * `quickButtons` 走的是 `commandButton`（`action.type = 2`）：点一下把 `.背包 2`
     * 插进输入框 —— 与卡片那四个固定按钮同一条路。
     */
    /*
     * M2.106：**翻页是响应式按钮**（点击直接执行，不是把指令插进输入框）。
     *
     * 走 `nextActions`：路由把它交给 `buildNextMenu` 的 `actions`，
     * 最后变成菜单的 `options` ⇒ 适配层的**回调按钮**（`action.type = 1`）。
     *
     * ⚠️ 两条路别搞混（用户连着两轮各说了一次）：
     *   `<qqbot-cmd-input>`（正文标签）  点了**把指令插进输入框** ← 物品名用这个
     *   `options` / `nextActions`        点了**直接执行**            ← 翻页用这个
     */
    ...(navButtons.length > 0 ? { nextActions: navButtons } : {}),
    detailToPrivate: true,
  };
}

/**
 * **这一格物品对应的指令**（M2.103）—— 不能用/不能装备的返回 `null`。
 *
 * 用户举的例子：第一格是驱邪符（可使用的物品）⇒ 那一格就是「驱邪符」这个可点标签，
 * 点一下把 `.使用 驱邪符` 插进输入框。「以此类推」—— 所以这里是**按物品类型**推指令：
 *
 *   魔药 ⇒ `.服用 X`（走的是另一条命令，见 use.ts 的分工）
 *   消耗品 / 符咒 / 封印物 ⇒ `.使用 X`
 *   武器 / 饰品 ⇒ `.装备 X`
 *   材料 / 货币 / 其它 ⇒ **null**（它们没有「用」这个动作，给了标签只会撞一句拒绝）
 */
export function commandForSlot(
  itemOf: (id: string) => { name?: string; kind?: string } | null | undefined,
  itemId: string,
): string | null {
  const item = itemOf(itemId);
  if (item === null || item === undefined) return null;
  const name = item.name ?? itemId;
  const kind: string = item.kind ?? '';
  if (kind === 'potion' || itemId.includes('魔药')) return '.服用 ' + name;
  if (kind === 'consumable' || kind === 'charm' || kind === 'sealed' || itemId.includes('封印物')) return '.使用 ' + name;
  // ⚠️ M2.106：**只认 weapon** —— 原来把 `trinket` 也算进来，于是「因蒂斯密信」那种
  // 杂项被判定成可装备，玩家点一下收到 `.装备 因蒂斯密信`（截图里就是这么错的）。
  if (kind === 'weapon') return '.装备 ' + name;
  return null;
}

/**
 * **底部翻页按钮**（M2.104）—— 用户：「下一页要用 **key 响应按钮**啊！谁让你把响应按钮删了的？
 * 我只让你改表格那里的啊」。
 *
 * 规则是他定的：
 *   第一页      ⇒ 只有「下一页」
 *   不是第一页  ⇒ 「上一页」+「下一页」
 *   只剩一页    ⇒ 一个都不给
 *
 * 与表格里的 `<qqbot-cmd-input>` 标签**互不替代**：那个是物品名本身当入口，这个是消息的导航。
 */
export function bagNavButtons(
  current: number,
  pages: number,
): Array<{ label: string; command: string }> {
  const buttons: Array<{ label: string; command: string }> = [];
  /*
   * ⚠️ M2.107：**这里的 command 不带前导点号**（实机截图给的证据）。
   *
   * 这两条按钮走 `nextActions` ⇒ 菜单 `options` ⇒ **回调按钮（type=1）**：
   * 平台回传 `id`，后端走 MENU_REPLY，把它当**玩家说的话**再解析一遍。
   * 带点号时那句变成了「.背包 2」⇒ 解析出命令名 `.背包` ⇒
   * 回执成了「**没有 .背包 这条指令**」。
   *
   * `nextActions` 的其它调用点（`equipment.ts` / `help.ts` / `clue.ts`）本来就是不带点号的 ——
   * 只有我这两行写错了。
   *
   * ⚠️ 与**正文标签**相反：`<qqbot-cmd-input>` 的 `text` **必须**带点号
   * （那是直接插进输入框的指令原文）。两条路的规矩不一样。
   */
  if (pages > 1 && current > 1) buttons.push({ label: '上一页', command: '背包 ' + (current - 1) });
  if (pages > 1 && current < pages) buttons.push({ label: '下一页', command: '背包 ' + (current + 1) });
  return buttons;
}

/**
 * 标签上显示的**短名**（M2.105）。
 *
 * ⚠️ 它不是为了好看：`<qqbot-cmd-input>` 的 `show` 是标签在消息里的宽度，
 * 长了就会折行，而**折行的标签平台不解析**（实机截图里那一整行源码就是这么来的）。
 * 所以这里取前几个字；完整名仍然在指令里（`commandForSlot` 用的是全名）。
 */
function shortBagName(name: string): string {
  const bare = name.replace(/^(主材料|辅助材料|魔药|材料)·/, '');
  return bare.length > 5 ? bare.slice(0, 5) + '…' : bare;
}
