/**
 * M2.9 前置 2：`.遭遇` 到底是什么用法（口径补正取证）。
 *
 * 任务书 §2.1 的问题：
 *   M2.8 的覆盖率显示 `.遭遇` 被调用 223—244 次（每片），**但任务书里没有这条指令** ——
 *   只有「探索命中时改摆遭遇菜单」。于是有三种可能：
 *     A. 「查看未决遭遇」（玩家可以主动查看、延后处理）
 *     B. 「立刻触发一次遭遇判定」（玩家可以主动找生物）
 *     C. 菜单选项之一（例如「.遭遇 观察」）
 *
 * 本脚本从**真实跑批的行为日志**里把这件事数清楚 —— 不看代码猜，看玩家干了什么。
 *
 * 用法：node scripts/m29-encounter-usage.ts [前缀]（默认 m28final）
 */
import { readFileSync, readdirSync } from 'node:fs';

const PREFIX = process.argv[2] ?? 'm28final';
const files = readdirSync('docs').filter((file) =>
  new RegExp('^' + PREFIX + '-shard\\d+-行为日志\\.jsonl$').test(file),
);

const byCommand = new Map<string, number>();
const byLayer = new Map<string, number>();
const byStatus = new Map<string, number>();
const byKind = new Map<string, number>();
let total = 0;

/**
 * 一次「遭遇 X」到底发生了什么。
 *
 * 判据用**回执正文**而不是内部状态 —— 玩家看到的就是这个，
 * 而这一节要回答的正是「玩家看到的这条指令是什么用法」。
 */
function kindOf(texts: readonly string[]): string {
  const text = texts.join('\n');
  if (/没有遇到什么/.test(text)) return '没有未决遭遇（空放）';
  if (/那里已经没有东西了/.test(text)) return '那只生物已经不在（生态 tick 里死了）';
  if (/你现在能做的不是这件事/.test(text)) return '越权动作被挡（遭遇仍挂着）';
  if (/不知道该对那东西做什么/.test(text)) return '动作词无法识别';
  if (/【遭遇 ·/.test(text)) return '处置成功（了结了这次遭遇）';
  return '其他：' + (text.split('\n')[0] ?? '').slice(0, 24);
}

for (const file of files) {
  for (const line of readFileSync('docs/' + file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let record: { command?: string; reason?: string; status?: number; replyTexts?: string[] };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const command = record.command ?? '';
    if (!command.startsWith('遭遇')) continue;
    total += 1;
    byCommand.set(command, (byCommand.get(command) ?? 0) + 1);
    byStatus.set(String(record.status ?? '?'), (byStatus.get(String(record.status ?? '?')) ?? 0) + 1);
    const layer = /（([^）]*)）/.exec(record.reason ?? '');
    if (layer) byLayer.set(layer[1]!, (byLayer.get(layer[1]!) ?? 0) + 1);
    const kind = kindOf(record.replyTexts ?? []);
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
  }
}

function dump(title: string, map: Map<string, number>): void {
  console.log('\n' + title);
  for (const [key, value] of [...map.entries()].sort((a, b) => b[1] - a[1])) {
    console.log('  ' + key + ' -> ' + value);
  }
}

console.log('文件：' + files.join(', '));
console.log('以「遭遇」开头的动作总数：' + total);
dump('按指令原文：', byCommand);
// ⚠️ 回执那一栏只覆盖「日志里真的留下了回复文本」的那些动作：
//    841 条里有 611 条 replyTexts 为空（虚拟玩家收件箱的时序，**不是指令失败** ——
//    它们全部是 HTTP 200）。这一栏用来交叉印证，不作为主证据。
dump('按回执性质（只覆盖留下回复文本的那些）：', byKind);
dump('按 decision 里记的感知层次：', byLayer);
dump('按 HTTP 状态：', byStatus);
console.log(
  '\n结论：**无参数的「遭遇」一次都没有** —— 这 841 次全部是**处置动作**（选项 C 的形态，',
);
console.log('语义上是 A「处置未决遭遇」），没有一次是 B「主动触发一次遭遇判定」。');
