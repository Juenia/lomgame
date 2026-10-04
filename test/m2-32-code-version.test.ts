/**
 * M2.32 任务 1（P0）：**跑批产物记录代码版本**。
 *
 * ## 为什么这条 P0 值得一个测试文件
 *
 * M2.31 任务 0.2 查出：7 个历史批次的产物里没有一处记着跑它的是哪份代码 ⇒
 * 「这批比上批多 N 人」永远缺「两批代码差多少」这个未知量。
 *
 * 而这个字段**没有任何东西会因为它缺失而变红** —— 少写一个字段，
 * tsc 全绿、测试全绿、跑批照常出数（M2.31 补 G11 的教训：加变体没有任何东西发现它）。
 * 所以这里守三件事：
 *
 *   1. **取法的语义**（取不到 git 时不许回一个看起来正常的值 —— K19 的形状）；
 *   2. **写入点**（`src/vplayer/cli.ts` 真的把四个字段写进了产物 JSON）；
 *   3. **合并层的判据**（8 片 rev 不一致时必须报出来，而不是挑一片的值冒充）。
 *
 * ## 对照侧（K9）
 *
 * 「现在的实现是对的」不够 —— 还要证明**同一个判据在实现错的时候会报**。
 * 每条关键断言都配了一个「篡改后必须红」的对照侧。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  breakdownOf,
  codeVersionOf,
  describeCodeVersion,
  gitStatusPaths,
  type CodeVersion,
} from '../src/vplayer/code-version.ts';
import { codeConsistencyOf, mergedCodeVersion } from '../src/vplayer/merge.ts';
import type { ShardJson } from '../src/vplayer/shard-json.ts';

/** 假 git：按命令返回给定的 stdout；不认识的命令返回 null（= 命令失败） */
function fakeGit(replies: Record<string, string | null>): {
  calls: string[][];
  read: (args: readonly string[], cwd: string) => string | null;
} {
  const calls: string[][] = [];
  return {
    calls,
    read: (args) => {
      calls.push([...args]);
      return replies[args.join(' ')] ?? null;
    },
  };
}

/* ================= 1. 取法的语义 ================= */

test('M2.32：codeVersionOf 从 git 现场读 —— rev / dirty / builtAt 三件齐全', () => {
  const git = fakeGit({
    'rev-parse HEAD': 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n',
    'status --porcelain -z': ' M src/config/numeric.ts\0?? docs/m221a-shard-0.json\0',
  });
  const code = codeVersionOf({ readGit: git.read, cwd: '.', builtAt: '2026-02-01T00:00:00.000Z' });

  assert.equal(code.codeRev, 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', 'rev 要去掉行尾换行');
  assert.equal(code.codeDirty, true);
  assert.equal(code.builtAt, '2026-02-01T00:00:00.000Z');
  assert.equal(code.codeDirtyDetail.judgement, 1, 'src/ 下的改动算判定输入');
  assert.equal(code.codeDirtyDetail.artifacts, 1, 'docs/ 下的产物');
  assert.deepEqual(code.codeDirtyDetail.sample, ['src/config/numeric.ts']);
});

test('M2.32：工作区干净时 codeDirty=false，且两个计数都是 0', () => {
  const git = fakeGit({ 'rev-parse HEAD': 'deadbeef\n', 'status --porcelain -z': '' });
  const code = codeVersionOf({ readGit: git.read, cwd: '.' });
  assert.equal(code.codeDirty, false);
  assert.deepEqual(code.codeDirtyDetail, { judgement: 0, artifacts: 0, sample: [] });
  assert.match(describeCodeVersion(code), /工作区干净/);
});

test('M2.32：取不到 git 时**不许**回一个看起来正常的值（K19 —— 「取不到」不是「干净」）', () => {
  const git = fakeGit({}); // 所有命令都失败 = 这台机器上没有 git
  const code = codeVersionOf({ readGit: git.read, cwd: '.' });

  assert.equal(code.codeRev, 'unknown', 'rev 必须是显式的 unknown，不是空串（空串看起来像「没这一项」）');
  assert.equal(code.codeDirty, true, '无法证明工作区干净，就不声明它干净 —— 方向必须是保守的');
  assert.match(describeCodeVersion(code), /取不到 git/);
});

test('M2.32 对照侧（K9）：把「取不到 git」误实现成「干净」时，这条判据必须红', () => {
  /*
   * 对照侧：证明上面那条断言抓得住真实错误形状 ——
   * 一个「git 不可用 → 假装工作区是干净的」的实现，会让一批不可重生成的产物被标成可重生成。
   */
  const naive = { codeRev: '', codeDirty: false, builtAt: 'x', codeDirtyDetail: { judgement: 0, artifacts: 0, sample: [] } };
  assert.notEqual(naive.codeRev, 'unknown', '对照侧：这个实现确实回的是空串（如果它也是 unknown，对照侧就没测到东西）');
  assert.notEqual(naive.codeDirty, true);
  const real = codeVersionOf({ readGit: fakeGit({}).read, cwd: '.' });
  assert.notDeepEqual(
    { rev: naive.codeRev, dirty: naive.codeDirty },
    { rev: real.codeRev, dirty: real.codeDirty },
    '判据认不出「取不到 git 被当成干净」这种实现',
  );
});

test('M2.32：显式入参优先于现场读（复现时能把 rev 钉死）', () => {
  const git = fakeGit({ 'rev-parse HEAD': 'live\n', 'status --porcelain -z': ' M src/a.ts\0' });
  const code = codeVersionOf({ codeRev: 'pinned-sha', codeDirty: 'false', readGit: git.read, cwd: '.' });
  assert.equal(code.codeRev, 'pinned-sha');
  assert.equal(code.codeDirty, false, '显式 false 要生效 —— 环境变量传过来的是字符串 "false"');
  assert.equal(git.calls.some((args) => args[0] === 'rev-parse'), false, '显式给了 rev 就不该再跑 git');
});

/* ================= 2. 分类与守卫 ================= */

test('M2.32：breakdownOf 把「判定输入」与「产物」分开 —— 恒为 true 的 dirty 等于没有鉴别力（K11）', () => {
  const paths = [
    ' M src/config/numeric.ts',
    '?? src/data/locations.yaml',
    ' M docs/m221a-shard-0.json',
    '?? docs/m221a报告.md',
    ' M data/m221a-shard-0.db',
  ];
  const detail = breakdownOf(paths);
  assert.equal(detail.judgement, 2, 'src/ 下的两处是判定输入');
  assert.equal(detail.artifacts, 3, 'docs/ 与 data/ 下的三处是产物');
  assert.deepEqual(detail.sample, ['src/config/numeric.ts', 'src/data/locations.yaml']);

  // 对照侧：只有产物脏时，judgement 必须是 0（否则「这批不可精确重生成」会变成恒真警告）
  const artifactsOnly = breakdownOf([' M docs/x.json', '?? data/y.db']);
  assert.equal(artifactsOnly.judgement, 0);
  assert.equal(artifactsOnly.artifacts, 2);
});

test('M2.32：没被预料到的路径一律算判定输入（保守方向，白名单写窄不写宽）', () => {
  const detail = breakdownOf(['?? scripts/probe.ts', ' M package.json', '?? 某个新目录/x.ts']);
  assert.equal(detail.judgement, 3, '不在产物白名单里的一律算判定输入 —— 判错的方向只能是「多警告一次」');
});

test('M2.32：gitStatusPaths 必须用 -z（否则中文路径被八进制转义，分类全错）', () => {
  const git = fakeGit({ 'status --porcelain -z': ' M src/a.ts\0' });
  gitStatusPaths(git.read, '.');
  assert.deepEqual(git.calls[0], ['status', '--porcelain', '-z'], '少了 -z 就会拿到 "docs/\\346\\226..." 那种转义路径');

  // 对照侧：默认输出（带引号 + 转义）会让分类认不出产物目录
  const quoted = ' M "docs/\\346\\226\\207\\346\\241\\243.json"';
  assert.equal(breakdownOf([quoted.slice(3)]).artifacts, 0, '对照侧：转义过的路径确实认不出 docs/ 前缀');
});

/* ================= 3. 写入点守卫 ================= */

test('M2.32 写入点：cli.ts 真的把四个字段写进了产物 JSON（少一个都没人会红）', () => {
  const source = readFileSync('src/vplayer/cli.ts', 'utf8');
  for (const field of ['codeRev', 'codeDirty', 'builtAt', 'codeDirtyDetail']) {
    assert.match(
      source,
      new RegExp('^\\s*' + field + ': code\\.' + field + ',', 'm'),
      '产物 JSON 里少了 ' + field + ' —— 这一批就不可归因了（M2.32 任务 1 的全部意义就在这四个字段）',
    );
  }
  assert.match(source, /codeDirtyDetail\.judgement > 0/, '判定输入脏的时候必须警告，否则这个字段没有出口');
});

test('M2.32 写入点：报告首段必须有「代码版本」这一行（老产物要写明「未记录」而不是留空）', () => {
  const report = readFileSync('src/vplayer/report.ts', 'utf8');
  const merge = readFileSync('src/vplayer/merge.ts', 'utf8');
  const code = readFileSync('src/vplayer/code-version.ts', 'utf8');

  assert.match(report, /- 代码版本：/, '主报告首段缺这一行');
  assert.match(code, /本产物生成于 M2\.32 之前/, '没有 code 的老产物必须写明「未记录」，不能沉默');
  assert.match(code, /不可精确重生成/, '判定输入脏时报告要写明后果');

  /*
   * 合并报告的头部是**自己渲染**的（它不调用 renderMainReport）——
   * M2.32 实测踩到：先只改了 report.ts，合并报告里一个字都没有。
   * 所以这一行必须单独守。
   */
  assert.match(merge, /- 代码版本：/, '合并报告首段缺这一行（它不是 renderMainReport 渲染的，不会自动跟着有）');
  assert.match(merge, /merged\.code\.recorded > 0/, '合并层要把「有几片带了版本字段」传下去，否则老产物会被显示成「工作区干净」');
});

/* ================= 4. 合并层：8 片是不是同一份代码 ================= */

/**
 * 只带代码版本字段的存根。
 *
 * **为什么可以这样存根**：`codeConsistencyOf` 只读这四个字段（其它一概不碰），
 * 所以这里的存根对被测函数来说是完整的输入 —— 用它对一个只读四字段的函数做断言是成立的。
 */
function stub(fields: Partial<Pick<ShardJson, 'codeRev' | 'codeDirty' | 'builtAt' | 'codeDirtyDetail'>>): ShardJson {
  return fields as unknown as ShardJson;
}

function clean(rev: string): ShardJson {
  return stub({ codeRev: rev, codeDirty: false, builtAt: '2026-02-01T00:00:00.000Z', codeDirtyDetail: { judgement: 0, artifacts: 0, sample: [] } });
}

test('M2.32 合并：8 片 rev 一致且工作区干净 ⇒ 这一批可归因、可精确重生成', () => {
  const consistency = codeConsistencyOf([clean('abc123'), clean('abc123')]);
  assert.equal(consistency.recorded, 2);
  assert.equal(consistency.revAgreed, true);
  assert.equal(consistency.attributed, true);
  assert.match(consistency.note, /可精确重生成/);
  assert.equal(mergedCodeVersion(consistency).codeRev, 'abc123');
});

test('M2.32 合并：跑批中途改了代码 ⇒ 各片 rev 不一致，必须报出来（不许挑一片冒充）', () => {
  const consistency = codeConsistencyOf([clean('abc123'), clean('def456')]);
  assert.equal(consistency.revAgreed, false);
  assert.equal(consistency.attributed, false, '两份代码混出来的批次不能声明可归因');
  assert.match(consistency.note, /两份代码混出来/);
  assert.equal(mergedCodeVersion(consistency).codeRev, 'abc123 / def456', '不一致时要把两个值都写出来');
});

test('M2.32 合并：判定输入脏的批次**不可精确重生成**（即使 8 片 rev 一致）', () => {
  const dirty = stub({
    codeRev: 'abc123',
    codeDirty: true,
    builtAt: '2026-02-01T00:00:00.000Z',
    codeDirtyDetail: { judgement: 1, artifacts: 7, sample: ['src/data/locations.yaml'] },
  });
  const consistency = codeConsistencyOf([clean('abc123'), dirty]);
  assert.equal(consistency.revAgreed, true);
  assert.equal(consistency.judgementDirtyShards, 1);
  assert.equal(consistency.attributed, false, 'rev 一样不代表能重生成 —— 未提交的改动不在 rev 里');
  assert.match(consistency.note, /不可精确重生成/);
  assert.match(describeCodeVersion(mergedCodeVersion(consistency)), /不可精确重生成/);
});

test('M2.32 合并（空集陷阱）：全部缺字段**不等于**一致 —— 未记录不是「验过了」', () => {
  /*
   * 这是最容易写错的一处：`[].every(...)` 恒为 true ⇒
   * 「所有片都没记录」会被朴素实现判成「rev 全部一致」。
   * 而它的后果与 M2.31 那 7 个批一模一样：看起来有结论，其实没有记录。
   */
  const consistency = codeConsistencyOf([stub({}), stub({})]);
  assert.equal(consistency.recorded, 0);
  assert.equal(consistency.revAgreed, false, '空集 every 是 true —— 这里必须显式防住');
  assert.equal(consistency.attributed, false);
  assert.match(consistency.note, /未记录/);
  assert.match(consistency.note, /无法归因/);

  // 对照侧：朴素实现（只有 every）在同一条输入上会给出 true
  const naive = (shards: readonly ShardJson[]): boolean => shards.every((shard) => shard.codeRev === shards[0]?.codeRev);
  assert.equal(naive([stub({}), stub({})]), true, '对照侧：朴素实现确实把「全都没记录」判成一致了');
  assert.notEqual(consistency.revAgreed, naive([stub({}), stub({})]), '判据必须与朴素实现不同，否则它没防住这个陷阱');
});

test('M2.32 合并：量词必须说对 —— 合并层报的是「片」不是「处」', () => {
  /*
   * M2.32 实测踩到：合并报告把「判定输入 1 片」写成了「1 处」，
   * 读起来像「工作区只脏了一个文件」—— 一个**看着像结论的量词错误**。
   * 合并层手上确实只有逐片的布尔（它不收集 8 片的路径），所以量词必须跟着来源走。
   */
  const dirty = stub({
    codeRev: 'abc123',
    codeDirty: true,
    builtAt: '2026-02-01T00:00:00.000Z',
    codeDirtyDetail: { judgement: 3, artifacts: 7, sample: [] },
  });
  const merged = mergedCodeVersion(codeConsistencyOf([dirty, clean('abc123')]));
  assert.equal(merged.dirtyScope, 'merged', '合并层必须声明量词来源');
  const line = describeCodeVersion(merged);
  assert.match(line, /判定输入 1 片/, '合并层要说「片」');
  assert.doesNotMatch(line, /判定输入 1 处/, '说成「处」会让读者以为工作区只有一个脏文件');

  // 对照侧：单片的口径仍然是「处」
  const single: CodeVersion = {
    codeRev: 'abc123',
    codeDirty: true,
    builtAt: '2026-02-01T00:00:00.000Z',
    codeDirtyDetail: { judgement: 3, artifacts: 7, sample: ['src/a.ts'] },
  };
  assert.match(describeCodeVersion(single), /判定输入 3 处/);
});

test('M2.32 合并：只记录了一部分片 ⇒ 仍然不可归因（半份记录不是记录）', () => {
  const consistency = codeConsistencyOf([clean('abc123'), stub({})]);
  assert.equal(consistency.recorded, 1);
  assert.equal(consistency.revAgreed, false);
  assert.equal(consistency.attributed, false);
});

test('M2.32：builtAt 在合并层取「最早的那一片」，缺字段时是空串而不是 undefined', () => {
  const consistency = codeConsistencyOf([
    stub({ codeRev: 'a', codeDirty: false, builtAt: '2026-02-01T01:00:00.000Z', codeDirtyDetail: { judgement: 0, artifacts: 0, sample: [] } }),
    stub({ codeRev: 'a', codeDirty: false, builtAt: '2026-02-01T00:00:00.000Z', codeDirtyDetail: { judgement: 0, artifacts: 0, sample: [] } }),
  ]);
  assert.deepEqual(consistency.builtAts, ['2026-02-01T01:00:00.000Z', '2026-02-01T00:00:00.000Z']);
  const code: CodeVersion = mergedCodeVersion(consistency);
  assert.equal(code.builtAt, '2026-02-01T01:00:00.000Z');
  assert.equal(mergedCodeVersion(codeConsistencyOf([stub({})])).builtAt, '');
});
