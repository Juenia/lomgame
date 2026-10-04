import type { CommandContext, CommandResult } from '../index.ts';
import { tradeTimeoutLabel } from '../../domain/trade/trade.ts';
import { renderBetaText, renderFaqText, renderRulesText } from '../../data/community.ts';
import { HELP_H, HELP_W, renderHelpImage } from '../../card/help-image.ts';

/*
 * ⚠️ M2.86：**这里不再复述整份指令清单**（用户报「帮助显示内容过长已截断」）。
 *
 * 原来这段有 55 行 / 1412 字符，而且**与 `.菜单` 图片重复** ——
 * 菜单图已经把 45 条指令连同用法画得比文字清楚。
 * 更关键的是：这条消息还要带上**信息头图**和**下一步菜单**，
 * 三方共享同一份长度额度，谁都不该独占。
 *
 * 现在只留「怎么上手」这一屏 —— 想查全部指令就 `.菜单`。
 */
export const HELP_TEXT = [
  '《诡秘之主：群星低语》',
  '',
  '第一次玩：发 .创建 姓名 建个角色，然后 .看 看清自己在哪、能往哪走。',
  '走一步：.走 地名 → 到了以后点「探索这里」（也可以直接 .探索 地名）。',
  '想查全部指令：发 .菜单。',
  '不知道干嘛：.今日 看此刻还能做什么；.状态 看自己什么情况。',
  '',
  '【最常用的几条】',
  '.创建 姓名　.看　.走 地名　.探索 地名　.状态　.背包　.休息　.菜单',
  '',
  '.帮助 faq / .帮助 规则 / .帮助 公告',
].join('\n');

/* ---------------- 旧版全文（M2.86 前的 55 行清单，保留备查） ----------------
export const LEGACY_HELP_TEXT_RETIRED = [

  '《诡秘之主：群星低语》内测指令',
  '【角色】',
  '.创建 姓名 —— 创建角色（会问你一句性别，回 1 或 2）。创建出来的是普通人，',
  '　　还没有途径，也没有序列 —— 路要自己碰出来，或者等人来找你',
  '.线索 —— 手上有哪几张配方线索、主材料去哪里找（普通人阶段的主入口）',
  // M2.85 内容填充 P1：设定层的统一入口（神明 / 塔罗；后续批次继续往里加）
  '.图鉴 [神明/塔罗] [名字] —— 查神明与塔罗牌（不带参数看分类）',
  '.状态 —— 查看角色卡（文字表）',
  // M2.47：卡面是游戏数据的投影 —— 数值全部来自角色状态，没有装饰数字
  '.角色 —— 把角色画成一张卡（图片）。通道发不出图时会回文字卡 + 图片落盘路径',
  '【日常】',
  '.扮演 行为 —— 按途径的方式行事，消化魔药（10 秒冷却；还没有途径时做不了）',
  '.事件 [地点] —— 主动探索一次（同一地点每日 3 次）',
  '.探索 地点 —— 去具体地点找材料（同一地点每日 3 次；5% 翻到配方线索）',
  '.背包 [页码] —— 查看背包（区分绑定与非绑定）',
  '.使用 物品 [数量] —— 使用消耗品',
  // M2.13：封印物与符咒也走 .使用（前者不消耗、每次付代价；后者一次性）
  '.使用 封印物 / 符咒 —— 带上它做一件平时做不到的事（灰雾之眼 / 时间沙漏 / 传送符…）',
  '.战斗 物品 <封印物> —— 在战斗里用它（封印之刃：无视一次序列差；血月之刃：伤害翻倍）',
  '【晋升与恢复】',
  '.晋升 —— 消耗消化度门槛与材料，序列 9 → 8（连续失败有保护）',
  // M2.85：行动值机制整体移除 —— 这两条不再提「消耗 1 行动点」
  '.休息 —— MAD-5、HP+20，每日 1 次',
  '.净化 —— COR-15、MAD-8，消耗圣盐 ×1，每日 1 次',
  '.占卜 问题 —— 消耗灵性，看一段卜象（愚者序列 8 后更划算）',
  '.队伍 创建 / .队伍 加入 @队长 / .队伍 任务 / .队伍 离开 —— 组队（上限 4 人）',
  '【世界】',
  '.世界 —— 当前时段、月相、雾日与各地点的天气',
  '.世界 地点（或回数字）—— 该地点的详细天气、影响与预告',
  '【魔药】',
  '.魔药 [配方] —— 调制魔药（消耗灵性与材料，失败会涨污染）',
  '.服用 [魔药] —— 服下魔药，消化度上涨，疯狂上升',
  '【交易】',
  '.交易 @玩家 物品 [数量] 价格 —— 发起交易，物品立即冻结（价格默认便士，也认 8s / 1g / 1g5s3p）',
  `.确认 单号 / .取消 单号 —— 处理交易（${tradeTimeoutLabel()}未确认自动取消，买卖双方都能取消）`,
  '【通缉】',
  '.袭击 @玩家 —— 把对方打成重伤。动手的地方归谁管，就会被谁通缉',
  '.举报 @玩家 —— 对方在势力范围内且正被通缉时领赏金；举报错了信誉 -5',
  '被通缉后：势力范围内会被盘查 / 罚款；躲到无主地点（灰雾之上、墓园小径、',
  '封存档案室、迷雾街区）就安全了。通缉 3—7 天后自动解除。',
  '【封测】',
  '.帮助 faq —— 常见问题（10 条）',
  '.帮助 规则 —— 群规则',
  '.帮助 公告 —— 封测范围、时间与已知问题',
  '.反馈 内容 —— 提交 bug 或建议',
  '',
  '扮演提示：描述里带上「契合」词（如占卜、守护、守夜）才能消化得更快；',
  '同一句话反复刷收益会递减，换着花样来更划算。',
].join('\n');
*/

export async function handleHelp(ctx: CommandContext): Promise<CommandResult> {
  const topic = (ctx.args[0] ?? '').trim().toLowerCase();
  const { community } = ctx.deps;

  if (topic === 'faq' || topic === '常见问题') {
    return {
      privateText: ['《群星低语》封测 FAQ', '', renderFaqText(community.faq)].join('\n'),
      groupText: 'FAQ 已私聊发送。',
      detailToPrivate: true,
    };
  }
  if (topic === '规则' || topic === 'rules') {
    return {
      privateText: ['群规则', '', renderRulesText(community.rules)].join('\n'),
      groupText: '群规则已私聊发送。',
      detailToPrivate: true,
    };
  }
  if (topic === '公告' || topic === 'beta') {
    return {
      privateText: renderBetaText(community.beta),
      groupText: '封测公告已私聊发送。',
      detailToPrivate: true,
    };
  }

  /*
   * M2.87：**主入口出图**（用户：「帮助菜单要补充图片」）。
   *
   * 与 `.菜单` 同一套做法：出图 → 上传换 URL → 一条带图的 markdown → `selfSent`。
   * 理由是这条消息还要带信息头图与下一步菜单，**三方共享长度额度**，
   * 而图不占正文额度（它只是一行 `![](...)`）。
   *
   * ⚠️ 与 `.菜单` 一样，**出图失败一律退回文字版** —— 而这里的文字版是
   * `HELP_TEXT`。两者讲的不是同一件事（一个是「怎么开始」、一个是「怎么玩」），
   * 所以不存在漂移问题；但都要能独立读懂，这是底线。
   */
  const adapter = ctx.deps.adapter;
  const scene = ctx.msg.scene;
  // 与 `.菜单` / `.角色` 同一口径：私聊回本人，群聊回群
  const targetId = scene === 'private' ? ctx.msg.userId : ctx.msg.sceneId;

  if (adapter?.supportsInlineImages === true && adapter.sendInteractive && adapter.prepareInlineImage) {
    try {
      const image = renderHelpImage();
      const url = await adapter.prepareInlineImage(scene, targetId, {
        bytes: image.png,
        mediaType: 'image/png',
        alt: '怎么玩《群星低语》',
      });
      if (url !== undefined) {
        /*
         * 按钮走 `nextActions`（文本指令按钮）而不是原生 `options`：
         * 原生按钮需要**待答状态**，而 `.帮助` 的这三个子项都是纯查询 ——
         * 为它们开一份待答菜单是多余的（`nextActions` 点下去就是一条普通指令）。
         */
        /*
         * `options: []` —— 这张图**没有菜单语义**，它是「一条带图的说明」而已。
         * 后续动作走 `nextActions`（文本指令按钮）。
         */
        const sent = await adapter.sendInteractive(scene, targetId, {
          text: '![怎么玩《群星低语》 #' + HELP_W + 'px #' + HELP_H + 'px](' + url + ')',
          options: [],
          noHeader: true,
        });
        if (sent) {
          return {
            privateText: '',
            groupText: '入门说明已私聊发送。',
            selfSent: true,
            detailToPrivate: true,
            nextActions: [
              { label: '全部指令', command: '菜单', preview: '图片版，一张张翻' },
              { label: '常见问题', command: '帮助 faq' },
              { label: '群规则', command: '帮助 规则' },
            ],
          };
        }
      }
    } catch (error) {
      // 出图是体验增强，坏了绝不能把 `.帮助` 这条主链路拖下水
      ctx.deps.logger?.warn?.('[help] 出图失败，退回文字：' + (error as Error).message);
    }
  }

  return {
    privateText: HELP_TEXT,
    groupText: '指令说明已私聊发送。',
    detailToPrivate: true,
    nextActions: [
      { label: '全部指令', command: '菜单', preview: '图片版，一张张翻' },
      { label: '常见问题', command: '帮助 faq' },
      { label: '今日', command: '今日', preview: '从今天开始' },
    ],
  };
}
