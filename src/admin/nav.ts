/**
 * 管理后台的**面板注册表**（M2.52）—— 后台结构的唯一出处。
 *
 * ## 为什么要有一份注册表
 *
 * 原来加一个面板要改三个地方：aside 里的链接、main 里的 <section>、内联脚本里的
 * 显隐开关。三处漏一处就是「点了没反应」或者「切不回去」，而且没有任何东西会报错。
 * 现在只有这里一处，前端按它把导航和面板都画出来。
 *
 * ## state: 'planned' 是干什么的
 *
 * 用来显式登记**还没做**的功能。「没做」和「坏了」在界面上长得一样（都是点不动），
 * 但处理方式完全不同 —— 所以未实现的项要有位置、能点开、说得清卡在哪。
 *
 * **目前这一份里没有 planned 项**（M2.53 把最后五个都做完了）。这一套机制留着，
 * 是给下一个功能用的，规则不变：
 *
 *   · blockedBy 必须写**具体**原因，不能只写「开发中」。写不出具体原因的，
 *     要么是还没想清楚，要么是其实可以做 —— 两种情况都不该挂在「开发中」下面。
 *   · plan 要写做出来是什么样。
 *   · 每一条都会被 test/admin.test.ts 检查。
 *
 * ## 一条教训
 *
 * M2.52 给「模拟与压测」写的 blockedBy 是「跑一次几十秒到几分钟，且会写库」。
 * 前半句对 CLI 成立，后半句**只对 src/vplayer 与 src/loadtest 成立** ——
 * src/sim 的 runSimulation 是纯函数，自己装载内容、不碰数据库，200 人 × 30 天
 * 实测 1.3 秒。写 blockedBy 时如果没去核实，它就会变成一个假的阻塞理由，
 * 把一件本来十分钟能做掉的事挂上一个月。
 */

export type PanelState = 'ready' | 'planned';

export interface PanelSpec {
  /** 同时是 URL hash、tab 的 id 与路由名 */
  id: string;
  label: string;
  group: string;
  state: PanelState;
  /**
   * 子面板挂在哪个面板下（M2.81）。
   *
   * 导航里「适配器」现在是一个**分类**，底下是两个可进入的子页（OneBot / QQ 官方）。
   * 一条通道一个页面，比把两块堆在同一页强：每页只有自己那条通道的配置、状态与按钮，
   * 不会出现「这一堆框到底属于谁」的问题。
   */
  parent?: string;
  /** 一句话：这个面板是干什么的 */
  summary: string;
  /** planned 才有：为什么现在还没有 */
  blockedBy?: string[];
  /** planned 才有：做出来是什么样 */
  plan?: string[];
}

export const PANELS: PanelSpec[] = [
  {
    id: 'overview', label: '总览', group: '运行', state: 'ready',
    summary: '一屏看清：进程 / 世界时钟 / 玩家规模 / 告警 / 备份 / 最近错误',
  },
  {
    id: 'adapter', label: '适配器', group: '运行', state: 'ready',
    summary: '通道总览：现在启用了哪条、另一条怎么开；点下面的子项进入对应适配器',
  },
  {
    id: 'adapter-onebot', label: 'OneBot', group: '运行', state: 'ready', parent: 'adapter',
    summary: 'OneBot 通道：连接状态、重连协议端、体检（协议端由你自己运行）',
  },
  {
    id: 'adapter-qq', label: 'QQ 官方机器人', group: '运行', state: 'ready', parent: 'adapter',
    summary: 'QQ 官方通道：凭据、指令白名单、登录体检、重连网关（改了不用重启进程）',
  },
  {
    /*
     * M2.82：服务与访问。
     *
     * 放在「运行」组而不是新开一组：它和适配器面板问的是同一类问题 ——
     * 「这个进程现在挂在什么状态上、改完怎么生效」。
     */
    id: 'access', label: '服务与访问', group: '运行', state: 'ready',
    summary: '后台口令、监听地址（本机 / 局域网 / 公网）、端口、公网地址、反代信任，以及登录限流状态',
  },
  {
    id: 'logs', label: '日志', group: '运行', state: 'ready',
    summary: '进程内环形缓冲里的日志，按级别与关键词过滤',
  },
  {
    id: 'backup', label: '备份', group: '运行', state: 'ready',
    summary: '数据库快照：列表、立即备份、按天数清理',
  },
  {
    id: 'gm', label: 'GM 管理', group: '玩家', state: 'ready',
    summary: '玩家搜索、属性 / 状态 / 途径 / 传送 / 物品，每次写入都留档',
  },
  {
    id: 'audit', label: '审计检索', group: '玩家', state: 'ready',
    summary: '按玩家 / 指令 / 内容 / 时间段检索 audit_logs（热表与归档表一起查）',
  },
  {
    id: 'data', label: '数据编辑', group: '内容', state: 'ready',
    summary: '改 src/data/*.yaml（控件按字段类型出，不在界面上手写 yaml）',
  },
  {
    id: 'world', label: '世界状态', group: '内容', state: 'ready',
    summary: '时段 / 月相 / 雾日、各地天气与扩散、世界 tick 水位线、最近的世界事件（只读）',
  },
  {
    id: 'content', label: '内容校验', group: '内容', state: 'ready',
    summary: '内容层与卡片层的检查结论，按严重度与来源列出来',
  },
  {
    id: 'ops', label: '运营指标', group: '运营', state: 'ready',
    summary: '留存 / 新手完成率 / 玩法指标 / 投诉率，以及当前告警与今日日报',
  },
  {
    id: 'feedback', label: '玩家反馈', group: '运营', state: 'ready',
    summary: '.反馈 收到的东西：分类、标记已处理',
  },
  {
    id: 'sim', label: '模拟与压测', group: '运营', state: 'ready',
    summary: '跑纯函数模拟器（不碰数据库），拿数值对照 W5 目标区间',
  },
];

export const panelById = (id: string): PanelSpec | undefined => PANELS.find((p) => p.id === id);

/** 按分组排好序给前端画导航用 */
export function groupedPanels(): Array<{ group: string; items: PanelSpec[] }> {
  const order: string[] = [];
  const byGroup = new Map<string, PanelSpec[]>();
  for (const panel of PANELS) {
    if (!byGroup.has(panel.group)) { byGroup.set(panel.group, []); order.push(panel.group); }
    byGroup.get(panel.group)!.push(panel);
  }
  return order.map((group) => ({ group, items: byGroup.get(group)! }));
}
