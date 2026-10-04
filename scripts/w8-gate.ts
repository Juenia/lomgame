/**
 * 准入判定脚本（M2.0 口径统一后：**只做一件事 —— 把主报告的三栏表搬进准入报告并校验一致**）
 *
 *   node scripts/w8-gate.ts                       # W8 默认路径
 *   node scripts/w8-gate.ts --stage M2.1 --main docs/M2-回归报告.md \
 *     --coverage docs/M2-回归-覆盖率.md --out docs/M2-回归-准入报告.md
 *
 * 判定实现只有一份：src/vplayer/acceptance.ts。
 * 本脚本**不重新算判定**，而是把主报告里的三张表解析回来，用同一个 verdictOf() 重算，
 * 与主报告自己打印的判定行逐字比对：
 *   - 一致 → 写准入报告（表格逐字搬过来，所以两份报告的结论在构造上就相同）；
 *   - 不一致 → 退出码 1，并说明差在哪（这正是 M2.0 要根除的「同一批数据两个结论」）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadCards } from '../src/cards/loader.ts';
import {
  COLUMN_TITLE,
  flatten,
  renderGateTable,
  renderVerdictLine,
  untriggeredByNature,
  verdictOf,
  type Gate,
  type GateColumn,
  type JudgedGate,
  type GateSet,
} from '../src/vplayer/acceptance.ts';

const NL = String.fromCharCode(10);
const ROW = '| ';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const STAGE = arg('stage', 'W8');
const MAIN = arg('main', 'docs/W8-虚拟玩家报告.md');
const COVERAGE = arg('coverage', 'docs/W8-虚拟玩家-覆盖率.md');
const EDGE = arg('edge', 'docs/W8-虚拟玩家边界轮报告.md');
const EDGE_COVERAGE = arg('edge-coverage', 'docs/W8-虚拟玩家边界轮-覆盖率.md');
const OUT = arg('out', 'docs/' + STAGE + '-准入报告.md');
const TITLE = arg('title', STAGE + ' 准入报告（M2 准入判定）');

function read(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** 取某个二级标题到下一个二级标题之间的内容 */
function section(markdown: string, heading: string): string {
  return blockUntil(markdown, heading, NL + '## ');
}

/** 取某个三级标题到下一个三级 / 二级标题之间的内容（三栏表用这个） */
function subsection(markdown: string, heading: string): string {
  return blockUntil(markdown, heading, NL + '### ', NL + '## ');
}

function blockUntil(markdown: string, heading: string, ...stops: string[]): string {
  const start = markdown.indexOf(heading);
  if (start < 0) return '';
  const rest = markdown.slice(start + heading.length);
  const ends = stops.map((stop) => rest.indexOf(stop)).filter((index) => index >= 0);
  return ends.length === 0 ? rest : rest.slice(0, Math.min(...ends));
}

function tableRows(block: string, skipHeader: string): string[] {
  return block
    .split(NL)
    .filter((line) => line.startsWith(ROW) && !line.includes('---') && !line.startsWith(skipHeader));
}

function number(text: string | null | undefined): number | null {
  if (!text) return null;
  const match = /-?[0-9]+(?:[.][0-9]+)?/.exec(text);
  return match ? Number(match[0]) : null;
}

/** 从 markdown 表格里取某行某列（列号从 1 开始，跳过行首的空单元格） */
function cell(markdown: string, rowStartsWith: string, column: number): string | null {
  const line = markdown.split(NL).find((candidate) => candidate.trim().startsWith(ROW + rowStartsWith + ' '));
  if (!line) return null;
  const cells = line.split('|').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return cells[column] ?? null;
}

/** 把一张 4 列表格解析回 gate（结论列的图标决定状态） */
function parseRows(block: string): JudgedGate[] {
  const parsed: JudgedGate[] = [];
  for (const line of tableRows(block, ROW + '判定项')) {
    const cells = line.split('|').slice(1, -1).map((entry) => entry.trim());
    if (cells.length < 4) continue;
    const conclusion = cells[3] ?? '';
    const status = conclusion.includes('🟢') ? 'green' : conclusion.includes('🟡') ? 'yellow' : conclusion.includes('🔴') ? 'red' : null;
    if (!status) continue;
    // 报告里没有档位列 ⇒ 一律补最严的 diagnostic（与 acceptance.ts 的 parseGateTable 同一口径）
    parsed.push({ name: cells[0]!, actual: cells[1]!, requirement: cells[2]!, status, tier: 'diagnostic' });
  }
  return parsed;
}

/* ---------------- 1. 读主报告：三栏表 + 判定行 ---------------- */

const main = read(MAIN);
if (!main) {
  console.error('缺少主报告，请先跑虚拟玩家实例测试：');
  console.error('  node src/vplayer/cli.ts --players 200 --days 7 --seed vplayer-w8 --persona all \\');
  console.error('    --report-prefix W8-虚拟玩家 --out ' + MAIN);
  process.exit(1);
}

const blocks: Record<GateColumn, string> = {
  system: subsection(main, '### 1. ' + COLUMN_TITLE.system),
  content: subsection(main, '### 2. ' + COLUMN_TITLE.content),
  numeric: subsection(main, '### 3. ' + COLUMN_TITLE.numeric),
};

const missing = (Object.keys(blocks) as GateColumn[]).filter((column) => blocks[column].trim() === '');
if (missing.length > 0) {
  console.error('主报告不是 M2.0 三栏口径（缺栏：' + missing.join('、') + '）。请用当前模板重跑虚拟玩家 CLI。');
  process.exit(1);
}

const gates: GateSet = {
  system: parseRows(blocks.system),
  content: parseRows(blocks.content),
  numeric: parseRows(blocks.numeric),
};

/** 三栏表下面的「- **判定项**：说明」行：解析回 note，免得准入报告丢掉口径说明 */
function notesOf(block: string): Map<string, string> {
  const notes = new Map<string, string>();
  for (const line of block.split(NL)) {
    const match = /^- \*\*(.+?)\*\*：(.*)$/.exec(line.trim());
    if (match) notes.set(match[1]!, match[2]!);
  }
  return notes;
}

for (const column of ['system', 'content', 'numeric'] as GateColumn[]) {
  const notes = notesOf(blocks[column]);
  for (const gate of gates[column]) {
    const note = notes.get(gate.name);
    if (note) gate.note = note;
  }
}
const all = flatten(gates);
const computed = verdictOf(all);
const stated = /\*\*判定：([^*]+)\*\*（红 (\d+) \/ 黄 (\d+) \/ 绿 (\d+)/.exec(main);

if (!stated) {
  console.error('主报告里没有可解析的判定行，无法校验一致性。');
  process.exit(1);
}
const statedReds = Number(stated[2]);
const statedYellows = Number(stated[3]);
const statedGreens = Number(stated[4]);
if (
  stated[1]!.trim() !== computed.verdict ||
  statedReds !== computed.reds ||
  statedYellows !== computed.yellows ||
  statedGreens !== computed.greens
) {
  console.error('❌ 两份报告结论不一致 —— 这正是 M2.0 要根除的问题：');
  console.error('   主报告判定：' + stated[1] + '（红 ' + statedReds + ' / 黄 ' + statedYellows + ' / 绿 ' + statedGreens + '）');
  console.error('   三栏重算  ：' + computed.verdict + '（红 ' + computed.reds + ' / 黄 ' + computed.yellows + ' / 绿 ' + computed.greens + '）');
  process.exit(1);
}

/* ---------------- 2. 未触发卡分类（覆盖率体检 → 已触发集合） ---------------- */

const coverage = read(COVERAGE);
const hitIds = new Set<string>();
if (coverage) {
  const block = section(coverage, '## 事件卡覆盖（要求 ≥1 次）');
  for (const line of tableRows(block, ROW + '卡 id')) {
    const id = (line.split('|')[1] ?? '').trim();
    if (id && line.includes('| 达标 |')) hitIds.add(id);
  }
}

const cardMetas = loadCards().cards.map((card) => ({
  id: card.id,
  conds: card.trigger.cond ?? [],
  minSeq: card.trigger.min_seq,
  maxSeq: card.trigger.max_seq,
}));
const groups = untriggeredByNature(cardMetas, hitIds);
const dependent = groups.filter((group) => group.lostControlDependent);
const dependentTotal = dependent.reduce((sum, group) => sum + group.total, 0);
const dependentMissed = dependent.reduce((sum, group) => sum + group.missed.length, 0);

/* ---------------- 3. 边界轮：补充证据（不参与判定） ---------------- */

const edgeMain = read(EDGE);
const edgeCov = read(EDGE_COVERAGE);
const edgeMadP90 = edgeMain ? number(cell(section(edgeMain, '## 四、期末数值分布'), 'MAD', 3)) : null;
const edgeLostTriggered = edgeCov ? !/本轮没有触发失控文本/.test(edgeCov) : null;

/* ---------------- 4. 出报告 ---------------- */

const body: string[] = [];
body.push('# ' + TITLE);
body.push('');
body.push('> 数据来源：' + MAIN + (coverage ? '、' + COVERAGE : '') + (edgeMain ? '、' + EDGE : '') + '。');
body.push('> 本文件由 scripts/w8-gate.ts 生成：三栏表**逐字搬自主报告**，判定用同一份 src/vplayer/acceptance.ts 重算并校验一致。');
body.push('');
body.push(renderVerdictLine(computed));
body.push('');

const columns: Array<{ column: GateColumn; title: string }> = [
  { column: 'system', title: '一、系统栏（跑得通、跑得稳、可复现）' },
  { column: 'content', title: '二、内容栏（写了的东西玩家见得到）' },
  { column: 'numeric', title: '三、数值栏（落进模拟器的区间）' },
];
for (const { column, title } of columns) {
  body.push('## ' + title);
  body.push('');
  for (const line of renderGateTable(gates[column])) body.push(line);
  body.push('');
  const notes = gates[column].filter((gate) => gate.note);
  for (const gate of notes) body.push('- **' + gate.name + '**：' + gate.note);
  if (notes.length > 0) body.push('');
}

body.push('### 未触发卡按性质分类（M2.0：不再笼统算「未通过」）');
body.push('');
body.push('| 性质 | 张数 | 已触发 | 未触发卡 |');
body.push('|---|---|---|---|');
for (const group of groups) {
  body.push('| ' + group.label + ' | ' + group.total + ' | ' + group.hit + ' | ' + (group.missed.length === 0 ? '无' : group.missed.join('、')) + ' |');
}
body.push('');
body.push(
  '**失控依赖**（失控状态门 + 数值阈值门）共 ' + dependentTotal + ' 张，未触发 ' + dependentMissed + ' 张：' +
    (dependentMissed === 0 ? '本轮全部可见。' : '它们不是「实例测试没跑到」，而是窗口内不可达 —— M2.1 的处理对象。'),
);
body.push('');

if (edgeMain) {
  const edgeHitBlock = edgeCov ? section(edgeCov, '## 事件卡覆盖（要求 ≥1 次）') : '';
  const edgeDependentHit = tableRows(edgeHitBlock, ROW + '卡 id')
    .filter((line) => line.includes('| 达标 |'))
    .map((line) => (line.split('|')[1] ?? '').trim())
    .filter((id) => dependent.some((group) => group.total > 0 && id.startsWith('lost_')));
  body.push('### 边界轮补充证据（不参与判定，只看趋势）');
  body.push('');
  body.push('| 指标 | 边界轮实测 |');
  body.push('|---|---|');
  body.push('| 期末 MAD P90 | ' + (edgeMadP90 ?? '?') + ' |');
  body.push('| 失控文本 | ' + (edgeLostTriggered === null ? '未跑' : edgeLostTriggered ? '有触发' : '0 条') + ' |');
  body.push('| lost_* 卡触发 | ' + (edgeCov ? edgeDependentHit.join('、') || '0 张' : '未跑') + ' |');
  body.push('');
}

body.push('## 四、下一步决策建议');
body.push('');
const reds = all.filter((gate) => gate.status === 'red');
const yellows = all.filter((gate) => gate.status === 'yellow');
if (reds.length > 0) {
  body.push('**红项（先修，阻塞进入下一阶段）**');
  body.push('');
  for (const gate of reds) body.push('- **' + gate.name + '**：实测 ' + gate.actual + '（要求 ' + gate.requirement + '）');
  body.push('');
}
if (yellows.length > 0) {
  body.push('**黄项（下一阶段第一优先）**');
  body.push('');
  for (const gate of yellows) body.push('- **' + gate.name + '**：实测 ' + gate.actual + (gate.note ? ' —— ' + gate.note : ''));
  body.push('');
}
if (reds.length === 0 && yellows.length === 0) {
  body.push('三栏全绿：没有阻塞项，也没有需要跟进的黄项。');
  body.push('');
}
body.push('## 五、复现');
body.push('');
body.push('```bash');
body.push('# 主轮（本报告的数据来源）');
body.push('node src/vplayer/cli.ts --players 200 --days 7 --seed vplayer-w8 --persona all --report-prefix W8-虚拟玩家 --out ' + MAIN);
body.push('# 边界轮');
body.push('node src/vplayer/cli.ts --players 40 --days 14 --seed vplayer-w8-edge --persona aggressive,chaotic --no-strict --report-prefix W8-虚拟玩家边界轮 --out ' + EDGE);
body.push('# 本报告（含一致性校验，不一致即退出码 1）');
body.push('node scripts/w8-gate.ts' + (STAGE === 'W8' ? '' : ' --stage ' + STAGE + ' --main ' + MAIN + ' --coverage ' + COVERAGE + ' --out ' + OUT));
body.push('```');
body.push('');

writeFileSync(OUT, body.join(NL), 'utf8');
console.log('已生成 ' + OUT + '：' + computed.verdict + '（红 ' + computed.reds + ' / 黄 ' + computed.yellows + ' / 绿 ' + computed.greens + '）');
console.log('一致性校验：主报告判定行 = 三栏重算结果 ✅');
for (const gate of reds) console.log('  🔴 ' + gate.name + ' — ' + gate.actual);
for (const gate of yellows) console.log('  🟡 ' + gate.name + ' — ' + gate.actual);
