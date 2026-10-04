/**
 * M2.1 可见性取证的单测（服务端库读取 + 日志全窗口统计）。
 * 这两条是「8 张卡为什么没触发」的取证链，必须自己也被守住。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fullDayExposure, lostDayActionMix, lostDaysOf } from '../src/sim/visibility-evidence.ts';
import { createHarness } from './helpers/app.ts';

function writeLog(lines: object[]): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'm21-evidence-'));
  const file = join(dir, 'log.jsonl');
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join(String.fromCharCode(10)), 'utf8');
  return { dir, file };
}

function record(playerId: number, persona: string, day: number, command: string, reason = '') {
  return { playerId, persona, day, command, reason, replyTexts: [] };
}

test('M2.1 取证：lost_control_events → 「玩家#天」集合（按东八区切天）', async () => {
  const h = createHarness();
  const character = await h.createCharacter('700003', '激进者3');
  h.app.db
    .prepare(
      'INSERT INTO lost_control_events (character_id, date, pathway, text, hp_loss, mad_gain, source, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(character.id, '2026-01-04', 'seer', '失控文本', 12, 5, 'tick', h.now());

  const days = lostDaysOf(h.app.db);
  // user_id 700003 → playerId 3；2026-01-04 距基准日 2026-01-01 是第 3 天
  assert.deepEqual([...days], ['3#3']);
  h.app.close();
});

test('M2.1 取证：全窗口口径只统计失控当天的扮演，不是全部玩家日', async () => {
  const { dir, file } = writeLog([
    // player 0：第 2 天失控，当天 3 次扮演、1 次事件（方案 A 口径下都算抽卡机会）
    record(0, 'aggressive', 2, '.净化', '失控中：优先净化'),
    record(0, 'aggressive', 2, '.扮演 我占卜'),
    record(0, 'aggressive', 2, '.扮演 我预兆'),
    record(0, 'aggressive', 2, '.事件'),
    record(0, 'aggressive', 2, '.扮演 我低语'),
    // 同一个人第 3 天没失控：不该被算进去
    record(0, 'aggressive', 3, '.扮演 我占卜'),
    // player 1：第 2 天没失控
    record(1, 'steady', 2, '.扮演 我祈祷'),
  ]);
  try {
    const exposure = await fullDayExposure(file);
    assert.equal(exposure.length, 1, '只有 aggressive 有失控日');
    const row = exposure[0]!;
    assert.equal(row.persona, 'aggressive');
    assert.equal(row.lostDays, 1);
    assert.equal(row.plays, 3, '只数失控那天的 3 次扮演');
    assert.equal(row.events, 1);
    assert.equal(row.playsPerLostDay, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M2.1 取证：没有任何失控日 → 空表（而不是把普通日算进去）', async () => {
  const { dir, file } = writeLog([
    record(0, 'steady', 0, '.扮演 我祈祷'),
    record(1, 'chaotic', 1, '.探索 迷雾街区'),
  ]);
  try {
    assert.deepEqual(await fullDayExposure(file), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('M2.1 取证：失控日的动作构成（方案 E 的依据 —— 失控日在交易/探索，不在扮演）', async () => {
  const { dir, file } = writeLog([
    // 失控日：3 次探索、2 次交易、0 次扮演
    record(0, 'aggressive', 4, '.净化', '失控中：优先净化'),
    record(0, 'aggressive', 4, '.探索 迷雾街区'),
    record(0, 'aggressive', 4, '.探索 老码头'),
    record(0, 'aggressive', 4, '.探索 老码头'),
    record(0, 'aggressive', 4, '.交易 @700001 主材料·灰雾结晶 1 5'),
    record(0, 'aggressive', 4, '.交易 @700002 主材料·灰雾结晶 1 5'),
    // 普通日：2 次扮演、1 次探索
    record(0, 'aggressive', 5, '.扮演 我占卜'),
    record(0, 'aggressive', 5, '.扮演 我预兆'),
    record(0, 'aggressive', 5, '.探索 迷雾街区'),
  ]);
  try {
    const mix = await lostDayActionMix(file);
    assert.equal(mix.lostDays, 1);
    assert.equal(mix.normalDays, 1);
    const row = (command: string) => mix.rows.find((entry) => entry.command === command)!;
    assert.equal(row('探索').lostPerDay, 3);
    assert.equal(row('探索').normalPerDay, 1);
    assert.equal(row('探索').ratio, 3);
    assert.equal(row('扮演').lostPerDay, 0, '失控日没扮演 —— 这正是 lost_* 抽不到的原因');
    assert.equal(row('扮演').ratio, 0);
    assert.equal(row('交易').lostPerDay, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

