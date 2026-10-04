/**
 * M2.76b：会话配额账本。
 *
 * 它把 M2.75 的「配额看得见」变成「配额管得住」：identify 是唯一消耗
 * session_start_limit 的动作，重连风暴烧光当天额度之后，
 * 现象与「凭证错」一模一样 —— 所以宁可提前停，也不要乱试。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionQuota } from '../src/adapter/qq-official/quota.ts';

test('配额账本：没查过就不拦（拦的依据必须是「确知没额度」，不能是「不知道」）', () => {
  const quota = new SessionQuota();
  assert.equal(quota.remaining, null);
  assert.equal(quota.canStartSession().ok, true);
  assert.match(quota.describe(), /未知/);
});

test('配额账本：乐观扣减 —— 两次体检之间平台的余量只能自己记', () => {
  const quota = new SessionQuota({ warnBelow: 10 });
  quota.update({ total: 1500, remaining: 100, resetAfterMs: 3_600_000 });
  assert.equal(quota.remaining, 100);

  quota.noteIdentify();
  quota.noteIdentify();
  assert.equal(quota.remaining, 98, '发起的 identify 要立刻扣掉，不能等下一次体检');

  // 体检回来会以平台为准，并把乐观扣减的历史清掉
  quota.update({ total: 1500, remaining: 97, resetAfterMs: 3_600_000 });
  assert.equal(quota.remaining, 97, '体检的数才是权威');
});

test('配额账本：余量为 0 时拒绝建会话，并说清「等重置或重启」', () => {
  let now = 1_000_000;
  const quota = new SessionQuota({ now: () => now, warnBelow: 10 });
  quota.update({ total: 1500, remaining: 1, resetAfterMs: 7_200_000 });
  assert.equal(quota.canStartSession().ok, true);

  quota.noteIdentify();
  const decision = quota.canStartSession();
  assert.equal(decision.ok, false, '扣到 0 之后必须拦住');
  assert.match(decision.reason ?? '', /配额已经用尽/);
  assert.match(decision.reason ?? '', /1500/, '要说清总量，不然运维不知道是 100 还是 1500');
  assert.equal(quota.blocked, 1, '拦下要记一笔（面板与日志靠它）');

  // 时钟往前走，重置倒计时跟着减
  now += 1_200_000;
  assert.equal(quota.resetInMs, 6_000_000);
  assert.match(quota.describe(), /还剩 0\/1500/);
  assert.match(quota.describe(), /100 分钟后重置/);
});

test('配额账本：余量偏低会给 low（体检与面板据此变色），但不拦', () => {
  const quota = new SessionQuota({ warnBelow: 100 });
  quota.update({ total: 1500, remaining: 100, resetAfterMs: 3_600_000 });
  assert.equal(quota.low, true, '等于阈值就算偏低');
  assert.equal(quota.canStartSession().ok, true, '偏低不等于不能连');

  quota.update({ total: 1500, remaining: 101, resetAfterMs: 3_600_000 });
  assert.equal(quota.low, false);
});
