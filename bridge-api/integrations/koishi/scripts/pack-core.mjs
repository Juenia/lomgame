/**
 * 打包游戏内核进 `core/`：**复制源码 → 编译成 JS → 搬非代码资源**。
 *
 * ## 为什么必须编译（这一条是被真实故障逼出来的）
 *
 * 内核是 TypeScript。Node 22 能直接跑 `.ts`（类型剥离），**但**：
 *
 *   Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]:
 *   Stripping types is currently unsupported for files under node_modules
 *
 * —— 装进 `node_modules` 之后 Node **拒绝**剥离类型。所以「直接跑 .ts」在开发机上
 * 可行，一旦发布成 npm 包就必然失败。**必须编译。**
 *
 * ## 三个坑（都踩过）
 *
 * 1. **`@types/node` 必须在**：编译目录里没有它，`node:fs` / `process` 全线报错
 *    （669 个），而**报错时 tsc 仍会输出部分文件** —— 于是运行时报的是
 *    「模块没有导出 xxx」，跟类型毫无关系，极难定位。所以这里把仓库的
 *    `node_modules/@types` 链进编译目录。
 *
 * 2. **资源文件要单独搬**：tsc 只处理 `.ts`，而内核运行时还要读
 *    `.sql`（数据库迁移）、`.yaml`（全部游戏内容）、`.json`。不搬的话启动就 ENOENT。
 *
 * 3. **搬资源时不能覆盖 tsc 的产物**：`src/admin/` 里同时存在
 *    `adapter.ts`（服务端逻辑）和 `adapter.js`（注入后台页面的浏览器脚本）——
 *    同名不同物。先编译再搬资源的话，那个浏览器脚本会把编译产物盖掉，
 *    于是 `admin/index.js` 报「adapter.js 没有导出 commandCatalogue」。
 *
 * 4. **`src/vplayer/` 不能排除**：`longChain` 的「生产读取点」检查（K19）会扫
 *    整个 `src/`，而读取点在 `vplayer/longchain.ts` 里。排除它就等于把读取点删了，
 *    内核启动时报「longChain 没有任何生产读取点」。
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const repoRoot = join(pkgRoot, "..", "..", "..");
const target = join(pkgRoot, "core");
const work = join(target, "build");

const WANTED = ["src", "bridge-api/src"];
const EXCLUDED = new Set(["node_modules", "test", "tests", "__tests__", "docs", ".git"]);

if (!existsSync(join(repoRoot, "src", "main.ts"))) {
  console.error("找不到仓库根（" + repoRoot + "）—— 这个脚本要在仓库里跑");
  process.exit(1);
}

/*
 * 用 Node 内置的 cpSync，不手写递归。
 *
 * 手写的那版在真实目录上直接崩了（0xC0000409，栈溢出）——
 * 内核的目录深、文件多（1000+ 个），每层一个栈帧就撑爆了。
 * cpSync 内部是迭代式的，没有这个问题。
 */
const copyTree = (from, to) => {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, {
    recursive: true,
    filter: (src) => !EXCLUDED.has(src.split(/[\\/]/).pop()),
  });
};

let written = 0;
try {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  // 编译产物直接落到 core/dist（outDir: "../dist"）——
  // 不走「先编到 build/dist 再 cpSync 过去」：那一步在 Windows 上复制 1300+ 文件时
  // 会以 0xC0000409 崩溃，而且纯属多余。

  // ① 源码
  for (const rel of WANTED) copyTree(join(repoRoot, rel), join(work, rel));
  writeFileSync(join(work, "package.json"), JSON.stringify({ type: "module" }, null, 2) + "\n", "utf8");

  // ② 类型定义与运行时依赖（编译需要它们能解析）
  const typesDir = join(work, "node_modules");
  mkdirSync(typesDir, { recursive: true });
  for (const dep of ["@types", "yaml", "zod"]) {
    const from = join(repoRoot, "node_modules", dep);
    if (existsSync(from)) {
      try { symlinkSync(from, join(typesDir, dep), "junction"); } catch { /* 有就行 */ }
    }
  }

  // ③ 编译
  writeFileSync(join(work, "tsconfig.core.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022", lib: ["ES2023"], module: "NodeNext", moduleResolution: "NodeNext",
      types: ["node"], strict: true, skipLibCheck: true, esModuleInterop: true,
      noEmit: false, declaration: false, sourceMap: false,
      outDir: "../dist", rootDir: ".",
      allowImportingTsExtensions: true, rewriteRelativeImportExtensions: true,
      erasableSyntaxOnly: true, verbatimModuleSyntax: true,
    },
    include: ["src/**/*.ts", "bridge-api/src/**/*.ts"],
    exclude: ["node_modules/**", "dist/**"],
  }, null, 2), "utf8");

  const tsc = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  if (!existsSync(tsc)) { console.error("找不到 tsc —— 先 npm install"); process.exit(1); }
  console.log("正在编译内核…");
  execFileSync(tsc, ["-p", "tsconfig.core.json"], { cwd: work, stdio: "inherit", shell: process.platform === "win32" });

  const distSrc = join(target, "dist");
  if (!existsSync(join(distSrc, "bridge-api", "src", "main.js"))) {
    console.error("编译完却没有 dist/bridge-api/src/main.js");
    process.exit(1);
  }

  // ④ 搬非代码资源（不覆盖 tsc 的产物）
  let assets = 0;
  let kept = 0;
  // 迭代式遍历（不递归），逐文件决定搬不搬
  const copyAssets = (from, to) => {
    if (!existsSync(from)) return;
    const queue = [[from, to]];
    while (queue.length > 0) {
      const [dir, out] = queue.pop();
      mkdirSync(out, { recursive: true });
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const s = join(dir, entry.name);
        const d = join(out, entry.name);
        if (entry.isDirectory()) { queue.push([s, d]); continue; }
        if (entry.name.endsWith(".ts")) continue;
        if (existsSync(d) && d.endsWith(".js")) { kept += 1; continue; }
        copyFileSync(s, d);
        assets += 1;
      }
    }
  };
  for (const rel of WANTED) copyAssets(join(work, rel), join(distSrc, rel));
  console.log("随编译搬过去的资源：" + assets + " 个，跳过 " + kept + " 个（tsc 已有产物）");

  const seed = join(repoRoot, "bridge-api", "integrations", "bee-go", "other", "seed", "bridge.db");
  if (existsSync(seed)) {
    mkdirSync(join(target, "seed"), { recursive: true });
    copyFileSync(seed, join(target, "seed", "bridge.db"));
    console.log("带了种子数据库（首次启动不用等 seeding）");
  }
  rmSync(work, { recursive: true, force: true });

  let files = 0;
  const queue2 = [join(target, "dist")];
  while (queue2.length > 0) {
    const dir = queue2.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) queue2.push(p);
      else { files += 1; written += statSync(p).size; }
    }
  }
  console.log("内核已编译：" + files + " 个文件，" + (written / 1024 / 1024).toFixed(1) + " MB → core/dist/");
} catch (error) {
  /*
   * 写不动就**沿用现有内容**。
   *
   * Windows 上 Koishi 正跑着内核时 `core/` 是锁着的（进程持着文件句柄），
   * 删也删不掉、覆盖也写不进 —— 而「开发机上 Koishi 正跑着」是最常见的情形。
   *
   * ⚠️ 这里**不能直接退出**：改一行插件代码（`lib/` 那侧）也要发版，
   * 而那种改法根本不碰内核，却会因为目录被锁而发不出去。
   *
   * 之所以安全：内核对**插件改动**是无关的，而「内核本身改了却没打进去」
   * 这个风险由下面的完整性检查 + 人眼盯的那行警告兜着。
   */
  const message = error instanceof Error ? error.message : String(error);
  console.log("core/ 被占用（" + message.slice(0, 70) + "），沿用现有内容");
  console.log("⚠️ 如果你**这次改了内核源码**（src/ 或 bridge-api/src/），停掉 Koishi 重跑一次");
}

// 完整性检查
const entry = join(target, "dist", "bridge-api", "src", "main.js");
if (!existsSync(entry)) {
  console.error("core/dist 里没有内核入口 —— 这个包发出去用户用不了");
  process.exit(1);
}
const mig = join(target, "dist", "src", "infra", "db", "migrations");
if (!existsSync(mig)) {
  console.error("缺数据库迁移目录，内核起不来");
  process.exit(1);
}
console.log("core/dist 完整：含迁移 " + readdirSync(mig).length + " 个文件");
