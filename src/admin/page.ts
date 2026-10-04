/**
 * 管理后台页面（M2.49）：自包含 HTML，登录 + 适配器 + 数据编辑（三栏）。
 *
 * ## 为什么是内联 HTML 而不是前端工程
 *
 * 运行时依赖只有 yaml + zod，没有构建步骤。引一个框架意味着多一条构建链、
 * 多一份 node_modules、多一个发布时要同步的产物 —— 为了一个内部后台不值得。
 *
 * ## 为什么不给人看 yaml 原文
 *
 * 用户原话：「不要把原始数据丢上来让人编辑，容易出 BUG」。
 * 控件按字段类型出：数字用数字框、布尔用下拉、枚举用中文下拉、键值对用行编辑器。
 * 英文枚举一律显示中文，只有写回文件时才用英文。
 *
 * ## 前端脚本的写法约束
 *
 * 它是**字符串数组**拼出来的。拼错一个引号 TS 照样编译过，只有浏览器打开时才白屏，
 * 所以 test/admin.test.ts 会把这段抽出来 new Function 一遍。
 */

const CSS = [
  '*{margin:0;padding:0;box-sizing:border-box}',
  'body{background:#0f1310;color:#e2ddd0;font:14px/1.6 "Noto Sans SC","Microsoft YaHei",sans-serif;display:flex;min-height:100vh}',
  'aside{width:190px;flex:0 0 190px;background:#0a0e0b;border-right:1px solid rgba(201,169,97,.18);padding:22px 0}',
  'aside h1{font-size:15px;font-weight:400;letter-spacing:.3em;color:#c9a961;padding:0 20px 18px;border-bottom:1px solid rgba(201,169,97,.14);margin-bottom:12px}',
  'aside a{display:block;padding:10px 20px;color:#9d9a8c;text-decoration:none;border-left:2px solid transparent;cursor:pointer}',
  'aside a:hover{color:#e2ddd0;background:rgba(201,169,97,.05)}',
  'aside a.on{color:#e8d3a0;border-left-color:#c9a961;background:rgba(201,169,97,.08)}',
  'main{flex:1;padding:24px 28px;min-width:0}',
  'h2{font-size:18px;font-weight:400;color:#e8d3a0;margin-bottom:6px}',
  'p.sub{color:#7d7a6e;font-size:12.5px;margin-bottom:18px}',
  'fieldset{border:1px solid rgba(201,169,97,.16);padding:16px 18px;margin-bottom:18px}',
  'legend{color:#c9a961;font-size:12.5px;letter-spacing:.16em;padding:0 8px}',
  'label{display:block;margin-bottom:13px}',
  'label>span{display:block;color:#9d9a8c;font-size:12px;margin-bottom:5px;letter-spacing:.06em}',
  'input[type=text],input[type=password],input[type=number],select,textarea{width:100%;max-width:420px;background:#080b09;border:1px solid rgba(201,169,97,.24);color:#e2ddd0;padding:7px 9px;font:13px/1.5 Consolas,monospace}',
  /*
   * M2.83：`textarea` 原来**不在**上面那一条里 —— 而卡片正文、失控文本、群规则、
   * 封测公告、片段池这些全走多行框（multiline）。于是它们在深色页面里是一片白底，
   * 既刺眼又让人以为「这一栏是不是没做完」。
   */
  'textarea{display:block;resize:vertical;min-height:62px;line-height:1.75}',
  'input:focus,select:focus,textarea:focus{outline:none;border-color:#c9a961}',
  'input[readonly],select:disabled,textarea[readonly]{opacity:.5}',
  /*
   * 嵌套对象（卡片的 trigger / texts）：子字段各成一行，左边一道竖线表示从属关系 ——
   * 没有它的话，object 里的子字段和外层字段长得一模一样，分不清哪个属于哪一层。
   */
  '.obj{margin:4px 0;padding-left:12px;border-left:2px solid rgba(201,169,97,.18)}',
  '.obj>label{margin-bottom:9px}',
  // maplist（卡片的 effects）：一条一组键值，条与条之间分开，免得看成一整片
  '.mlrow{border:1px solid rgba(201,169,97,.14);padding:8px 9px 4px;margin-bottom:7px;background:rgba(255,255,255,.012)}',
  '.mlrow>.kvrow{margin-bottom:5px}',
  '.mlrow>button{margin:0 6px 6px 0}',
  '.ml>button[data-addml]{margin-top:2px}',
  /*
   * 触发条件（M2.83）：一排 = 种类下拉 + 值控件。
   * 下拉要**收窄**（它们不是主输入框），否则一行排不下、折得看不出是一组的。
   */
  '.clrow{display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap}',
  '.clrow>select:first-child{width:auto;min-width:104px;max-width:150px}',
  '.clval{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
  '.clval select{width:auto;min-width:96px;max-width:210px}',
  '.clval input[type=number]{width:86px;max-width:86px}',
  '.clrow>button{flex:0 0 auto;padding:4px 10px}',
  '.cl>.hint{margin:6px 0 0}',
  '.smrow{border:1px solid rgba(201,169,97,.14);padding:8px 9px 4px;margin-bottom:7px}',
  'button{background:rgba(201,169,97,.12);border:1px solid rgba(201,169,97,.45);color:#e8d3a0;padding:7px 16px;cursor:pointer;font:13px/1 inherit;letter-spacing:.08em}',
  'button:hover{background:rgba(201,169,97,.22)}',
  'button:disabled{opacity:.4;cursor:not-allowed}',
  'button.ghost{background:transparent;color:#9d9a8c;border-color:rgba(201,169,97,.2);padding:4px 11px}',
  'button.ghost.on{color:#e8d3a0;border-color:#c9a961;background:rgba(201,169,97,.12)}',
  '.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
  // M2.75：登录体检的回执是多行的（结论 + 每一步 + 建议），不 pre-wrap 会挤成一行
  '.msg{margin-top:12px;padding:8px 12px;font-size:12.5px;border-left:2px solid;display:none;word-break:break-all;white-space:pre-wrap}',
  /* M2.75：登录体检结果（结论一行 + 三个步骤 + 建议） */
  /* M2.81：导航里的子面板（适配器 → OneBot / QQ 官方） */
  /* M2.83：分类的展开箭头（默认收起，点开才显示子项） */
  '.navcaret{float:right;font-style:normal;opacity:.55;font-size:11px;padding-right:2px}',
  '.navitem.open{color:#e8d3a0}',
  '.navitem.sub{padding-left:26px;font-size:12.5px;color:#8d8a7e}',
  '.navitem.sub.on{color:#e8d3a0}',
  /* M2.81：总览页的两张入口卡 */
  '.adcards{display:flex;gap:10px;flex-wrap:wrap;margin:4px 0 2px}',
  '.adcard{flex:1 1 280px;min-width:0;text-align:left;background:#0d100e;' +
    'border:1px solid rgba(201,169,97,.18);padding:10px 12px;color:#cfcabc;font:inherit}',
  '.adcard:hover{border-color:rgba(201,169,97,.45)}',
  '.adcard .row{margin-top:8px}',
  '.adcard b{display:block;font-weight:400;font-size:13.5px;color:#e8d3a0;margin-bottom:4px}',
  '.adcard span{display:block;font-size:12px;color:#8d8a7e;line-height:1.6}',
  '.adcard.off b{color:#a8a49a}',
  /* M2.80：通道总览（已启用的高亮，未启用的给出启用方式） */
  '.adch{padding:6px 0;border-bottom:1px solid rgba(201,169,97,.07)}',
  '.adchhead{font-size:13px;color:#a8a49a;margin-bottom:2px}',
  '.adch.on .adchhead{color:#e8d3a0}',
  '.adchhow{font-size:12px;color:#8d8a7e;line-height:1.6}',
  '.tag.ok{color:#9ecf9e;border-color:rgba(158,207,158,.35)}',
  '.adverdict{font-size:13px;padding:6px 0;color:#cfcabc}',
  '.adverdict.ok{color:#9ecf9e}.adverdict.err{color:#e0a0a0}',
  '.adstep{font-size:12.5px;line-height:1.75;color:#a8a49a;padding-left:2px}',
  '.adstep.ok{color:#cfcabc}.adstep.warn{color:#d8b45c}.adstep.fail{color:#e0a0a0}',
  // M2.85：协议端引导里的仓库链接（引导文案里的链接要看得见、点得动）
  '.adstep a,.warn a,.adchhow a{color:#d8b45c}',
  '.msg.ok{display:block;border-color:#6a9a72;background:rgba(106,154,114,.1);color:#a8c9ad}',
  '.msg.err{display:block;border-color:#b5603f;background:rgba(181,96,63,.1);color:#dda28c}',
  '.kv{display:grid;grid-template-columns:130px 1fr;gap:7px 16px;font-size:13px}',
  '.kv dt{color:#7d7a6e}',
  '.kv dd{font-family:Consolas,monospace;color:#d8d2c4}',
  '.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px}',
  '.dot.up{background:#6a9a72;box-shadow:0 0 8px #6a9a72}',
  '.dot.down{background:#8a4a3a}',
  // 三栏：分类 / 记录 / 编辑。中间那栏窄，右边留给表单
  '.split{display:grid;grid-template-columns:172px 292px minmax(0,1fr);gap:12px;align-items:start}',
  '.col{border:1px solid rgba(201,169,97,.14);max-height:640px;overflow:auto}',
  '.catgroup{color:#c9a961;font-size:11px;letter-spacing:.18em;padding:11px 12px 3px;opacity:.85}',
  '.cat{padding:6px 12px;color:#9d9a8c;cursor:pointer;font-size:13px}',
  '.cat:hover{background:rgba(201,169,97,.07);color:#e2ddd0}',
  '.cat.on{background:rgba(201,169,97,.14);color:#e8d3a0}',
  /* M2.90：列表页顶部的分类栏（948 件物品 / 5 个类别，没有它只能从头翻） */
  '.chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 12px 9px}',
  '.chip{font-size:11.5px;color:#9d9a8c;border:1px solid rgba(201,169,97,.22);padding:2px 8px;cursor:pointer;white-space:nowrap}',
  '.chip:hover{color:#e2ddd0;background:rgba(201,169,97,.08)}',
  '.chip.on{color:#0f1310;background:#c9a961;border-color:#c9a961}',
  '.drow{display:block;padding:7px 12px;cursor:pointer;border-bottom:1px solid rgba(201,169,97,.07);text-decoration:none}',
  '.drow:hover{background:rgba(201,169,97,.06)}',
  '.drow.on{background:rgba(201,169,97,.14)}',
  '.drow b{display:block;color:#e2ddd0;font-weight:400;font-size:13px}',
  '.drow i{display:block;color:#7d7a6e;font-style:normal;font-size:11.5px;margin-top:2px}',
  /* M2.64：列表那一列是「中文名（内部 id）」—— id 缩小压暗， */
  /* 一眼分得出「前面是名字、后面那串是 id」，又不抢注意力。 */
  '.idtag{font-style:normal;color:#6b6960;font-size:11.5px;margin-left:6px}',
  '.hint{display:block;color:#6b6960;font-size:11.5px;font-style:normal;margin-top:4px;max-width:420px}',
  '.ro{color:#8d8a7e;font-size:12px;font-family:Consolas,monospace;background:#080b09;border:1px solid rgba(201,169,97,.12);padding:6px 9px;max-width:420px;white-space:pre-wrap;word-break:break-all}',
  '.kvrow{display:flex;gap:7px;align-items:center;margin-bottom:6px}',
  '.kvrow select{max-width:190px}',
  '.kvrow input{max-width:110px}',
  '#login{position:fixed;inset:0;background:#0f1310;display:flex;align-items:center;justify-content:center;z-index:50}',
  '#login .box{width:320px;border:1px solid rgba(201,169,97,.22);padding:30px 28px;background:#0a0e0b}',
  '#login h1{font-size:17px;font-weight:400;letter-spacing:.3em;color:#c9a961;text-align:center;margin-bottom:22px}',
  '.split2{display:grid;grid-template-columns:320px minmax(0,1fr);gap:12px;align-items:start}',
  '.gmstats{display:flex;gap:10px;flex-wrap:wrap;margin:10px 0 6px}',
  '.gmstat{background:#0a0e0b;border:1px solid rgba(201,169,97,.14);padding:6px 12px;min-width:64px}',
  '.gmstat b{display:block;color:#e8d3a0;font-size:16px;font-weight:400}',
  '.gmstat span{color:#7d7a6e;font-size:11px}',
  '.gmline{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:9px}',
  '.gmline select{max-width:260px}',
  '.gmtb{width:100%;border-collapse:collapse;font-size:12.5px;margin-bottom:12px}',
  '.gmtb th{text-align:left;color:#9d9a8c;font-weight:400;border-bottom:1px solid rgba(201,169,97,.16);padding:4px 8px}',
  '.gmtb td{padding:4px 8px;border-bottom:1px solid rgba(201,169,97,.07);color:#cfcabc}',
  '.gmtb code{color:#8d8a7e;font-size:11.5px}',
  '.statbox{display:flex;flex-direction:column;gap:3px;background:#0a0e0b;border:1px solid rgba(201,169,97,.14);padding:8px 10px}',
  '.statbox span{color:#9d9a8c;font-size:11.5px}',
  '.statbox input{width:88px;background:#080b09;border:1px solid rgba(201,169,97,.2);color:#e2ddd0;padding:4px 6px}',
  '.statbox em{color:#5f5d55;font-size:10.5px;font-style:normal}',
  '.warn{margin-top:6px;color:#d8b45c;font-size:12px;line-height:1.7}',
  '.tag{color:#c9a961;font-style:normal;font-size:11px;border:1px solid rgba(201,169,97,.3);padding:0 5px}',
  'h3{font-size:13px;font-weight:400;color:#c9a961;margin:16px 0 8px;letter-spacing:.08em}',
  'code{font-family:Consolas,monospace;color:#a9a496}',
  '.navgroup{padding:14px 20px 4px;color:#5f5d55;font-size:11px;letter-spacing:.14em}',
  '.navitem{display:flex;justify-content:space-between;align-items:center;gap:6px;padding:9px 20px;color:#9d9a8c;border-left:2px solid transparent;cursor:pointer}',
  '.navitem:hover{background:rgba(201,169,97,.06);color:#cfcabc}',
  '.navitem.on{background:rgba(201,169,97,.14);color:#e8d3a0;border-left-color:#c9a961}',
  '.navitem.planned{color:#6b6960;border-left-style:dashed;border-left-color:rgba(201,169,97,.28)}',
  '.navitem em{font-style:normal;font-size:10px;color:#7d7a6e;border:1px dashed rgba(201,169,97,.35);padding:0 4px}',
  '.navfoot{padding:16px 20px;color:#5f5d55;font-size:11px}',
  'ul.plain,ol.plain{margin:0;padding-left:20px;color:#cfcabc;font-size:13px;line-height:1.9}',
  '.alert{border-left:2px solid;padding:8px 12px;margin-bottom:8px;font-size:13px}',
  '.alert.p0{border-color:#b5603f;background:rgba(181,96,63,.1)}',
  '.alert.p1{border-color:#c9a961;background:rgba(201,169,97,.08)}',
  '.alert b{color:#e8d3a0;font-weight:400;margin-right:6px}',
  'pre.md{background:#080b09;border:1px solid rgba(201,169,97,.12);padding:10px 12px;max-height:380px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.7;color:#bfbaac;font-family:Consolas,monospace}',
  '.fbtext{max-width:520px;white-space:pre-wrap;word-break:break-word}',
  '.gmtb select{max-width:160px}',
  '.cmdlist{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:6px;margin-top:8px}',
  '.cmdbox{display:flex;gap:8px;align-items:baseline;background:#0a0e0b;border:1px solid rgba(201,169,97,.12);padding:6px 9px;margin:0}',
  '.cmdbox input{margin:0}',
  '.cmdbox b{color:#e2ddd0;font-weight:400;font-size:12.5px;white-space:nowrap}',
  '.cmdbox i{color:#6b6960;font-style:normal;font-size:11px;line-height:1.5}',
  '.cmdall{display:flex;gap:8px;align-items:center}',
  '.cmdall input{margin:0}',
  'tr.diff td{background:rgba(216,180,92,.07)}',
  'tr.lv-error td{background:rgba(181,96,63,.13)}',
  'tr.lv-error td:nth-child(2){color:#dda28c}',
  'tr.lv-warn td:nth-child(2){color:#d8b45c}',
  'details summary{cursor:pointer;color:#9d9a8c;font-size:12.5px;margin:6px 0}',
  'input[type=datetime-local]{background:#080b09;border:1px solid rgba(201,169,97,.2);color:#e2ddd0;padding:4px 6px}',
  '.hide{display:none !important}',
  /* M2.74：markdown 渲染视图（日报 / 压测报告）。
     与 pre.md 同一套观感（深底、金边），但**不限高** —— 面板整页本来就能滚，
     再套一层内部滚动只会让人滚两次。原文仍然留 pre.md（限高、等宽）供对照与复制。 */
  '.mdview{background:#080b09;border:1px solid rgba(201,169,97,.12);padding:12px 14px}',
  '.mdview>*:first-child{margin-top:0}',
  '.mdview h2,.mdview h3,.mdview h4,.mdview h5{color:#e8d3a0;font-weight:400;margin:14px 0 7px;letter-spacing:.06em}',
  '.mdview h2{font-size:16px}.mdview h3{font-size:14px}.mdview h4,.mdview h5{font-size:13px;color:#c9a961}',
  '.mdview p{margin:0 0 8px;color:#cfcabc;font-size:13px;line-height:1.75}',
  '.mdview ul{margin:0 0 8px;padding-left:20px;color:#cfcabc;font-size:13px;line-height:1.8}',
  '.mdview table{margin-bottom:10px}',
  '.mdview code{color:#d8b45c}',

  /* ================================================================== *
   * M2.73：**自适应**（窄屏 / 平板 / 手机）
   *
   * ## 为什么单独一段放在最后
   *
   * 上面每一条都是**桌面尺寸**下的样子，一条都不动 —— 媒体查询写在最后，
   * 于是窄屏时才生效、宽屏时与加这一段之前**逐像素相同**（不排斥现有观感）。
   *
   * ## 三处非改不可的地方（都是写死的宽度）
   *
   *   body{display:flex} + aside{width:190px}   侧栏占掉一半手机屏宽
   *   .split{172px 292px 1fr}                   三栏合计 464px 起，390px 的屏直接横向溢出
   *   .split2{320px 1fr}                        同上（GM 那一栏）
   *
   * 处理办法是**在窄屏上把它们都变成单列**，而不是加横向滚动条 ——
   * 后台是表单密集的界面，横向滚动的表单没法填。
   * ================================================================== */

  /* 平板：三栏还在，但两侧栏收窄（这一档只调宽窄，不换布局） */
  '@media (max-width:1180px){' +
    '.split{grid-template-columns:150px 240px minmax(0,1fr)}' +
    '.split2{grid-template-columns:260px minmax(0,1fr)}' +
    '}',

  /* 窄屏 / 竖屏平板：侧栏变顶栏，多栏一律堆成一列 */
  '@media (max-width:900px){' +
    // 顶栏：横向可滚的一排导航（比汉堡菜单少一层交互，内部工具够用）
    'body{display:block}' +
    'aside{position:sticky;top:0;z-index:20;width:100%;flex:none;display:flex;align-items:center;' +
      'gap:0;overflow-x:auto;padding:0 6px;border-right:none;' +
      'border-bottom:1px solid rgba(201,169,97,.18);background:#0a0e0b}' +
    'aside h1{font-size:12px;letter-spacing:.18em;padding:13px 10px;margin:0;border-bottom:none;white-space:nowrap}' +
    '.navgroup{display:none}' +
    '.navitem{white-space:nowrap;padding:13px 12px;border-left:none;border-bottom:2px solid transparent}' +
    '.navitem.on{border-left:none;border-bottom-color:#c9a961}' +
    '.navfoot{display:none}' +
    'main{padding:16px 14px}' +
    // 三栏 / 两栏 → 一栏；每一栏自己限高滚动，于是三栏仍然一眼看得全
    '.split,.split2{grid-template-columns:1fr}' +
    '.col{max-height:44vh}' +
    /*
     * 分类栏在窄屏上从「一列 12 行」变成**一条横向可滚的分类条**：
     * 竖着排会白占 44vh（一列文字、两边留白），而它本来就是「选一个分类」——
     * 横向条既省竖向空间（表单因此上移一屏），又利用了窄屏唯一富余的方向。
     * 分组标题（世界内容 / 内容 / 运营）在这一档隐去：横向排时它只会插在中间碍事。
     */
    '#catTree{display:flex;align-items:center;overflow-x:auto;overflow-y:hidden;max-height:none}' +
    '#catTree .cat{white-space:nowrap;padding:10px 12px;border-bottom:2px solid transparent}' +
    '#catTree .cat.on{background:transparent;border-bottom-color:#c9a961}' +
    '#catTree .catgroup{display:none}' +
    // 记录栏也矮一点：手机上「分类条 + 记录 + 表单」三件事都要够得着
    '#dataList{max-height:34vh}' +
    /*
     * 宽表格在窄屏上横向滚动，而不是把整页撑破。
     *
     * ⚠️ **不要在 `fieldset` 上做滚动容器** —— 这是实测踩到的坑：
     * 写了 `fieldset{overflow-x:auto}` 之后，世界面板（一张 514px 的表）**照样把整页撑到 550px**
     * （`--size=390x844` 实测「页宽 550 / 超出 160」，而 fieldset 自己宽 540）。
     * 原因是 fieldset 的匿名内容框不建立滚动容器 —— 那一句等于没写，而且**看起来像是写了**。
     * 所以滚动容器落在**表格自己**身上（下面两条），fieldset 只解除 `min-width:min-content`
     * 这条默认约束（不解除的话它会顶住父级不肯收缩）。
     */
    'fieldset{min-width:0}' +
    '.gmtb{display:block;overflow-x:auto}' +
    '.tb{overflow-x:auto}' +
    // 输入控件占满宽度（窄屏上「420px 上限」没有意义，反而留出无用的空白）
    'input[type=text],input[type=password],input[type=number],select,textarea{max-width:none}' +
    '.gmline select,.kvrow select,.gmtb select{max-width:none}' +
    '.gmline input,.kvrow input{max-width:none}' +
    '.hint,.ro{max-width:none}' +
    '.cmdlist{grid-template-columns:1fr}' +
    // 触摸目标放大（桌面上的 7px 内边距在手指下太小）
    'button{padding:10px 16px}' +
    'button.ghost{padding:8px 12px}' +
    '.statbox input{width:100%}' +
    '.row,.gmline,.kvrow{flex-wrap:wrap}' +
    '}',

  /* 手机：再收一档 —— 键值表上下排、登录框不撑破屏、边距再压 */
  '@media (max-width:560px){' +
    'main{padding:12px 10px}' +
    'h2{font-size:16px}' +
    'fieldset{padding:12px 12px}' +
    // 键值表：标签在上、值在下（130px 的标签列在手机上占掉三分之一）
    '.kv{grid-template-columns:1fr;gap:0}' +
    '.kv dt{margin-top:6px}' +
    '.kv dd{margin-bottom:6px}' +
    '#login .box{width:min(340px,92vw);padding:24px 18px}' +
    '.gmstat{min-width:58px}' +
    'pre.md{max-height:46vh}' +
    '.gmtb{font-size:12px}' +
    '}',
].join('\n');


/** 页面主体 */
export function adminPage(): string {
  return [
    '<!doctype html><html lang="zh"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>诡秘之主 · 管理后台</title><style>', CSS, '</style></head><body>',

    '<div id="login"><div class="box">',
    '<h1>诡 秘 之 主</h1>',
    /*
     * M2.86：**首次运行时这里变成「设置口令」**。
     *
     * 用户：「初次启动脚本时应该检测是否有登录密码，没有则前端显示设置密码界面，
     * 密码要求别那么复杂，几位数都行」。
     *
     * 原来没设口令时服务端会**随机生成一串打进日志** —— 用浏览器的人看不到，
     * 只会看到「口令不对」。现在服务端留空表示「还没设」，这一页据此切换模式。
     */
    '<p id="loginHint" class="hint" style="text-align:center;margin:-10px 0 14px"></p>',
    '<label><span id="pwLabel">管理口令</span><input type="password" id="pw" autofocus></label>',
    '<button id="doLogin" style="width:100%">进 入</button>',
    // 初始必须是 .msg 而不是 .msg.err —— 后者自带 display:block，空提示条会一直挂在按钮下面
    '<div class="msg" id="loginErr"></div>',
    '</div></div>',

    // 导航由 console.js 按服务端注册表（admin/nav.ts）画。
    // 原来链接、<section>、显隐开关分散在三处，漏一处就是「点了没反应」而且没有东西会报错。
    '<aside id="nav"></aside>',

    '<main>',
    '<section id="tab-overview" class="hide"></section>',
    '<section id="tab-planned" class="hide"></section>',
    '<section id="tab-ops" class="hide"></section>',
    '<section id="tab-feedback" class="hide"></section>',
    '<section id="tab-backup" class="hide"></section>',
    '<section id="tab-access" class="hide"></section>',
    '<section id="tab-logs" class="hide"></section>',
    '<section id="tab-audit" class="hide"></section>',
    '<section id="tab-world" class="hide"></section>',
    '<section id="tab-content" class="hide"></section>',
    '<section id="tab-sim" class="hide"></section>',

    '<section id="tab-adapter">',
      /*
       * M2.81：这一页是**通道总览**（导航里「适配器」那个分类本身）。
       * 标题与说明是静态的 —— 不再需要脚本按通道改写（每条通道有自己的子页了）。
       */
      '<h2>适配器</h2>',
      '<p class="sub">这一页是<b>通道总览</b>：现在启用了哪条、另一条怎么开。' +
        '点下面的卡片进入对应适配器 —— 每条通道的配置、状态与按钮都在它自己的页面里。' +
        '通道由 .env 的 <code>ADAPTER</code> 决定：<code>onebot</code>（默认）/ <code>qq</code> / ' +
        '<code>both</code>（两条一起开），改完要<b>重启进程</b>。</p>',

      /*
       * M2.80：**通道总览**。这一页原来是「只显示已经启用的通道」，
       * 于是跑 OneBot 模式的部署根本看不出还有一条 QQ 官方通道可以开 ——
       * 用户的原话就是「为什么适配器里只有 OneBot 适配器？QQ 适配器呢？」。
       */
      '<fieldset><legend>通道总览</legend>',
      '<div id="adChannels"><div class="hint">加载中…</div></div>',
      '<div class="hint">这里把**能用**的通道都列出来，包括还没启用的。' +
        '通道由 .env 的 <code>ADAPTER</code> 决定：<code>onebot</code>（默认）/ <code>qq</code> / ' +
        '<code>both</code>（两条一起开）。改完要<b>重启进程</b>。</div>',
      '</fieldset>',

      /*
       * M2.81：**分类在导航底下，点进去是对应的适配器页**。
       * 这一页只做两件事：说清「现在开了哪条、另一条怎么开」，以及给出入口。
       */
      '<div class="adcards" id="adCards"><div class="hint">加载中…</div></div>',
      // M2.83：启用/停用的回执落在这里（总览页原来没有消息栏，回执会石沉大海）
      '<div class="msg" id="adChanMsg"></div>',
      '</fieldset>',
    '</section>',

    /* ── M2.81：QQ 官方适配器（子页）──────────────────────── */
    '<section id="tab-adapter-qq" class="hide">',
      '<h2>QQ 官方机器人</h2>',
      '<p class="sub">保存后<b>立刻生效</b>的项会直接改到运行中的进程；只有建连时才用的项' +
        '（AppID / AppSecret / 沙箱 / 原生按钮）才要点一下「重连网关」—— <b>不用重启机器人进程</b>。</p>',
      // 这条通道没启用时，这一页不该是空的（见 adapter.js 的 adRenderChannelCards）
      '<div id="adQqOff" class="hide"></div>',

      '<fieldset><legend>实时状态</legend>',
      '<div class="gmstats" id="adLive"><div class="hint">加载中…</div></div>',
      '<div class="hint">每 2 秒刷新一次（只在这个标签页可见时轮询）。' +
        '「白名单拦截」不为 0 = 指令发出来了但被灰度开关挡掉；' +
        '「MD 降级」不为 0 = 平台拒了 Markdown 语法、已回退纯文本（症状是没有图）。</div>',
      '</fieldset>',

      /*
       * ⚠️ 下面这几块是 **QQ 官方通道专属**。OneBot 通道下它们全是无效输入框
       * （AppID / 沙箱 / Markdown 这些在 OneBot 里根本不存在）——
       * 所以打上 qqonly，由脚本按 `channel` 切换显隐。
       * 摆一堆填了也没用的框，比不摆更糟。
       */
      '<fieldset class="qqonly"><legend>进程在用的配置 ⟷ 磁盘上的 .env</legend>',
      '<table class="gmtb" id="adDiff"></table>',
      '<div class="hint">两列不一样的行会被标出来。改完 .env 没重启、或者 .env 里没写但适配器有自己的默认值，' +
        '都会在这里现形 —— 比如「指令白名单」缺省时适配器其实只放行「创建」，并不是全放行。</div>',
      '</fieldset>',

      '<fieldset class="qqonly"><legend>凭据</legend>',
      '<label><span>AppID</span><input type="text" id="appid" placeholder="1905686871"></label>',
      '<label><span>AppSecret（留空表示不改）</span><input type="password" id="secret" placeholder="不回显，填写才覆盖"></label>',
      '<div class="hint">改了这两项要点「重连网关」才生效；AppSecret 留空表示不改（密钥不回显）。</div>',
      '</fieldset>',

      '<fieldset class="qqonly"><legend>登录体检</legend>',
      '<div class="row"><button class="ghost" id="adVerify">跑一次登录体检</button></div>',
      /*
       * M2.75：体检结果直接铺在按钮下面 —— 它是「机器人为什么不理人」的答案，
       * 让人去翻日志或另开一个页面看，等于没做这个功能。
       */
      '<div id="adLogin"></div>',
      '<div class="hint">体检对平台只做三次只读 GET（换 token / 取机器人身份 / 取网关地址与<b>今日会话配额</b>），' +
        '<b>不连网关、不消耗配额</b>。「凭证错」「配额烧光」「被平台拒绝」「网络不通」在玩家那边症状一模一样' +
        '（机器人不理人），处理方式却完全不同 —— 这个按钮就是拿来把它们分开的。</div>',
      '</fieldset>',

      '<fieldset class="qqonly"><legend>开关</legend>',
      '<label><span>沙箱环境</span><select id="sandbox"><option value="0">否（正式）</option><option value="1">是（沙箱）</option></select></label>',
      '<label><span>Markdown 消息</span><select id="markdown"><option value="1">开</option><option value="0">关</option></select></label>',
      '<label><span>原生按钮</span><select id="buttons"><option value="1">开</option><option value="0">关</option></select></label>',
      '<label><span>调试日志（打印每条事件的完整 payload）</span><select id="debug"><option value="0">关</option><option value="1">开</option></select></label>',
      '</fieldset>',

      '<fieldset class="qqonly"><legend>指令白名单</legend>',
      '<label class="cmdall"><input type="checkbox" id="adAll"> 全放行（*）</label>',
      '<div id="adCmds" class="cmdlist"></div>',
      '<div class="hint">名字来自路由**自己注册**的那一份，说明摘自玩家的 .帮助 —— 两边都是唯一出处，不是手抄的清单。' +
        '⚠ 一条都不勾<b>不等于</b>全禁：适配器把空白的白名单当作全放行，所以保存时会被挡住。</div>',
      '</fieldset>',

      '<div class="row"><button id="save" class="qqonly">保存并生效</button>' +
        '<button class="ghost" id="reload">刷新状态</button>' +
        '<button class="ghost qqonly" id="adReconnect">重连网关</button></div>',
      '<div class="msg" id="adapterMsg"></div>',
    '</section>',

    /* ── M2.81：OneBot 适配器（子页）────────────────────────── */
    '<section id="tab-adapter-onebot" class="hide">',
      '<h2>OneBot</h2>',
      '<p class="sub">连接由本进程内置：<b>内置 WS</b> 会主动连协议端的正向 WebSocket 服务器；' +
        '没填 <code>ONEBOT_WS_URL</code> 时退回<b>反向 HTTP 上报</b>（协议端往本机 POST）。' +
        '协议端（NapCat / LLOneBot / Lagrange）要你自己运行 —— 内置的是连接层，不是 QQ 协议本身。</p>',
      '<div id="adObOff" class="hide"></div>',

      '<fieldset><legend>OneBot 连接</legend>',
      '<div class="gmstats" id="adObLive"><div class="hint">加载中…</div></div>',
      '<div class="row">' +
        '<button class="ghost" id="adObReconnect">重连协议端</button>' +
        '<button class="ghost" id="adObVerify">体检：协议端在线吗</button>' +
      '</div>',
      '<div class="msg" id="adObMsg"></div>',
      '<div class="hint">「收到事件」不动 = 协议端没把消息推过来（多半是它没连上、或者群里没人说话）。' +
        '「心跳」是协议端还活着的证据。反向 HTTP 上报模式下「连接」显示「不适用」—— ' +
        '那种传输本来就没有长连接。</div>',
      '</fieldset>',

      /* M2.82：与 QQ 子页对称的配置区 —— 两条通道都能在后台改，不必手编 .env */
      /*
       * M2.85：**协议端引导**。
       *
       * 用户问过「OneBot 登录框架没内嵌吗？起码实现扫码登录」—— 扫码只能由协议端做
       * （本项目不内嵌 QQ 协议，见台账 B2-12）。既然不能内嵌，就至少要说清楚
       * 「装没装、跑没跑、下一步该点哪里」，而不是让人对着「未连接」发呆。
       */
      '<fieldset><legend>协议端（QQ 登录在这一侧）</legend>',
      '<div class="row"><button class="ghost" id="adObDetect">检测本机协议端</button></div>',
      '<div id="adObEnv"><div class="hint">点一下查本机有没有装协议端（NapCat / Lagrange 等）。' +
        '<b>扫码登录永远在协议端做</b> —— 本项目只负责连它、收发消息，不实现 QQ 协议。' +
        '这不是偷懒：自己实现 QQ 协议要逆向 + 长期对抗风控，还违反平台用户协议；' +
        '内嵌 QQ 客户端则要带上几百 MB 的本体做注入。两条路都不该出现在一个要发行的项目里。</div></div>',
      '</fieldset>',

      '<fieldset><legend>进程在用的配置 ⟷ 磁盘上的 .env</legend>',
      '<table class="gmtb" id="adObDiff"></table>',
      '<div class="hint">两列不一样的行会被标出来：改完 .env 没重启、或 .env 没写而进程用了默认值，' +
        '都会在这里现形。</div>',
      '</fieldset>',

      '<fieldset><legend>连接与白名单</legend>',
      '<label><span>协议端地址（正向 WS；留空 = 用反向 HTTP 上报）</span>' +
        '<input type="text" id="adObWsUrl" placeholder="ws://127.0.0.1:3001"></label>',
      '<label><span>access_token（留空表示不改）</span>' +
        '<input type="password" id="adObToken" placeholder="不回显，填写才覆盖"></label>',
      '<div class="hint">改了地址 / 令牌要点上面的「重连协议端」才生效，<b>不用重启进程</b>。</div>',
      '<label><span>指令白名单（逗号分隔；留空或 * = 全放行）</span>' +
        '<input type="text" id="adObCmdsText" placeholder="创建,状态"></label>',
      '<div class="row"><button id="adObSave">保存并生效</button></div>',
      '<div class="hint">白名单<b>立刻生效</b>，与 QQ 官方通道同一套口径（判定指令名用的是同一个函数）。' +
        '注意：空白名单在适配器里是「全放行」而不是「全禁」—— 想只放行几条就把它们写进去。</div>',
      '</fieldset>',
    '</section>',

    '<section id="tab-gm" class="hide">',
      '<h2>GM 管理</h2>',
      '<p class="sub">改的是 data/game.db 里的玩家状态，<b>立刻生效</b> —— 玩家下一次说话就是新数值。' +
        '每一次写入都会记进 audit_logs（在该玩家的「最近操作留档」里能看到）。</p>',
      '<div class="row">',
      '<input type="text" id="gmQ" placeholder="搜角色名 / 角色 ID / QQ 号 / 昵称" style="flex:1;min-width:260px">',
      '<button id="gmSearchBtn">搜索</button>',
      '<button class="ghost" id="gmReloadList">全部</button>',
      '</div>',
      '<div class="gmstats" id="gmStats"></div>',
      '<div class="split2">',
      '<div class="col" id="gmList"></div>',
      /*
       * ⚠️ M2.86：**去掉了 `overflow:visible`**（用户报：「点击玩家显示编辑页后，
       * 世界·势力关系那栏没做显示兼容，直接重叠在一起」）。
       *
       * 原因：`gmDetail` 里的编辑页很长，而 `overflow:visible` 允许它**溢出容器**，
       * 于是直接压在下一个兄弟节点（`#gmWorld` 那个 fieldset）上面。
       * 改成默认的 `auto` —— 超出就在这一列里滚动，不再盖住别人。
       * 同时给 `split2` 加 `align-items:flex-start`：两列各自按内容高度排，
       * 否则 flex 会把短的那一列拉伸，看起来也像错位。
       */
      '<div class="col" id="gmDetail" style="border:none"></div>',
      '</div>',

      /*
       * M2.68：**世界级**的那一栏（与玩家无关的 GM 写入）。
       * 现在只有一件：势力之间的关系 —— 它覆盖 powers.yaml 的默认外交底图，
       * 而这张底图会影响「谁对某件事反应」（domain/world/power.ts 的第二轮）。
       */
      '<fieldset id="gmWorld"><legend>世界 · 势力关系</legend>',
      '<div class="hint">写进去的是一条**运行时**关系，覆盖 powers.yaml 与历史旧仇里的同一条。' +
        '它决定两件事：盟友会在同一件事上互相壮胆、敌对的会互相牵制。</div>',
      '<div class="gmline">',
      '<select id="gmRelFrom"></select>',
      '<select id="gmRelKind"></select>',
      '<select id="gmRelTo"></select>',
      '<button id="gmRelSave">写入关系</button>',
      '</div>',
      '<div class="msg" id="gmRelMsg"></div>',
      '</fieldset>',
    '</section>',

    '<section id="tab-data" class="hide">',
      '<h2>数据编辑</h2>',
      '<p class="sub">写回前自动备份到 data/backups/，重启机器人后生效。',
      '控件按字段类型出，英文枚举显示中文 —— 不要在这里手写 yaml。</p>',
      /*
       * M2.77：说明**范围**。
       *
       * 原来这里写的是「改的是 src/data/*.yaml」—— 那时确实只有那些。
       * 现在失控文本池、卡片片段、内容注册表、137 张事件卡都在后台了，
       * 那句话会让运营以为卡片改不了，然后去手改文件（这正是要避免的那条路）。
       */
      '<p class="sub">范围：<b>全部内容文件</b> —— src/data/*.yaml、src/cards 下的',
      '失控文本池 / 卡片片段池 / 内容注册表，以及三类事件卡（一个文件一张，',
      '按目录分成「每日 / 普通人 / 途径专属」三个列表）。</p>',
      /*
       * 另外四张表**刻意**留在代码里。写出来不是解释，是免得人找不到：
       * 后台没有它，不等于它不存在 —— 运营找不到就会去翻代码手改。
       */
      '<p class="sub">另有四张表刻意放在代码里：<b>数值</b>（src/config/numeric.ts，',
      '判定层按名字读它，改成数据文件就没有编译期检查了）、<b>序列称号</b>',
      '（src/card/titles.ts，权威源是 docs/设计书.md 的 T0.2 表）、<b>途径专属行动</b>与',
      '<b>入途径线索</b>（含判定逻辑，不只是文案）。改它们要动代码并跑测试。</p>',
      '<div class="split">',
      '<div class="col" id="catTree"></div>',
      '<div class="col" id="dataList"></div>',
      '<div class="col" id="dataForm" style="border:none;overflow:visible"></div>',
      '</div>',
    '</section>',
    '</main>',

    '<script>',
    'var $=function(s){return document.querySelector(s)};',
    'function msg(el,ok,text){el.className="msg "+(ok?"ok":"err");el.textContent=text}',
    'function api(path,opt){return fetch("/admin/api"+path,Object.assign({credentials:"same-origin"},opt||{})).then(function(r){',
    '  if(r.status===401){$("#login").classList.remove("hide");throw new Error("未登录")}',
    '  return r.json().then(function(d){if(!r.ok)throw new Error(d.error||"请求失败");return d})})}',
    /*
     * 先问一句「设过口令没有」，据此切换这一页的模式。
     *
     * ⚠️ 这一步必须在挂 onclick **之前**跑完：模式决定了点下去调哪个端点。
     * 用 `$('#login').dataset.mode` 记状态，而不是在闭包里各存一份 ——
     * 后者在「探到之前就点了」的情况下会走错分支（探到的是 null，等于登录）。
     */
    'api("/setup").then(function(d){',
    '  if(!d||!d.needsSetup)return;',
    '  $("#login").dataset.mode="setup";',
    '  $("#loginHint").textContent="第一次使用：先设一个管理口令（几位都行，只要别忘了）";',
    '  $("#pwLabel").textContent="设置管理口令";',
    '  $("#doLogin").textContent="设 置 并 进 入";',
    '}).catch(function(){});',
    '$("#doLogin").onclick=function(){$("#doLogin").disabled=true;',
    '  var path=$("#login").dataset.mode==="setup"?"/setup":"/login";',
    '  api(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:$("#pw").value})})',
    '   .then(function(){$("#login").classList.add("hide");',
    '     if(typeof consoleStart==="function")consoleStart()})',
    '   .catch(function(e){var t=(e&&e.message)||"";',
    // fetch 抛的是网络层错误（服务没起 / 端口不对 / 被代理拦），和「口令不对」是两回事。
    // 混在一起说，人会一直重输口令，而真正的问题在连接上。
    '     if(t.indexOf("Failed to fetch")>=0||t.indexOf("NetworkError")>=0||t.indexOf("load failed")>=0)',
    '       t="连不上服务。确认地址是 http://127.0.0.1:3100/admin，且机器人进程在跑";',
    '     else if(t==="未登录") t="口令不对";',
    '     msg($("#loginErr"),false,t)})',
    '   .then(function(){$("#doLogin").disabled=false})};',
    '$("#pw").addEventListener("keydown",function(e){if(e.key==="Enter")$("#doLogin").click()});',
    // 导航与面板切换全在 console.js（本脚本之后加载）—— 这里不再写死任何面板名
    // 初始化先探一次：cookie 还有效就直接进去。
    // #login 是 position:fixed;inset:0;z-index:50，不收起就盖住整个后台 ——
    // 签名 cookie 的 12 小时有效期、重启不失效，全靠这一步才成立。
    // 适配器的面板逻辑全在 adapter.js（本脚本之后加载），这里只留一句探测。
    'api("/adapter").then(function(){$("#login").classList.add("hide");',
    '  if(typeof consoleStart==="function")consoleStart()}).catch(function(){});',
    '</script>',
    // ⚠️ md.js 必须在 console.js **之前**：面板渲染时直接调用 renderMarkdownHtml()，
    //    顺序反了会得到「renderMarkdownHtml is not defined」，而那是一个**白屏级**的错误
    //    （面板整块渲染不出来）—— 顺序由 test/m2-74 的接线用例守着。
    '<script src="/admin/md.js"></script>',
    '<script src="/admin/console.js"></script>',
    '<script src="/admin/adapter.js"></script>',
    '<script src="/admin/editor.js"></script>',
    '<script src="/admin/gm.js"></script></body></html>',
  ].join('\n');
}
