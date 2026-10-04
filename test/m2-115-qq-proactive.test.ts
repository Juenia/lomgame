/**
 * **主动消息**（M2.115）—— 用户纠正的那一条：
 *
 * > 「主动推送已经下放了　不需要额外申请权限，你再好好查查 QQ 机器人官方文档」
 *
 * 查了官方《消息收发概述》原文：
 *
 * ```
 * 主动消息 | 无任何条件 | 机器人主动触达用户，
 *         用户可在客户端关闭「允许主动发送」开关，关闭后主动消息将发送失败
 *
 * 群聊主动消息频控（HTTP）：Bot 维度 60/qpm、单关系维度 20/qpm、每群每天 1000 条
 * ```
 *
 * ⇒ **不需要申请**。而本项目原来在 `#consumeTicket` 里「没有凭证就抛 NoReplyTicketError」，
 * 于是世界播报、天气推送这类**主动消息**从来没通过过 —— 而日志里那句
 * 「主动推送需要单独申请权限，本项目未申请」是一句**过时的话**。
 *
 * ⇒ 「只有一个群收到」的官方答案：**接收方在客户端关掉了「允许主动发送」**（那是设置，不是权限）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

test('M2.115 没有凭证时不再抛错，而是退化成主动消息', () => {
  const src = readFileSync(new URL('../src/adapter/qq-official/index.ts', import.meta.url), 'utf8');
  /*
   * 反面：那一行 `throw new NoReplyTicketError(...)` 在 #consumeTicket 里不该再有。
   * 类本身留着（`app.ts` 拿它区分日志），但**不再从这条路上抛**。
   */
  const consume = src.slice(src.indexOf('#consumeTicket('));
  const body = consume.slice(0, consume.indexOf('\n  }'));
  assert.ok(!/throw new NoReplyTicketError/.test(body), '#consumeTicket 里不该再抛 NoReplyTicketError');
  assert.match(body, /return null;/, '没有凭证要返回 null（= 主动消息）');
  assert.match(src, /\| null \{/, '#consumeTicket 的返回类型要含 null');
});

test('M2.115 主动消息不带任何凭证字段（msg_id / event_id 都没有）', () => {
  const src = readFileSync(new URL('../src/adapter/qq-official/index.ts', import.meta.url), 'utf8');
  assert.match(src, /ticket === null\s*\? \{\} \/\/ 主动消息：不带任何凭证字段/, 'ticket 为 null 时凭证字段为空');
  assert.match(src, /ticket !== null \? \{ msg_seq: ticket\.seq \} : \{\}/, 'msg_seq 也要跟着凭证走');
  assert.match(src, /ticket\?\.userId/, '头像要从凭证里取 —— 没有凭证就没有头像');
});

test('M2.115 注释里那句「本项目未申请」已经改掉（它是错的）', () => {
  const src = readFileSync(new URL('../src/adapter/qq-official/index.ts', import.meta.url), 'utf8');
  assert.ok(!src.includes('主动推送需要单独申请权限，本项目未申请'), '过时的话不该还在');
  assert.match(src, /主动消息 \| \*\*无任何条件\*\*|无任何条件/, '要把官方原文记下来');
});
