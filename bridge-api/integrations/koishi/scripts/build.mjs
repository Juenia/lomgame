/**
 * 编译插件。
 *
 * ## 为什么不直接用 tsc 的退出码
 *
 * `src/client.ts` 从仓库里 **type-only** 引了协议类型：
 *
 *   import type { OutboundItem, … } from "../../../src/protocol.ts";
 *
 * 那个文件在 `rootDir` 之外，于是 tsc 报一条 TS6059 并**返回非零**。
 * 但产物是完全正确的 —— `import type` 编译后整行消失，运行时没有任何依赖。
 *
 * 直接把退出码当成功判据的话，`npm pack` / `npm publish` 会直接失败（踩过）。
 * 而吞掉错误又会让「真的编译失败」也悄悄通过。
 *
 * 所以：**不看退出码，看产物**。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const repoRoot = join(pkgRoot, "..", "..", "..");
const tsc = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

if (!existsSync(tsc)) {
  console.error("找不到 tsc（" + tsc + "）—— 先 npm install");
  process.exit(1);
}

try {
  execFileSync(tsc, ["-p", "tsconfig.json"], { cwd: pkgRoot, stdio: "inherit", shell: process.platform === "win32" });
} catch {
  // 预期内的 TS6059；下面用产物判断到底成没成
}

const needed = ["lib/index.js", "lib/client.js", "lib/core.js", "lib/node-runtime.js"];
const missing = needed.filter((f) => !existsSync(join(pkgRoot, f)));
if (missing.length > 0) {
  console.error("编译没产出这些文件：" + missing.join(", "));
  process.exit(1);
}
console.log("插件已编译：" + needed.length + " 个模块 → lib/");
