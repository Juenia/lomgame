/**
 * **主动推送的串行与重试**（M2.113）。
 *
 * 用户报的现场：「主动推送依旧只有一个群成功」—— 日志里三个群**同时**
 * `ECONNREFUSED`（cause: connect）。M2.87 查出的根子是这台机器的路由器 DNS
 * 会间歇性掐连接，而 happy-eyeballs 走 `dns.resolve*` ⇒ 报成连接被拒。
 *
 * 三个群同一瞬间出网，正好一起撞上那把不稳的闸 ⇒ 三个全失败、600ms 后那一次重试也全失败。
 *
 * 两条改动：
 *   ① **串行**（`broadcastQueue` 链式排队 + 群间 400ms）
 *   ② **三次退避**（600ms / 2s / 6s；原来只有一次 600ms）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

test('M2.113 广播是串行的（不是一把全发出去）', () => {
  const src = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
  assert.match(src, /let broadcastQueue: Promise<void> = Promise\.resolve\(\)/, '要有串行队列');
  // 队列链：sendGroupText 内部把这一次接到上一次后面
  assert.match(
    src,
    /broadcastQueue = broadcastQueue\.then\(async \(\) => \{/
    ,
    '每一次发送要接在上一次之后',
  );
  assert.match(src, /const BROADCAST_GAP_MS = \d+;/, '群之间要有间隔');
  /*
   * 反面：不能再出现「循环里直接 void sendGroup」。
   * 那是 fire-and-forget —— 所有群同一瞬间出网，正是这次报的现场。
   */
  const evil = /for \(const groupId of groups\)[\s\S]{0,200}?void deps\.adapter\.sendGroup/;
  assert.ok(!evil.test(src), '循环里不该直接出网（那是不串行）');
});

test('M2.113 重试是三次退避（600ms / 2s / 6s）', () => {
  const src = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
  assert.match(src, /RETRY_DELAYS_MS = \[600, 2000, 6000\]/, '退避表要写死这三个数');
  assert.match(src, /attempt >= RETRY_DELAYS_MS\.length/, '用光三次就停');
  // 递归重试：每次失败都再试下一次
  assert.match(src, /await retrySend\(groupId, text, buttons, attempt \+ 1\)/, '失败要继续下一档');
});
