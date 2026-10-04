/**
 * 守卫：「无适配器版」**真的**没有适配器。
 *
 * ## 为什么这条测试值得单独存在
 *
 * 用户对这个版本的要求是"删除所有适配器，改为提供 API"。
 * 而"删掉了"这件事**没有天然的判据** —— 只要有一处 `import { OneBotAdapter }`，
 * 整个模块图就会把 OneBot 协议、QQ 官方网关、token 管理一起拉进来，
 * 而进程照样跑得好好的：**没有报错、没有日志、行为也没变**。
 * 这种"悄悄回潮"正是需要一条会变红的判据去守的东西（K14：抓不住故障的判据是装饰）。
 *
 * 两道判据，缺一不可：
 *   1. **静态**：源码里不许出现指向平台适配器的 import（连 type-only 也不许）；
 *   2. **运行时**：真去加载一次入口，看模块解析器实际拉进来哪些文件 ——
 *      静态扫描看不出"业务模块间接 import 了适配器"这种间接回潮。
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** 这些模块**就是**平台适配器：这一版一个都不许出现 */
const FORBIDDEN = [
  'adapter/onebot.ts',
  'adapter/onebot-ws.ts',
  'adapter/official.ts',
  'adapter/qq-official/',
  'adapter/composite.ts',
  'adapter/memory.ts',
];

/** 这些是**契约与纯函数**（不是适配器实现）—— 允许，但只许 `import type` */
const CONTRACT = ['adapter/types.ts', 'adapter/interactive.ts', 'adapter/highlight.ts', 'adapter/command-name.ts'];

async function listSources(dir: string, out: string[] = []): Promise<string[]> {
  // 目录还不存在（比如集成还没写）不算失败 —— 扫不到东西的判据会在下面显式报出来
  const entries = await readdir(join(ROOT, dir), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      await listSources(rel, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(rel);
    }
  }
  return out;
}

test('静态：bridge-api 的源码里没有任何指向平台适配器的 import', async () => {
  const files = [...(await listSources('src')), ...(await listSources('integrations'))];
  assert.ok(files.length >= 5, '至少扫到几个源文件（判据本身要有效，实际 ' + files.length + ' 个）');
  const offenders: string[] = [];
  for (const file of files) {
    const text = await readFile(join(ROOT, file), 'utf8');
    for (const match of text.matchAll(/^\s*import[^;]*?from\s+'([^']+)'/gm)) {
      const target = match[1]!;
      for (const bad of FORBIDDEN) {
        if (target.includes(bad)) offenders.push(`${file} → ${target}`);
      }
    }
  }
  assert.deepEqual(offenders, [], '这些 import 必须删掉：\n' + offenders.join('\n'));
});

test('静态：对契约层的引用一律是 import type（运行时一条都不加载）', async () => {
  const files = [...(await listSources('src')), ...(await listSources('integrations'))];
  const offenders: string[] = [];
  for (const file of files) {
    const text = await readFile(join(ROOT, file), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*import\s+(.*?)from\s+'([^']*adapter[^']*)'/);
      if (!m) continue;
      const clause = m[1]!;
      if (!clause.startsWith('type ') && !clause.startsWith('type{')) {
        offenders.push(`${file}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], '契约层只用于类型，必须是 import type：\n' + offenders.join('\n'));
});

test('运行时：加载本版入口，模块图里没有平台适配器（且确实加载了判定内核）', async (t) => {
  const mod = await import('node:module');
  const registerHooks = (mod as unknown as { registerHooks?: (hooks: unknown) => void }).registerHooks;
  if (typeof registerHooks !== 'function') {
    t.skip('这个 Node 没有 module.registerHooks（需要 22.15+）');
    return;
  }
  const loaded: string[] = [];
  registerHooks({
    resolve(specifier: string, context: unknown, nextResolve: (s: string, c: unknown) => { url: string }) {
      const resolved = nextResolve(specifier, context);
      loaded.push(resolved.url);
      return resolved;
    },
  });
  // 加载的正是这个版本的入口（它与真实进程启动时加载的东西一致）
  await import('../src/main.ts');
  assert.ok(
    loaded.some((u) => u.includes('/src/router/index.ts')),
    '判据本身要有效：路由内核必须出现在加载列表里（否则这条测试什么都没证明）',
  );
  const offenders = loaded.filter((u) => FORBIDDEN.some((bad) => u.includes(bad)));
  assert.deepEqual(offenders, [], '运行时把适配器拉进来了：\n' + offenders.join('\n'));
});
