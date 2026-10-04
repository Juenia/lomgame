/**
 * 一键修复的**安全边界**（M2.86）。
 *
 * 用户的原话是：「**切记是一键修复，不是点了后一键修坏**」。
 * 所以这个文件测的不是「修得对不对」（那是 `contentView` 的事），
 * 而是**修的时候不许越界**：
 *
 *   ① **幂等** —— 连跑两次，第二次必须是空计划、文件逐字节不变；
 *       （这条曾经真的挂过：第一版把「events 是空的」当成「插在 adjacent 前」，
 *        于是空数组留着 ⇒ 第二次又判缺卡 ⇒ **再插一遍**，文件里堆出两行 events。）
 *   ② **只改该改的那些行** —— 差异行数必须等于计划条数，多一行都算修坏；
 *   ③ **池子必须是「能绑给任何地点的卡」** —— 不许出现 `seq7_*`（序列专属）
 *       或 `lost_*`（失控专属）：把序列 7 的卡绑到序列 9 的地点就是修坏。
 */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyEventCardFix, pickCardsFor, planEventCardFix } from '../src/admin/fix.ts';

/*
 * ⚠️ 必须用 `fileURLToPath`，不能拿 `URL.pathname`。
 *
 * 本仓库的路径里有中文（`诡秘之主MVP`），而 `pathname` 会把它保留成
 * `%E8%AF%A1%E7%A7%98...` —— 于是 `cpSync` 找不到目录、四条用例一起 ENOENT。
 * `fileURLToPath` 会正确解码，Windows 上的盘符也一并处理。
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA = join(ROOT, 'src', 'data');

// 每个用例在**副本**上跑，绝不碰真仓库的文件
const tempDirs: string[] = [];
function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fix-'));
  tempDirs.push(dir);
  cpSync(DATA, join(dir, 'data'), { recursive: true });
  /*
   * ⚠️ 卡片要拷到 **`dir/cards`**，不是 `dir/src/cards`。
   *
   * `planEventCardFix` 用 `join(contentDir, '..', 'cards', 'daily')` 找池子 ——
   * contentDir 是 `dir/data`，所以它找的是 **`dir/cards`**。
   * 拷错层级的后果**不是报错**，而是**池子为空 ⇒ 计划为空 ⇒ 什么都不修**，
   * 于是「幂等」那条用例拿到 0 条计划，看起来像功能坏了，其实是沙箱摆错了。
   */
  cpSync(join(ROOT, 'src', 'cards'), join(dir, 'cards'), { recursive: true });
  return join(dir, 'data');
}
after(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }); });

test('一键修复：**幂等** —— 连跑两次，第二次是空计划且文件不变', () => {
  const data = sandbox();
  /*
   * ⚠️ **自己造场景，不依赖仓库当前状态**。
   *
   * 第一版断言「这个仓库应当有待修的地点」—— 那条在**修完之后就跑不过了**
   * （第一次运行把 96 个地点都补上了，副本里再没有空 events）。
   * 判据一旦依赖「数据还没被修过」，它就会在修好之后变红，成为假警报。
   * 所以这里先把三个地点的 events 清空，制造出**确定存在**的待修项。
   */
  const file = join(data, 'locations.yaml');
  let cleared = 0;
  const seeded = readFileSync(file, 'utf8').replace(/^(\s+events:\s*)\[[^\]]+\]/gm, (whole, head: string) => {
    if (cleared >= 3) return whole;
    cleared += 1;
    return head + '[]';
  });
  assert.equal(cleared, 3, '副本里应当能清出三个待修项（内容表结构变了就来看一眼）');
  writeFileSync(file, seeded, 'utf8');
  const plan1 = planEventCardFix(data);
  assert.equal(plan1.changes.length, 3, '刚清空的三处应当被计划到：' + plan1.summary);
  applyEventCardFix(data, plan1);
  const after1 = readFileSync(file, 'utf8');
  const plan2 = planEventCardFix(data);
  assert.equal(plan2.changes.length, 0, '第二次不该还有要修的：' + plan2.summary);
  const result = applyEventCardFix(data, plan2);
  assert.equal(result.written, 0, '第二次不该写任何一行');
  assert.equal(readFileSync(join(data, 'locations.yaml'), 'utf8'), after1, '第二次不该改动文件');
});

test('一键修复：**只改该改的行** —— 差异行数等于计划条数', () => {
  const data = sandbox();
  const file = join(data, 'locations.yaml');
  const before = readFileSync(file, 'utf8').split('\n');
  const plan = planEventCardFix(data);
  applyEventCardFix(data, plan);
  const after = readFileSync(file, 'utf8').split('\n');
  assert.equal(after.length, before.length, '用 replace 时行数不该变（增行说明改错了模式）');
  let diff = 0;
  for (let i = 0; i < before.length; i += 1) if (before[i] !== after[i]) diff += 1;
  assert.equal(diff, plan.changes.length, '差异行数必须等于计划条数 —— 多一行就是越界改');
});

test('一键修复：**池子里只有能绑给任何地点的卡**（绝不放序列/失控专属卡）', () => {
  const data = sandbox();
  const plan = planEventCardFix(data);
  for (const change of plan.changes) {
    const ids = change.after.replace(/^.*\[|\].*$/g, '').split(',').map((x) => x.trim()).filter((x) => x.length > 0);
    assert.ok(ids.length > 0, '补的必须是真卡：' + change.after);
    for (const id of ids) {
      assert.ok(id.startsWith('daily_'), '不许用非通用卡「' + id + '」—— 那是修坏（' + change.reason + '）');
    }
  }
});

test('一键修复：抽卡**确定性**（同一地点两次抽到同一批）', () => {
  const pool = ['daily_001', 'daily_002', 'daily_003', 'daily_004', 'daily_005'];
  assert.deepEqual(pickCardsFor('konstun_center', pool), pickCardsFor('konstun_center', pool));
  assert.notDeepEqual(pickCardsFor('a', pool), pickCardsFor('b', pool), '不同地点该抽到不同组合（否则等于没抽）');
  for (const x of pickCardsFor('konstun_center', pool)) assert.ok(pool.includes(x), '只能从池子里取：' + x);
});

test('一键修复：**备份只写一次**（第二次不许覆盖第一份原始备份）', () => {
  const data = sandbox();
  const plan = planEventCardFix(data);
  applyEventCardFix(data, plan);
  const bak = join(data, 'locations.yaml.bak');
  assert.ok(existsSync(bak), '第一次落盘应当留下备份');
  const firstBackup = readFileSync(bak, 'utf8');
  // 手动改脏文件，再跑一次（此时计划应为空，备份仍不该被覆盖）
  writeFileSync(join(data, 'locations.yaml'), readFileSync(join(data, 'locations.yaml'), 'utf8') + '\n', 'utf8');
  applyEventCardFix(data, planEventCardFix(data));
  assert.equal(readFileSync(bak, 'utf8'), firstBackup, '备份必须停在「改动之前」那一份');
});
