/**
 * 内核运行根：**发布形态下别在插件包里跑**。
 *
 * 现场（用户反馈两次）：「插件运行时更新不了，得先去控制台把插件停掉」——
 * 内核占着 node_modules 里的包目录，npm 替换不掉。根治的办法是把内核铺到数据目录。
 *
 * 判据四条：复制过去、按版本号命名、同版本不重复铺、铺不动要能退回。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareCoreRunRoot } from '../integrations/koishi/src/core-root.ts';

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** 造一个假包：<dir>/package.json + <dir>/core/dist/bridge-api/src/main.js，返回 core 目录 */
function fakePackage(dir: string, version: string): string {
  const core = join(dir, 'core');
  mkdirSync(join(core, 'dist', 'bridge-api', 'src'), { recursive: true });
  writeFileSync(join(core, 'dist', 'bridge-api', 'src', 'main.js'), '// kernel', 'utf8');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'koishi-plugin-lom-bridge', version }), 'utf8');
  return core;
}

test('发布形态：内核被铺到数据目录，目录名带版本号', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lom-runroot-'));
  try {
    const core = fakePackage(tmp, '9.9.9');
    const dataDir = join(tmp, 'data');
    const runRoot = prepareCoreRunRoot(core, dataDir, quiet);
    assert.notEqual(runRoot, core, '不能还在插件包里跑');
    assert.equal(runRoot, join(dataDir, 'core-9.9.9'));
    assert.ok(existsSync(join(runRoot, 'dist', 'bridge-api', 'src', 'main.js')), '内核文件要跟着过去');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('同版本不重复铺：源目录没了也照样用（说明第二次没重铺）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lom-runroot-'));
  try {
    const core = fakePackage(tmp, '1.2.3');
    const dataDir = join(tmp, 'data');
    const first = prepareCoreRunRoot(core, dataDir, quiet);
    rmSync(core, { recursive: true, force: true });
    const second = prepareCoreRunRoot(core, dataDir, quiet);
    assert.equal(second, first, '第二次要复用同一份，不该重新复制');
    assert.ok(existsSync(join(second, 'dist', 'bridge-api', 'src', 'main.js')));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('开发形态：没有包级 package.json 就原样返回（在仓库里跑不复制）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lom-runroot-'));
  try {
    const core = join(tmp, 'core');
    mkdirSync(join(core, 'bridge-api', 'src'), { recursive: true });
    writeFileSync(join(core, 'bridge-api', 'src', 'main.ts'), '// dev', 'utf8');
    const dataDir = join(tmp, 'data');
    assert.equal(prepareCoreRunRoot(core, dataDir, quiet), core);
    assert.ok(!existsSync(join(dataDir, 'core-unknown')), '开发形态不该铺到数据目录');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('铺不动就退回插件包 —— 宁可留着老毛病，也不能让游戏起不来', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lom-runroot-'));
  try {
    const core = fakePackage(tmp, '1.0.0');
    const notADir = join(tmp, 'not-a-dir');
    writeFileSync(notADir, 'x', 'utf8');
    assert.equal(prepareCoreRunRoot(core, notADir, quiet), core);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});