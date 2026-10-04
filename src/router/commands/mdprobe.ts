/**
 * `.mdprobe` —— **真机 markdown / HTML 能力探测**（M2.45）。
 *
 * 用户原话：
 *
 * > 我发现一件事，腾讯的 markdown 消息好像是支持一部分 html 标签的，例如文字颜色什么的，
 * > 你可以制作一个独立的测试模板，进行多项测试。
 *
 * ## 为什么值得单独做一个指令
 *
 * 前面十几轮里，「空行怎么算」「缩进怎么凑」「图片外链行不行」「表格会不会吞行」
 * 全是我在**猜**平台行为 —— 而猜错的代价每次都要用户拿真机截图来纠正。
 * 把猜测换成一屏可读的探测：**一条消息只测一类语法**，用户看一眼截图就知道哪些能用。
 * 之后所有版式决策都有实测撑腰，不用再来回试。
 *
 * ## 为什么一条消息只测一组
 *
 * 不支持的语法会让**整条消息**被平台拒收（症状是「机器人不回话」）。
 * 挤在一条里测，失败时根本分不清是哪个标签干的 —— 所以按组分，一次一组。
 *
 * ## 开关
 *
 * 它是**开发工具**，不该出现在玩家能用的指令表里 ⇒ `MD_PROBE=1` 才注册（且只在私聊响应）。
 */
import type { CommandContext, CommandResult } from '../index.ts';

/** 探测用的公开图片（都是能长期访问的地址） */
const IMG_JSDELIVR = 'https://cdn.jsdelivr.net/gh/github/explore@main/topics/nodejs/nodejs.png';
const IMG_RAW = 'https://raw.githubusercontent.com/github/explore/main/topics/nodejs/nodejs.png';
const IMG_QLOGO = 'https://q.qlogo.cn/g?b=qq&nk=10000&s=100';
const IMG_UGUU = 'https://n.uguu.se/zCSgLqLn.png';

export interface Probe {
  id: string;
  /** 这一组在测什么（回执里打出来，方便对照截图） */
  what: string;
  build: () => string;
}

/**
 * 探测组。
 *
 * ⚠️ 每条都刻意写得很「挤」：能一行测完就不写两行 —— 因为要看的不是好看，
 * 而是**哪些语法真的生效**。看到字面量 = 不支持；看不到 = 整条被拒。
 */
export const PROBES: readonly Probe[] = [
  {
    id: 'html',
    what: 'HTML 内联标签：颜色 / 加粗 / 字号 / 高亮',
    build: () =>
      [
        '① <b>粗b</b> ② <i>斜i</i> ③ <u>下划线u</u> ④ <s>删除s</s> ⑤ <code>代码code</code>',
        '⑥ <font color="#e54d42">font十六进制</font> ⑦ <font color="red">font色名</font>',
        '⑧ <span style="color:#3eb370">span绿色</span> ⑨ <span style="background:#ffe58f">span底色</span>',
        '⑩ <big>big大</big> ⑪ <small>small小</small> ⑫ <mark>mark高亮</mark>',
        '⑬ <strong>strong</strong> ⑭ <em>em</em>',
      ].join('\n'),
  },
  /*
   * M2.86：**颜色写法穷举**。
   *
   * 用户实机看到同为官方 Bot 的机器人**文字有颜色**（可复制、非图片、非表情），
   * 而我们试的 `<font color="#e54d42">` 在手机端**显示成原始标签**。
   *
   * 所以问题不在「官方支不支持」这个二元判断上，而在**具体写法**上 ——
   * 这一组把能想到的写法一次列全，**哪一行是彩色就用哪一行**。
   */
  {
    id: 'latex',
    what: '**LaTeX 颜色**（实测：必须包在 $…$ 里才渲染）',
    build: () =>
      [
        // 结论行：这一组就是全站高亮在用的形态
        '① $\\textcolor{#e05a4f}{红}$　$\\textcolor{#3eb370}{绿}$　$\\textcolor{#4A9EFF}{蓝}$',
        '② $\\small{小号字}$　③ $\\small{\\textcolor{#FFA500}{小号橙}}$',
        '④ 嵌在句子里：他穿了一件$\\textcolor{#9b7fd4}{紫袍}$，站在雾里。',
        // 对照行：缺定界符 = 裸（用来确认「定界符必需」这件事没变）
        '⑤ 对照（缺 $）：\\textcolor{#e05a4f}{红}　\\small{小号字}',
        '⑥ 色名：$\\textcolor{red}{色名红}$　⑦ $\\color{#e05a4f}{前色后文}$',
        '⑧ 底色：$\\colorbox{#ffe58f}{底色}$　⑨ $\\textbf{粗体}$　⑩ $\\textit{斜体}$',
      ].join('\n'),
  },
  {
    id: 'color2',
    what: '颜色写法穷举：双引号 / 单引号 / 无引号 / span / color 标签 / BBCode',
    build: () =>
      [
        '① <font color="#e54d42">双引号十六进制</font>',
        "② <font color='#3eb370'>单引号十六进制</font>",
        '③ <font color=red>无引号色名</font>',
        '④ <span style="color:#e54d42">span 双引号</span>',
        "⑤ <span style='color:#3eb370'>span 单引号</span>",
        '⑥ <color=red>color 标签</color>',
        '⑦ [color=red]BBCode 方括号[/color]',
        '⑧ <font style="color:#e54d42">font + style</font>',
        '⑨ <b style="color:red">b + style</b>',
        '⑩ <em style="color:red">em + style</em>',
        '⑪ <span style="background:#ffe58f">span 底色</span>',
        '⑫ <mark>mark 高亮</mark>',
      ].join('\n'),
  },
  {
    id: 'block',
    what: 'HTML 块级：<br> / <hr> / <div> / <p>',
    build: () =>
      [
        '上面一行<br>这一行是 <b>&lt;br&gt;</b> 之后的（如果它换行了，说明 br 支持）',
        '<hr>',
        '<div>div 里的字</div>',
        '<p>p 里的字</p>',
        '上面这三行如果是**分开的块**，说明块级标签支持',
      ].join('\n'),
  },
  {
    id: 'table',
    what: '表格：markdown 表格里的单元格换行 vs HTML 表格',
    build: () =>
      [
        'A. markdown 表格 + 单元格内 &lt;br&gt;：',
        '| 头像 | 文字 |',
        '| :-- | :-- |',
        '| [图] | 第一行<br>第二行 |',
        '',
        'B. HTML 表格：',
        '<table><tr><td>格1</td><td>格2</td></tr><tr><td>格3</td><td>格4</td></tr></table>',
        '',
        'C. markdown 表格 + 单元格内零宽空格：',
        '| 头像 | 文字 |',
        '| :-- | :-- |',
        '| [图] | 第一行\u200B第二行 |',
      ].join('\n'),
  },
  {
    id: 'img',
    what: '外链图片：四个域名 + 尺寸语法',
    build: () =>
      [
        '1 jsDelivr：![a #40px #40px](' + IMG_JSDELIVR + ')',
        '2 raw.githubusercontent：![b #40px #40px](' + IMG_RAW + ')',
        '3 qlogo（腾讯自家，应当一定显示）：![c #40px #40px](' + IMG_QLOGO + ')',
        '4 uguu（之前裂过的那个）：![d #40px #40px](' + IMG_UGUU + ')',
        '',
        '下面这张只给宽度、不给高度，看会不会按原比例：',
        '![e #120px](' + IMG_JSDELIVR + ')',
      ].join('\n'),
  },
  {
    /*
     * M2.86：**尺寸标注到底听不听**（这一组决定卡面被裁怎么修）。
     *
     * 真机现象：角色卡按 markdown 图片语法（标注 300×484）内嵌后，
     * 底部被裁掉一截 —— 卡面实际是 1240×2000（高/宽 = 1.61），而屏幕上只显示出约 1.36。
     * 两种可能，**修法完全不同**：
     *   · ① 标注生效、只是高度超了容器上限 ⇒ 把标注调矮即可；
     *   · ② 标注被忽略（平台按容器宽铺满原图）⇒ 只能改**卡面本身的比例**。
     * 用一张**正方形**原图当尺子最清楚：正方形标成 60×60 还显示成大方块 = 标注被忽略。
     */
    id: 'size',
    what: '图片尺寸标注：平台听不听尺寸标注（这一组决定卡面会不会被裁）',
    build: () =>
      [
        '同一张**正方形**头像原图，四种标注：',
        '',
        'A 不标尺寸：![A](' + IMG_QLOGO + ')',
        'B 标 60×60：![B #60px #60px](' + IMG_QLOGO + ')',
        'C 只标宽 60：![C #60px](' + IMG_QLOGO + ')',
        'D 标 60×180（正方形硬拉成竖条）：![D #60px #180px](' + IMG_QLOGO + ')',
        '',
        '**判读**：',
        '· B/C 是小方图、D 是竖长条 ⇒ **标注生效**；卡面被裁是**高度超上限**，把标注调矮即可',
        '· 四张都撑满气泡、大小一样 ⇒ **标注被忽略**，只能改**卡面本身的比例**',
        '· D 与 B 一样高 ⇒ 平台只认宽、高按原图比例算',
        '· A 与 B/C 明显不同 ⇒ 不标尺寸时按原图铺开',
      ].join('\n'),
  },
  {
    /*
     * M2.86 第二轮：**高度上限到底在哪**（`size` 组的后续）。
     *
     * `size` 组已经测出「**标注生效**」（标 60×60 就是小方图、60×180 就是竖长条），
     * 所以卡面被裁只剩一种解释：**高度超了容器的上限**。那只差一个数 —— 上限是多少。
     *
     * 这一组把宽度锁死 100，只抬高度：从哪一张开始**底部被切**，上限就在它和上一张之间。
     * 平台会按标注**强制拉伸**（`size` 组的 D 已证），所以用正方形头像当尺子也能量高度。
     *
     * ⚠️ 必须**两端都看**（手机 + 电脑）：卡面现在的表现就是「手机完整、电脑被裁」，
     * 这一组的读数会把两端的上限分别标出来 —— 只有一端够用没有意义。
     */
    id: 'size2',
    what: '图片**高度上限**：多高开始被裁（决定卡面标注调多矮）',
    build: () =>
      [
        '同一张正方形头像，宽度都锁 100，只改高度：',
        '',
        'E 100×300：![E #100px #300px](' + IMG_QLOGO + ')',
        'F 100×450：![F #100px #450px](' + IMG_QLOGO + ')',
        'G 100×600：![G #100px #600px](' + IMG_QLOGO + ')',
        'H 100×800：![H #100px #800px](' + IMG_QLOGO + ')',
        'I 300×484（**与卡面同一标注**，原图仍这张小图）：![I #300px #484px](' + IMG_QLOGO + ')',
        '',
        '**判读**：',
        '· 从哪一档开始**底部被切**，高度上限就在它和上一张之间；',
        '· **I 是冲着卡面来的**：它与卡面标注**完全一样**（300×484），只换了图源。',
        '  I 被切 ⇒ 问题在**尺寸**本身；I 完整 ⇒ 问题在**卡面那张图**（1240×2000 的大图），',
        '  与标注无关 —— 这两条路要改的地方完全不同，所以必须分开。',
        '· E–H 全完整 ⇒ 高度不是瓶颈，直接看 I。',
        '',
        '⚠️ **两端分别记读数**：卡面就是「手机完整、电脑被裁」。',
      ].join('\n'),
  },
  {
    id: 'layout',
    what: '图文并排的几种写法（这一组决定消息头能不能两行）',
    build: () =>
      [
        'A. 图 + 同行文字，第二行顶格：',
        '![a #40px #40px](' + IMG_QLOGO + ') **昵称**　男',
        '◉ 地点',
        '',
        'B. 用 &lt;br&gt; 在图片右边折行：',
        '![b #40px #40px](' + IMG_QLOGO + ') **昵称**　男<br>◉ 地点',
        '',
        'C. HTML 图片 + 文字同行：',
        '<img src="' + IMG_QLOGO + '" width="40" height="40"> **昵称**　男 ◉ 地点',
        '',
        'D. 引用块做第二行：',
        '![d #40px #40px](' + IMG_QLOGO + ') **昵称**　男',
        '> ◉ 地点 · 愚者序列8',
      ].join('\n'),
  },
  {
    id: 'misc',
    what: '杂项：任务列表 / 嵌套引用 / 分隔线 / 空行写法',
    build: () =>
      [
        '- [x] 已完成的任务列表',
        '- [ ] 未完成的任务列表',
        '',
        '> 一级引用',
        '>> 二级引用',
        '',
        '***',
        '',
        '上面是三条横线；下面是一个**只含零宽空格的行**造成的空行：',
        '\u200B',
        '这一行与上一行之间应当空了一行',
      ].join('\n'),
  },
];

/** 按 id 取一组探测（纯函数，测试直接用它） */
export function probeById(id: string): Probe | undefined {
  return PROBES.find((entry) => entry.id === id);
}

/**
 * 指令是否启用 —— **默认开**，写 `MD_PROBE=0` 才关。
 *
 * ⚠️ 这个方向是踩过坑才定下来的：第一版写成「配了 `1` 才开」，
 * 结果我第一次给用户 .env 里写的是 `MD_PROBE=0`，用户发指令**没有任何反应** ——
 * 而「配了才生效」的失败症状恰恰是「机器人不回话」，最难查（不确定是没配、没重启、
 * 还是指令名写错了）。反过来「默认开、写 0 才关」就不会有这个问题。
 *
 * 对玩家无害：它**只在私聊响应**，也不进 `.帮助` 的指令清单。
 */
export function mdProbeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env['MD_PROBE']?.trim() !== '0';
}

export async function handleMdProbe(ctx: CommandContext): Promise<CommandResult> {
  /*
   * **在哪发就在哪回**（M2.45 的既有口径）。
   *
   * 第一版限制「只在私聊响应」，两个后果都踩了：
   *   · 用户平时就在群里用机器人，于是发了**毫无反应**（而他正是要拿真机测）；
   *   · 群里那条分支返回空字符串，router 照样发出一条**空消息** —— 看着像"机器人抽了"。
   * 探测是玩家自己发的指令，刷一次屏没关系；重要的是结果能在他真正用的场景里看到。
   */
  const key = (ctx.args[0] ?? '').trim().toLowerCase();
  if (key === '' || key === 'list') {
    return {
      privateText: [
        '**mdprobe** — 真机 markdown / HTML 能力探测（一条消息只测一类，避免互相干扰）',
        '',
        ...PROBES.map((probe) => `· \`.mdprobe ${probe.id}\`　${probe.what}`),
        '',
        '用法：发 `.mdprobe <组名>`，然后看截图里哪些**生效**、哪些显示成了字面量、哪一组**机器人干脆没回话**（=整条被平台拒收）。',
      ].join('\n'),
      detailToPrivate: true,
    };
  }
  const probe = probeById(key);
  if (probe === undefined) {
    return {
      privateText: `没有这一组：${key}。可用：${PROBES.map((p) => p.id).join(' / ')}`,
      detailToPrivate: true,
    };
  }
  return {
    privateText: `**mdprobe · ${probe.id}**　${probe.what}\n\n${probe.build()}`,
    detailToPrivate: true,
  };
}
