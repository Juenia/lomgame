import type { CommandRouter } from '../index.ts';
import { handleAction } from './action.ts';
import { handleBag } from './bag.ts';
import { handleBrew } from './brew.ts';
import { handleCancel } from './cancel.ts';
import { handleConfirm } from './confirm.ts';
import { handleCreate } from './create.ts';
import { handleClue } from './clue.ts';
import { handleCodex } from './codex.ts';
import { handleDivination } from './divination.ts';
import { handleDrink } from './drink.ts';
import { handleEvent } from './event.ts';
import { handleFeedback } from './feedback.ts';
import { handleExplore } from './explore.ts';
import { handleLook, handleWalk } from './scene.ts';
import { handleInvestigate } from './investigate.ts';
import { handleEquipment } from './equipment.ts';
import { handleShop, handleSell } from './shop.ts';
import { handleQuest } from './quest.ts';
import { handleHelp } from './help.ts';
import { handleMenu } from './menu-image-cmd.ts';
import { handleMdProbe, mdProbeEnabled } from './mdprobe.ts';
import { handleParty } from './party.ts';
import { handlePlay } from './play.ts';
import { handlePromote } from './promote.ts';
import { handlePurify } from './purify.ts';
import { handleDoctor } from './doctor.ts';
import { handleDailyEncounter } from './encounter-cmd.ts';
import { handleRest } from './rest.ts';
import { handleStatus } from './status.ts';
import { handleCard } from './card.ts';
import { handleToday } from './today.ts';
import { handleTrade } from './trade.ts';
import { handleUse } from './use.ts';
import { handleWorld } from './world.ts';
// M2.169：插手神明的阴谋（.神战）
import { handleDivineWar } from './divine-war.ts';
import { handleThrone } from './throne.ts';
import { handleRitual } from './ritual.ts';
import { handleInterfere } from './interfere.ts';
import { handleAssault } from './assault.ts';
import { handleReport } from './report.ts';
import { handleMove } from './move.ts';
import { handleEncounter } from './encounter.ts';
import { handleBattle } from './battle.ts';
import { handleChallenge } from './challenge.ts';
import { handleChurch, handleJoinChurch } from './church.ts';
// M2.172：管理员指令（封禁 / 解禁 / 三组开关 / 三种状态）与它的卡片菜单
import {
  handleBan, handleUnban,
  handleGameOff, handleGameOn, handleSceneGameOff, handleSceneGameOn,
  handlePushOff, handlePushOn, handleScenePushOff, handleScenePushOn,
  handleEventPushOff, handleEventPushOn, handleSceneEventPushOff, handleSceneEventPushOn,
  handleGameStatus, handleWorldStatus, handleBotStatus,
} from './admin.ts';
import { handleAdminMenu } from './admin-menu-cmd.ts';

/** 指令注册表：W1 三条 + W2 两条 + W3 八条 + W4 五条 + W6 一条 + M2.2 .世界 + M2.3 .今日 */
export function registerW1Commands(router: CommandRouter): CommandRouter {
  router.register('创建', handleCreate);
  // M2.85：普通人阶段的主入口 —— 手上的线索、主材料、去哪里找
  router.register('线索', handleClue);
  // M2.85 内容填充 P1：图鉴（神明 / 塔罗的统一读取点）
  router.register('图鉴', handleCodex);
  router.register('状态', handleStatus);
  // M2.47：把角色数据画成一张图（通道能发图就发图，不能就给落盘路径 + 文字卡）
  router.register('角色', handleCard);
  // M2.38 任务 1（P0）：途径专属行动的**执行入口**（在此之前那张表只有文案）
  router.register('行动', handleAction);
  router.register('帮助', handleHelp);
  // M2.86：图片版指令表（`.菜单 [编号]`，分多张，图带缓存）
  router.register('菜单', handleMenu);
  /*
   * M2.45：真机 markdown / HTML 能力探测。
   * **默认不注册** —— 它是开发工具，不该出现在玩家能用的指令表里；
   * `.env` 里 `MD_PROBE=1` 才开（且只在私聊响应）。
   */
  if (mdProbeEnabled()) {
    router.register('mdprobe', handleMdProbe);
    // 中文别名：用户记的是「探针」而不是 mdprobe
    router.register('探针', handleMdProbe);
  }
  /*
   * ⚠️ M2.121：**`.扮演` 已下线**（用户：「扮演本来就是日常行为，所以扮演指令没什么用」）。
   *
   * 它做的事改由**日常遭遇**承担（M2.120）：`.今日` 之外任何**做正事**的时候，
   * 每天随机弹几次「只有这条途径的人撞得到」的事件卡，玩家选一个 ⇒ 涨消化度。
   *
   * `handlePlay` 与 `play.ts` **保留**（消化度的判定、标签用量、`playDigDiminish` 都还在里面），
   * 只是不再挂到命令上 —— 删掉代码会把那几条路一起带走。
   */
  router.register('事件', handleEvent);
  router.register('探索', handleExplore);
  // M2.85 RPG 化：把玩家放进空间里（.看 这里有什么 / .走 走过去）
  router.register('看', handleLook);
  // M2.85 RPG 化：追查针对自己的阴谋（.查 / .查 <编号>）
  router.register('查', handleInvestigate);
  // M2.85 RPG 化 B：装备（.装备栏 / .装备 / .卸下）
  router.register('装备栏', handleEquipment);
  router.register('装备', handleEquipment);
  router.register('卸下', handleEquipment);
  // M2.85 B：用便士换一件非凡物品
  router.register('买', handleEquipment);
  // M2.87 交易体系：.商店 看货架（每件一个按钮）· .卖 出手背包里的东西
  router.register('商店', handleShop);
  router.register('卖', handleSell);
  // M2.85 RPG 化 D：委托（.委托 / .接 / .交）
  router.register('委托', handleQuest);
  router.register('接', handleQuest);
  router.register('交', handleQuest);
  router.register('走', handleWalk);
  router.register('背包', handleBag);
  router.register('使用', handleUse);
  router.register('魔药', handleBrew);
  router.register('服用', handleDrink);
  router.register('交易', handleTrade);
  router.register('确认', handleConfirm);
  router.register('取消', handleCancel);
  // W4
  router.register('晋升', handlePromote);
  router.register('休息', handleRest);
  router.register('就医', handleDoctor);
  // M2.120：日常遭遇的结算（菜单选项的 command，不是给玩家手打的）
  router.register('遇见', handleDailyEncounter);
  router.register('净化', handlePurify);
  router.register('占卜', handleDivination);
  router.register('队伍', handleParty);
  // W6
  router.register('反馈', handleFeedback);
  // M2.2
  router.register('世界', handleWorld);
  // M2.169：.神战 —— 看见阴谋、并插手它（插手是会被发现的）
  router.register('神战', handleDivineWar);
  // M2.170：.王座 —— 空出来的位置怎么争（残酷的那一段）
  router.register('王座', handleThrone);
  // M2.3：当日摘要 + 菜单入口（也是菜单过期后的重新开始入口）
  router.register('今日', handleToday);
  // M2.5：晋升仪式与干扰
  router.register('仪式', handleRitual);
  router.register('干扰', handleInterfere);
  // M2.6：通缉系统的两条指令 —— 犯罪（.袭击）与情报变现（.举报）
  router.register('袭击', handleAssault);
  router.register('举报', handleReport);
  // M2.7：跨城市移动（看目的地 / 出发 / 处理路途事件，三种形态一条指令）
  router.register('移动', handleMove);
  // M2.8：遭遇的处置（观察 / 对峙 / 撤退 / 互动）—— 遭遇本身由探索挂着掷出来
  router.register('遭遇', handleEncounter);
  // M2.9：PVE 回合制战斗（看这一场 / 开始 / 攻击 / 防御 / 技能 / 物品 / 撤退）
  router.register('战斗', handleBattle);
  // M2.10：PVP 挑战（正式对战，与 .袭击 的单次判定并存）
  router.register('挑战', handleChallenge);
  // M2.16：教会 —— 入教（顶级）/ 身份页（顶级）/ 捐献（子指令）
  router.register('加入教会', handleJoinChurch);
  router.register('教会', handleChurch);
  /*
   * ═══ M2.172：管理员指令 ═══
   *
   * 全部带 `{ admin: true }` —— 这一个标记同时管两件事：
   *   · 路由层在「游戏关闭」时**放行**它们（否则关掉就再也开不回来）；
   *   · 非管理员调用时统一回一句私聊提示（见 commands/admin.ts 的 requireAdmin）。
   *
   * 名单不在这里手抄：`router.adminCommands` 从注册处派生，测试拿它对账
   * `domain/menu/admin-commands.ts` 的说明表。
   */
  router.register('封禁', handleBan, { admin: true });
  router.register('解禁', handleUnban, { admin: true });
  router.register('关闭游戏', handleGameOff, { admin: true });
  router.register('开启游戏', handleGameOn, { admin: true });
  router.register('关闭本群游戏', handleSceneGameOff, { admin: true });
  router.register('开启本群游戏', handleSceneGameOn, { admin: true });
  router.register('关闭主动推送', handlePushOff, { admin: true });
  router.register('开启主动推送', handlePushOn, { admin: true });
  router.register('关闭本群主动推送', handleScenePushOff, { admin: true });
  router.register('开启本群主动推送', handleScenePushOn, { admin: true });
  router.register('关闭主动事件推送', handleEventPushOff, { admin: true });
  router.register('开启主动事件推送', handleEventPushOn, { admin: true });
  router.register('关闭本群主动事件推送', handleSceneEventPushOff, { admin: true });
  router.register('开启本群主动事件推送', handleSceneEventPushOn, { admin: true });
  router.register('游戏状态', handleGameStatus, { admin: true });
  router.register('世界状态', handleWorldStatus, { admin: true });
  router.register('机器人状态', handleBotStatus, { admin: true });
  router.register('管理', handleAdminMenu, { admin: true });
  return router;
}
