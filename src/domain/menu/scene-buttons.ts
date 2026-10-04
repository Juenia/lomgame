/**
 * ⚠️ **已废弃（M2.86）—— 不要在新代码里用它。**
 *
 * 用户实机指出：「菜单的按钮为何是输入按钮？不是原生响应按钮？而且输入的按钮指令也是无效的」。
 * 病根就在这个文件：`QuickButton` 的语义是「**把指令插进输入框**」，
 * 玩家还得自己按发送，平台也不会回传任何东西 —— 那不是原生按钮。
 * 而且它的 `command` 要求**含前导点号**，写漏了点号就是一句无效指令
 * （本轮在 `.菜单` 上就犯了这个错：写了 `'菜单 2'`）。
 *
 * **正路**：用 `CommandResult.nextActions`（或 `options`）——
 * 它们走 `buildNextMenu` → `InteractiveOption`，平台回传 `id`、后端走 MENU_REPLY，
 * 那才是原生响应按钮。`src/domain/menu/next-menu.ts` 的 `buildLookNextMenu`
 * 就是一个例子（`.看` 之后给「走往 X」）。
 *
 * 文件保留是因为里面那份「按场景分组」的对照表还有参考价值；
 * 但函数本身不再被任何生产路径调用（`scene.ts` 的调用已于本轮移除）。
 *
 * ---- 以下为原文 ----
 */
/**
 * 按场景的尾巴按钮（M2.86）。
 *
 * ## 用户拍板（两次）
 *
 * > ① 「尾巴按钮需要按模板场景显示对应的按钮」
 * > ② 「模板的相关按钮应该是最少有一个**互相牵扯到下一步**的，
 * >     而不是三四个模板的按钮**形成一个圆**」
 *
 * 第 ② 条点出的是第一版的结构问题：`scene` 那套是「状态 / 查线索 / 背包 / 今日」——
 * 四个**平级**的查看动作，点哪个都只是「看一眼」，没有一个是**往前走**的。
 * 那就是用户说的「形成一个圆」：转来转去还在原地。
 *
 * ## 结构：**每套第一个是「推进」，其余是辅助**
 *
 * | 场景 | 推进（第一个） | 辅助 |
 * | --- | --- | --- |
 * | 站在某处 | **深入探索** `.探索` | 状态 / 背包 / 今日 |
 * | 战斗中 | **攻击** | 防御 / 撤退 |
 * | 探索后 | **再探一次** | 看看四周 / 状态 |
 * | 交易 | **确认** | 取消 / 背包 |
 * | 仪式 | **融合**（这才是往前走的那一步） | 开始 / 取消 |
 * | 看状态 | **去看** | 探索 / 今日 |
 *
 * 判据（改这一套时照它检查）：**问自己「点哪一个能让我离结局更近」** ——
 * 如果一个都没有，那这套按钮就是装饰。
 *
 * 场景由调用方**显式指定**（不猜正文 —— 猜错比不给更糟）；每套 ≤4 个（手机一行放不下更多）。
 */
import type { QuickButton } from '../../adapter/interactive.ts';

export type SceneKind = 'scene' | 'battle' | 'explore' | 'trade' | 'ritual' | 'status' | 'menu';

/**
 * 每种场景的尾巴按钮。
 *
 * ⚠️ **约定：第一个永远是「推进到下一步」的那一个**，其余才是辅助。
 * 顺序即优先级 —— 通道按顺序排按钮，玩家第一个看到的就是该走的那一步。
 */
export const SCENE_BUTTONS: Record<SceneKind, readonly QuickButton[]> = {
  /** 站在某个地方：推进 = 往这一带走一步（.探索），其余是查看 */
  scene: [
    { label: '深入探索', command: '.探索' },
    { label: '状态', command: '.状态' },
    { label: '查线索', command: '.查' },
    { label: '今日', command: '.今日' },
  ],
  /** 战斗中：推进 = 攻击（打完这一场），防御与撤退是应对 */
  battle: [
    { label: '攻击', command: '.战斗 攻击' },
    { label: '防御', command: '.战斗 防御' },
    { label: '撤退', command: '.战斗 撤退' },
  ],
  /** 探索后：推进 = 再探一次（同一地点收益递减，所以给的是「继续」而不是「重来」） */
  explore: [
    { label: '再探一次', command: '.探索' },
    { label: '看看四周', command: '.看' },
    { label: '状态', command: '.状态' },
  ],
  /** 交易：推进 = 确认（把这一笔定下来） */
  trade: [
    { label: '确认', command: '.确认' },
    { label: '取消', command: '.取消' },
    { label: '背包', command: '.背包' },
  ],
  /** 仪式：推进 = **融合**（阶段 3，真正把材料押上去的那一步） */
  ritual: [
    { label: '融合', command: '.仪式 融合' },
    { label: '开始', command: '.仪式 开始' },
    { label: '取消', command: '.仪式 取消' },
  ],
  /** 看状态：推进 = 去看（状态页读完了，下一步是回到场景） */
  status: [
    { label: '去看', command: '.看' },
    { label: '探索', command: '.探索' },
    { label: '今日', command: '.今日' },
  ],
  /** 通用兜底：推进 = 去看（不知道自己在哪时，先看一眼） */
  menu: [
    { label: '去看', command: '.看' },
    { label: '探索', command: '.探索' },
    { label: '状态', command: '.状态' },
    { label: '背包', command: '.背包' },
  ],
};

/** 取某个场景的按钮（最多 4 个，超了就截断 —— 手机上一行放不下更多） */
export function buttonsForScene(kind: SceneKind): QuickButton[] {
  return SCENE_BUTTONS[kind].slice(0, 4).map((b) => ({ ...b }));
}

/** 这一套里「推进到下一步」的那一个（第一个；给测试与调试用） */
export function nextStepButton(kind: SceneKind): QuickButton | undefined {
  return SCENE_BUTTONS[kind][0];
}