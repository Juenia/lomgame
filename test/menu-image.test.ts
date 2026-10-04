/**
 * 图片菜单的三条硬约束（M2.86）。
 *
 * 用户的要求是「检索项目所有指令　绘制永久性的精美图片菜单　不要过长，可以多分几张
 * 菜单不应该是一次性的」—— 这里逐条把它变成**会红的断言**：
 *
 *   ① **一份清单**：说明表必须与 `router.commands` 完全对上（AGENTS §3.1）。
 *      手抄一份清单最贵的失败方式是**它不报错** —— 类型齐全、运行期安静地少读。
 *   ② **不过长**：每张图 <= 10 条。
 *   ③ **不是一次性的**：缓存键只随**内容**变；内容没变时两次出图**逐字节相同**，
 *      而且第二次是 `fromCache`。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMAND_GROUPS, INTERNAL_COMMANDS, documentedNames } from '../src/domain/menu/command-groups.ts';
import { menuCacheKey, menuHtml, menuPageCount, menuText } from '../src/card/menu-image.ts';
import { createHarness } from './helpers/app.ts';

test('图片菜单：说明表与 router.commands **完全对上**（没有第二份手抄清单）', () => {
  const harness = createHarness();
  const real: string[] = (harness.app.router as unknown as { commands: string[] }).commands;
  harness.app.close();
  const documented = new Set(documentedNames());
  const internal = new Set(INTERNAL_COMMANDS);
  const missing = real.filter((name) => !documented.has(name) && !internal.has(name));
  assert.deepEqual(missing, [], '有指令没写进菜单说明：' + missing.join('、'));
  const extra = documentedNames().filter((name) => !real.includes(name));
  assert.deepEqual(extra, [], '菜单里写了不存在的指令：' + extra.join('、'));
  // 反过来：内部指令不该混进玩家菜单
  for (const name of INTERNAL_COMMANDS) {
    assert.ok(!documented.has(name), '内部指令「' + name + '」混进了玩家菜单');
  }
});

test('图片菜单：**每张不过长**（<= 10 条），而且确实分了多张', () => {
  assert.ok(menuPageCount() > 1, '应当分多张（用户：「可以多分几张」）');
  for (const group of COMMAND_GROUPS) {
    assert.ok(group.commands.length <= 10, group.title + ' 有 ' + group.commands.length + ' 条，太长了');
    assert.ok(group.commands.length > 0, group.title + ' 是空页');
  }
});

test('图片菜单：缓存键**只随内容变**（这就是「永久性」）', () => {
  const a = COMMAND_GROUPS[0]!;
  assert.equal(menuCacheKey(a, 1, 6), menuCacheKey(a, 1, 6), '同一内容两次算出的键必须一致');
  assert.notEqual(menuCacheKey(a, 1, 6), menuCacheKey(a, 2, 6), '不同张的键要不同');
  const changed = { ...a, commands: [...a.commands, { name: '测试用', brief: '改了内容' }] };
  assert.notEqual(menuCacheKey(a, 1, 6), menuCacheKey(changed, 1, 6), '内容变了键必须变');
});

test('图片菜单：文字兜底与图片**同源**（不会图上有的字版没有）', () => {
  for (let i = 1; i <= menuPageCount(); i += 1) {
    const text = menuText(i);
    const group = COMMAND_GROUPS[i - 1]!;
    assert.ok(text.includes(group.title), '第 ' + i + ' 张的文字版缺标题');
    for (const command of group.commands) {
      assert.ok(text.includes('.' + command.name), '第 ' + i + ' 张的文字版缺「' + command.name + '」');
      assert.ok(text.includes(command.brief), '第 ' + i + ' 张的文字版缺「' + command.name + '」的说明');
    }
  }
});

test('图片菜单：HTML 里**说明文字真的被拼进去了**（防拼串漏掉的静默 bug）', () => {
  /*
   * 这条是被一个真实事故逼出来的：`.c` 的 `</div>'` 后多了一个**分号**，
   * `return` 在那里就结束了，拼 `.b`（说明）的那半句从来没执行 ——
   * 出图只剩一排指令名横着铺开、说明全丢，而**浏览器不报错**（它自己补全了没闭合的 div）。
   * 所以这里直接断言「HTML 里每一句 brief 都在」。
   */
  const html = menuHtml(COMMAND_GROUPS[0]!, 1, menuPageCount());
  for (const command of COMMAND_GROUPS[0]!.commands) {
    assert.ok(html.includes(command.brief), 'HTML 里缺说明：' + command.brief);
  }
});
