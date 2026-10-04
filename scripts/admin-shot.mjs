/*
 * 看一眼管理后台**真实渲染出来的样子**。这是开发工具，不是产品代码。
 *
 * ## 为什么需要它
 *
 * 后台的界面是 JS 拼出来的。DOM 里有的东西不一定看得见，DOM 里没有的东西
 * 也可能有按钮摆在那儿 —— 只有截图能同时说明这两件事。这一轮的两处 bug 都是它发现的：
 *   · 签名 cookie 还有效，登录框却仍然盖在最上面（DOM 里数据编辑器明明渲染好了）
 *   · rows 字段渲染成「一列都没有的空表」，点「加一行」没反应
 * 所以改完后台界面，**看一眼再下结论**，别只读 DOM。
 *
 * ## 怎么跑
 *
 * 零依赖：用 CDP 直接驱动 Edge 无头模式（Node 24 自带 fetch / WebSocket）。
 * 口令从 .env 的 ADMIN_PASSWORD 读，不写死在代码里。
 *
 *   node scripts/admin-shot.mjs --tab=gm --out=gm.png
 *   node scripts/admin-shot.mjs --tab=data --entity=churches --row=0 --out=churches.png
 *   node scripts/admin-shot.mjs --tab=data --entity=churches --row=0 --save
 *
 * ⚠️ --tab 收的是 ASCII 名（adapter / gm / data），不是界面上的中文。
 * 这台机器上 PowerShell 会把命令行里的中文参数弄乱（老问题了），
 * 传中文过来会变成一个匹配不上的乱码串。
 *
 * 需要机器人进程在跑（它才是那个 HTTP 服务）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const flag = (name) => argv.includes('--' + name);

const url = arg('url', 'http://127.0.0.1:3100/admin');
/** 界面上的导航名。命令行只传 ASCII 键，中文在这儿映射 */
const TABS = { adapter: '适配器', gm: 'GM 管理', data: '数据编辑' };
const tab = TABS[arg('tab', 'data')] ?? arg('tab', 'data');
const entity = arg('entity', '');
const row = Number(arg('row', '0'));
const search = arg('q', '');
const scroll = Number(arg('scroll', '0'));
const out = arg('out', join(tmpdir(), 'admin-shot.png'));
const port = Number(arg('port', '9337'));
/*
 * M2.73：**看窄屏**。默认 1500×1150（桌面），传 --size=390x844 就是一台手机。
 *
 * ⚠️ 只改 --window-size **不够**：headless 里窗口尺寸与 CSS 视口不一定相等，
 * 媒体查询会按另一个宽度算 —— 于是「手机上看着还行」变成一句没有证据的话。
 * 所以下面还要一次 Emulation.setDeviceMetricsOverride（那才是 CSS 视口）。
 */
const [viewW, viewH] = (() => {
  const hit = /^(\d+)x(\d+)$/.exec(arg('size', '1500x1150'));
  if (!hit) throw new Error('--size 要写成 宽x高，例如 --size=390x844');
  return [Number(hit[1]), Number(hit[2])];
})();

function adminPassword() {
  const fromEnv = process.env.ADMIN_PASSWORD;
  if (fromEnv) return fromEnv;
  try {
    const hit = /^ADMIN_PASSWORD=(.*)$/m.exec(readFileSync('.env', 'utf8'));
    if (hit) return hit[1].trim();
  } catch { /* 没 .env 就走下面的报错 */ }
  throw new Error('读不到 ADMIN_PASSWORD（.env 里没有，环境变量也没有）');
}

const edge = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!edge) throw new Error('找不到 msedge.exe');

const profile = mkdtempSync(join(tmpdir(), 'dsh-cdp-'));
const child = spawn(edge, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-sync', '--disable-background-networking',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile,
  '--window-size=' + viewW + ',' + viewH, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('Edge 没起来（端口 ' + port + ' 可能被上一轮的残留实例占着）');
}

const target = await pageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const waiters = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiters.has(m.id)) {
    const w = waiters.get(m.id);
    waiters.delete(m.id);
    if (m.error) w.rej(new Error(JSON.stringify(m.error)));
    else w.res(m.result);
  }
};
const send = (method, params) => new Promise((res, rej) => {
  const id = ++seq;
  waiters.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params: params || {} }));
});
async function evaluate(expression, awaitPromise) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: !!awaitPromise, returnByValue: true });
  if (r.exceptionDetails) throw new Error(expression.slice(0, 70) + ' -> ' + JSON.stringify(r.exceptionDetails.exception));
  return r.result.value;
}
async function goto(u) {
  await send('Page.navigate', { url: u });
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    try { if (await evaluate('document.readyState') === 'complete') return; } catch { /* 导航中 */ }
  }
}

try {
  await send('Page.enable');
  await send('Runtime.enable');
  /*
   * 真实 CSS 视口（媒体查询按它算）—— 桌面宽度下这一步等价于什么都不做。
   *
   * ⚠️ `mobile` 必须是 **false**，这是一次实测踩到的坑：
   * 打开它之后 Chrome 会对「内容比视口宽」的页面做 **shrink-to-fit** ——
   * 它不是让页面横向溢出，而是**把视口本身撑宽**（实测：`--size=390x844` 的世界面板
   * 报出 `window.innerWidth = 551`）。于是「超出 0」变成一个**假绿**：
   * 页面确实没溢出，因为它偷偷把尺子换了。
   * 关掉它之后视口恒等于 `--size`，溢出数字才是可信的（那也正是媒体查询看的东西）。
   */
  await send('Emulation.setDeviceMetricsOverride', {
    width: viewW,
    height: viewH,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await goto(url);
  const login = await evaluate(
    "fetch('/admin/api/login',{method:'POST',headers:{'content-type':'application/json'}," +
    'body:JSON.stringify({password:' + JSON.stringify(adminPassword()) + '})}).then(r=>r.status)',
    true,
  );
  console.log('登录 ->', login);
  await goto(url);
  await sleep(500);

  /*
   * 比较时去掉空格：界面上写的是「GM 管理」，不处理的话按名字切不过去。
   *
   * ⚠️ 这里**故意不用正则**：这段表达式本身是一个单引号字符串，
   * 里面的 \s 会被当成未知转义吃成 s，正则变成 /s+/g —— 静默失效，
   * 只是永远匹配不上，没有任何报错。用 split/join 就没有这一层。
   */
  const squish = (s) => s.split(' ').join('');
  const switchTab = (label) =>
    '(function(){var want=' + JSON.stringify(squish(label)) + ';' +
    'var n=[].slice.call(document.querySelectorAll("aside a"))' +
    '.filter(function(x){return x.textContent.split(" ").join("")===want})[0];' +
    'if(n)n.click();return !!n;})()';

  // 面板切换走 hash（框架支持 hash 路由）—— 命令行里的中文会被 PowerShell 弄乱，
  // 所以这里传的是面板 id，不是界面上的中文名
  const panel = arg('panel', 'overview');
  await evaluate('location.hash = ' + JSON.stringify(panel) + '; 1');
  await sleep(1000);
  console.log('面板 ->', await evaluate(
    'JSON.stringify({hash:location.hash,可见:[].slice.call(document.querySelectorAll("main > section"))' +
    '.filter(function(s){return !s.classList.contains("hide")}).map(function(s){return s.id})})'));

  if (entity !== '') {
    // 选择器先拼好再 stringify —— 直接把选择器写进表达式的引号里，转义层数一深就必错
    const catSel = JSON.stringify('.cat[data-e=' + JSON.stringify(entity) + ']');
    console.log('选分类 ' + entity + ' ->', await evaluate(
      '(function(){var c=document.querySelector(' + catSel + ');if(c)c.click();return !!c;})()'));
    await sleep(700);
    console.log('选第 ' + row + ' 条 ->', await evaluate(
      '(function(){var r=document.querySelectorAll(".drow")[' + row + '];if(r)r.click();return !!r;})()'));
    await sleep(700);
  } else if (panel === 'gm') {
    if (search !== '') {
      await evaluate('(function(){var q=document.querySelector("#gmQ");if(q)q.value=' + JSON.stringify(search) + ';return 1})()');
      await evaluate('(function(){var b=document.querySelector("#gmSearchBtn");if(b)b.click();return 1})()');
      await sleep(900);
    }
    console.log('选第一个玩家 ->', await evaluate(
      '(function(){var r=document.querySelector("#gmList .drow");if(r)r.click();return !!r;})()'));
    await sleep(900);
  }

  if (flag('save')) {
    await evaluate('document.querySelector("#saveRow").click(); 1');
    await sleep(1800);
    console.log('保存回执 ->', await evaluate('(document.querySelector("#rowMsg")||{textContent:"(无)"}).textContent'));
  }

  // 可见性自检：截图前先确认该出来的东西真在页面上
  console.log('状态 ->', await evaluate(
    'JSON.stringify({登录框:(function(){var l=document.querySelector("#login");' +
    'return l?getComputedStyle(l).display:"无"})()' +
    ',分类数:document.querySelectorAll(".cat").length' +
    ',玩家数:document.querySelectorAll("#gmList .drow").length' +
    ',按钮:[].slice.call(document.querySelectorAll("main button")).map(function(b){return b.textContent.trim()}).slice(0,14)})'));

  /*
   * M2.73：**横向溢出**是「不适配」最硬的判据 ——
   * 页面比视口宽多少像素，一眼就知道有没有东西撑破。
   */
  /*
   * 溢出自检：
   *   超出   —— 整页比视口宽多少（>0 就是没适配）
   *   宽元素 —— 比视口还宽的元素（扣掉自己就是溢出源）
   *   内溢出 —— 自身内容比自身宽（说明它是个该出现滚动条的容器，或者是个挤不下的格子）
   * 三条一起看，定位比只看「超出」快得多。
   */
  /** 整页比视口宽多少 —— 0 才算适配（下面用它决定退出码） */
  const overflowX = await evaluate('Math.max(0,document.documentElement.scrollWidth-window.innerWidth)');
  console.log('视口 ' + viewW + 'x' + viewH + ' 溢出 ->', await evaluate(
    'JSON.stringify({页宽:document.documentElement.scrollWidth,' +
    '视口:window.innerWidth,' +
    '超出:Math.max(0,document.documentElement.scrollWidth-window.innerWidth),' +
    '宽元素:' + '[].slice.call(document.querySelectorAll("main *")).map(function(e){' +
    'var r=e.getBoundingClientRect();' +
    'return {t:e.tagName+"."+String(e.className||"").slice(0,20)+(e.id?"#"+e.id:""),' +
    'w:Math.round(r.width),sw:e.scrollWidth,cw:e.clientWidth}})' +
    '.filter(function(x){return x.w>window.innerWidth-20}).sort(function(a,b){return b.w-a.w}).slice(0,6),' +
    '内溢出:' + '[].slice.call(document.querySelectorAll("main *")).map(function(e){' +
    'return {t:e.tagName+"."+String(e.className||"").slice(0,20)+(e.id?"#"+e.id:""),' +
    'sw:e.scrollWidth,cw:e.clientWidth}})' +
    '.filter(function(x){return x.sw>x.cw+2}).sort(function(a,b){return (b.sw-b.cw)-(a.sw-a.cw)}).slice(0,6)})'));

  await evaluate('window.scrollTo(0, ' + scroll + '); 1');
  await sleep(300);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('PNG ' + out);
  /*
   * M2.73：**横向溢出 = 不适配**，所以它要能让脚本失败（退出码 2）。
   * 这样将来谁把它接进 CI / 一键检查，就不用盯着数字看 —— 红就是红。
   */
  if (overflowX > 0) {
    console.error('✖ 视觉视口 ' + viewW + 'px 下横向溢出 ' + overflowX + 'px —— 这个面板没有适配窄屏');
    process.exitCode = 2;
  }
} finally {
  ws.close();
  child.kill();
}
process.exit(0);
