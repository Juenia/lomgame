/**
 * M2.82：服务与访问（后台改口令 / 监听地址 / 公网暴露）。
 *
 * 这一屏把后台从「只有本机能进」推向局域网 / 公网，所以它必须同时交付三件配套：
 * 口令强度下限、登录失败限流、审计日志记真实 IP。
 *
 * 这三样都有同一个特点：**没做的时候什么都看不出来** ——
 * 后台照常能用、日志照常写，直到有人在公网上试了一万次口令。
 * 所以每一条都单独钉住。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ACCESS_KEYS, checkPasswordStrength, clientIp, createLoginGuard, isLoopbackOnly,
  PASSWORD_MIN, readAccess, writeAccessKey,
} from '../src/admin/access.ts';

const now = 1_700_000_000_000;

function scratchEnv(text: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'm282-'));
  const path = join(dir, '.env');
  writeFileSync(path, text, 'utf8');
  return { dir, path };
}
import { writeFileSync } from 'node:fs';

test('M2.86 服务与访问：口令**只挡空与超长**（用户：「几位数都行」）', () => {
  /*
   * ⚠️ 这条断言在本轮**反了过来**。
   *
   * 原来测的是「短 / 纯数字 / 重复字符 / 常见弱词，四类都要拦住」。
   * 用户拍板放宽（原话：「密码要求别那么复杂，几位数都行」）之后，
   * 那四类**全部应该通过** —— 判据不跟着改的话，它会一直绿着，
   * **而绿的是已经不存在的行为**。
   *
   * 放宽的依据写在 `checkPasswordStrength` 的注释里：那套规则挡的是公网爆破，
   * 而后台默认只监听本机/内网，真正防爆破的是 loginGuard（连续失败就锁）。
   * 长度门槛的代价则是「自己想设的口令设不上」。
   */
  assert.equal(checkPasswordStrength('a'), null, '一位也该放行');
  assert.equal(checkPasswordStrength('12'), null, '纯数字也该放行');
  assert.equal(checkPasswordStrength('aaaaaaaa'), null, '重复字符也该放行');
  assert.equal(checkPasswordStrength('password'), null, '常见词也该放行');
  assert.equal(checkPasswordStrength('tingen-3:17-灰雾'), null, '正常口令当然放行');
  // 只剩两条硬约束：不能空、不能超长
  assert.match(checkPasswordStrength('') ?? '', /不能是空的/);
  assert.match(checkPasswordStrength('x'.repeat(129)) ?? '', /太长了/);
});

test('M2.82 服务与访问：登录限流是指数退避，不是锁死', () => {
  /*
   * 为什么不锁死：锁死会让**别人**能故意把你关在门外 ——
   * 公网上打三次错口令就行，一个防爆破的措施变成了拒绝服务。
   */
  const g = createLoginGuard();
  const ip = '203.0.113.9';
  // 前 5 次随便错，不挡（手滑是常态）
  for (let i = 1; i <= 5; i += 1) {
    assert.equal(g.check(ip, now).ok, true, '第 ' + i + ' 次不该被挡');
    g.fail(ip, now);
  }
  // 第 6 次开始挡，而且要等
  g.fail(ip, now);
  const gate = g.check(ip, now);
  assert.equal(gate.ok, false, '连错 6 次还不挡？');
  assert.ok(gate.ok === false && gate.retryAfterMs >= 1000);
  // 等过去之后又能试 —— 这正是「退避」与「锁死」的区别
  assert.equal(g.check(ip, now + 60_000).ok, true, '等够了还不放行，那就是锁死了');
  // 另一个 IP 不受影响：一个人手滑不该连累同事
  assert.equal(g.check('198.51.100.7', now).ok, true);
});

test('M2.82 服务与访问：限流的上限封顶，等待不会长到「这辈子别想进」', () => {
  const g = createLoginGuard();
  for (let i = 0; i < 40; i += 1) g.fail('10.0.0.1', now);
  const gate = g.check('10.0.0.1', now);
  assert.ok(gate.ok === false);
  assert.ok(gate.retryAfterMs <= 15 * 60 * 1000 + 1, '等待时间没有封顶：' + gate.retryAfterMs);
});

test('M2.82 服务与访问：登录成功会清掉这个 IP 的失败记录', () => {
  const g = createLoginGuard();
  for (let i = 0; i < 8; i += 1) g.fail('10.0.0.2', now);
  assert.equal(g.check('10.0.0.2', now).ok, false);
  g.ok('10.0.0.2');
  assert.equal(g.check('10.0.0.2', now).ok, true, '登录成功了还记着旧账');
});

test('M2.82 服务与访问：X-Forwarded-For 默认不信（它谁都能伪造）', () => {
  const req = { headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }, socket: { remoteAddress: '::ffff:192.168.1.5' } };
  // 默认：用 socket 上的地址，并且把 IPv4 映射地址还原成人看得懂的样子
  assert.equal(clientIp(req, false), '192.168.1.5');
  // 显式信任反代时才读那个头，且取最左边那个（最初的客户端）
  assert.equal(clientIp(req, true), '1.2.3.4');
  // 没有 socket（极端情况）也不能返回空串 —— 限流要拿它当键
  assert.equal(clientIp({ headers: {} }, false), 'unknown');
});

test('M2.82 服务与访问：绑回环时不报「局域网 / 公网可达」', () => {
  /*
   * 这一条是整屏最要紧的信息 —— 运营以为自己在公网上（或者以为很安全），
   * 而事实正好相反。两个方向都要钉住。
   */
  const base = { envPath: '/nonexistent/.env', lanIps: ['192.168.1.5'], guard: createLoginGuard(), now };
  const loop = readAccess({ ...base, running: { HOST: '127.0.0.1', PORT: '3100' } });
  assert.deepEqual(loop.reach.map((r) => r.scope), ['本机'], '绑回环却报出了别的入口');
  assert.deepEqual(loop.warnings, [], '绑回环不该有暴露警告');

  const open = readAccess({ ...base, running: { HOST: '0.0.0.0', PORT: '3100' } });
  assert.deepEqual(open.reach.map((r) => r.scope), ['本机', '局域网', '公网']);
  assert.ok(open.warnings.length >= 3, '绑到所有网卡却几乎没提醒：' + JSON.stringify(open.warnings));
  assert.ok(open.warnings.some((w) => w.includes('不加密')), '没提「口令在网络上不加密」');
  assert.ok(isLoopbackOnly('localhost') && isLoopbackOnly('::1') && !isLoopbackOnly('0.0.0.0'));
});

test('M2.82 服务与访问：改配置写进 .env，非法值当场拦住', () => {
  const { dir, path } = scratchEnv('ADMIN_PASSWORD=\nPORT=3100\n');
  try {
    // 注释与顺序要保住（envSet 是行级替换）
    writeFileSync(path, '# 这是注释\nADMIN_PASSWORD=\nPORT=3100\n', 'utf8');
    const r = writeAccessKey(path, 'PORT', '3200');
    assert.equal(r.apply, 'restart', '端口是重启才生效的，不能报成立刻');
    assert.match(r.message, /重启/);
    const after = readFileSync(path, 'utf8');
    assert.ok(after.includes('# 这是注释'), '注释被冲掉了');
    assert.ok(after.includes('PORT=3200'));

    // 非法值：端口越界、公网地址缺协议、空口令 —— 三条都要拦
    assert.throws(() => writeAccessKey(path, 'PORT', '99999'), /1—65535/);
    assert.throws(() => writeAccessKey(path, 'CARD_PUBLIC_BASE_URL', 'example.com'), /http/);
    /*
     * ⚠️ 这里原来传的是 `'123'`（等价于「弱口令」）。
     * M2.86 放宽长度规则后 `'123'` 是**合法**的（用户：「几位数都行」），
     * 于是 `throws` 落空 —— 但**要拦的东西没变**：口令仍然不能是空的。
     * 用空串做非法值，判据才继续指向那个真实存在的约束。
     */
    assert.throws(() => writeAccessKey(path, 'ADMIN_PASSWORD', ''), /不能是空的/);
    assert.equal(writeAccessKey(path, 'ADMIN_PASSWORD', '123').apply, 'now', '短口令现在应当被接受');
    // 不认识的键不能悄悄写进文件
    assert.throws(() => writeAccessKey(path, 'SOMETHING_ELSE', 'x'), /没有这一项配置/);
    assert.ok(!readFileSync(path, 'utf8').includes('SOMETHING_ELSE'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('M2.82 服务与访问：改口令报的是「立刻」，改监听地址报的是「要重启」', () => {
  /*
   * 把「必须重启」说成「已保存」是这一屏最容易犯的错：运营看见绿字以为生效了，
   * 然后对着一个没变的行为查半天。
   */
  const pw = ACCESS_KEYS.find((k) => k.key === 'ADMIN_PASSWORD')!;
  const host = ACCESS_KEYS.find((k) => k.key === 'HOST')!;
  assert.equal(pw.apply, 'now');
  assert.equal(host.apply, 'restart');
  assert.equal(pw.secret, true, '口令必须标成密钥 —— 不然会原样回显到页面上');
  assert.equal(host.secret, false);
});

test('M2.82 服务与访问：磁盘与进程不一致要看得出（密钥按打码比原值）', () => {
  const { dir, path } = scratchEnv('ADMIN_PASSWORD=disk-one-2long\nHOST=0.0.0.0\n');
  try {
    const st = readAccess({
      envPath: path,
      running: { ADMIN_PASSWORD: 'run-one-different', HOST: '0.0.0.0', PORT: '3100' },
      lanIps: [], guard: createLoginGuard(), now,
    });
    const pw = st.fields.find((f) => f.key === 'ADMIN_PASSWORD')!;
    assert.equal(pw.same, false, '两个不同的口令被判成一样了');
    assert.ok(!pw.disk.includes('disk-one-2long'), '密钥原样回显了：' + pw.disk);
    const host = st.fields.find((f) => f.key === 'HOST')!;
    assert.equal(host.same, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ================================================================== *
 * HTTP 层：这一屏能改的是密钥，鉴权必须比数据编辑更严
 * ================================================================== */

test('M2.82 服务与访问：HTTP 层 —— 没登录看不到，没当前口令改不了', async () => {
  /*
   * 这一屏的响应体里带**配置项的名字和状态**（包括「口令设没设」），
   * 写接口能把后台从「只有本机能进」变成「谁都能试」。
   * 所以两件事都要钉住：未登录读不到、改任何一项都要再输一次口令。
   */
  const { handleAdmin, setAdminPassword } = await import('../src/admin/index.ts');
  const { openDatabase } = await import('../src/infra/db/sqlite.ts');
  const PW = 'tingen-3:17-灰雾';
  setAdminPassword(PW);

  const mkRes = () => {
    const o = { code: 0, body: '', cookie: '' } as { code: number; body: string; cookie: string };
    const anyO = o as unknown as Record<string, unknown>;
    anyO['writeHead'] = (c: number, h?: Record<string, string>) => {
      o.code = c;
      if (h !== undefined && h['set-cookie'] !== undefined) o.cookie = h['set-cookie'].split(';')[0] ?? '';
    };
    anyO['end'] = (b: string) => { o.body = b; };
    return o;
  };
  const mkReq = (method: string, url: string, body?: string, cookie?: string) => {
    const handlers: Record<string, (c?: Buffer) => void> = {};
    return {
      method, url,
      headers: cookie === undefined ? {} : { cookie },
      socket: { remoteAddress: '::ffff:203.0.113.7' },
      on(ev: string, cb: (c?: Buffer) => void) {
        handlers[ev] = cb;
        if (ev === 'data' && body !== undefined) cb(Buffer.from(body));
        if (ev === 'end') setImmediate(cb);
        return this;
      },
    };
  };
  const ctx = {
    envPath: '/nonexistent/.env', log: () => undefined, startedAt: '',
    root: process.cwd(), db: openDatabase(':memory:'),
    access: { lanIps: ['192.168.1.5'], listening: { host: '0.0.0.0', port: 3100 } },
  };
  const call = async (m: string, u: string, b?: string, c?: string) => {
    const res = mkRes();
    await handleAdmin(mkReq(m, u, b, c) as never, res as never, u, ctx as never);
    return res;
  };

  // 未登录：读不到（配置里有密钥）
  const anon = await call('GET', '/admin/api/access');
  assert.equal(anon.code, 401, '未登录竟然读得到访问配置');
  assert.ok(!anon.body.includes('ADMIN_PASSWORD'), '未登录的响应里带了配置名');

  // 登录
  const bad = await call('POST', '/admin/api/login', JSON.stringify({ password: 'nope' }));
  assert.equal(bad.code, 401);
  const good = await call('POST', '/admin/api/login', JSON.stringify({ password: PW }));
  assert.equal(good.code, 200);
  assert.ok(good.cookie.length > 0, '登录成功却没发 cookie');

  const st = await call('GET', '/admin/api/access', undefined, good.cookie);
  assert.equal(st.code, 200);
  const d = JSON.parse(st.body) as {
    fields: Array<{ key: string; disk: string; running: string; apply: string }>;
    reach: Array<{ scope: string }>; warnings: string[];
  };
  assert.equal(d.fields.length, ACCESS_KEYS.length, '面板列出来的项和注册的键对不上');
  assert.deepEqual(d.reach.map((r) => r.scope), ['本机', '局域网', '公网']);
  assert.ok(!st.body.includes(PW), '明文口令被送回了页面');

  /*
   * 改配置：**少了当前口令一律 401** ——
   * 理由是会话 cookie 可能来自一台没锁屏的机器，而改口令会把真正的主人踢出去。
   */
  const noPw = await call('POST', '/admin/api/access',
    JSON.stringify({ key: 'HOST', value: '127.0.0.1' }), good.cookie);
  assert.equal(noPw.code, 401, '不带当前口令竟然能改配置');

  // 带了口令，但值不合法 → 400，而且话要说清
  // M2.86：非法值从「弱口令」换成「空口令」（长度规则已放宽，空仍然是硬约束）
  const badVal = await call('POST', '/admin/api/access',
    JSON.stringify({ key: 'ADMIN_PASSWORD', value: '', password: PW }), good.cookie);
  assert.equal(badVal.code, 400);
  assert.match((JSON.parse(badVal.body) as { error: string }).error, /不能是空的/);

  // 不认识的键：不能悄悄写进文件
  const unknown = await call('POST', '/admin/api/access',
    JSON.stringify({ key: 'NOPE', value: 'x', password: PW }), good.cookie);
  assert.equal(unknown.code, 400);
  assert.match((JSON.parse(unknown.body) as { error: string }).error, /没有这一项配置/);
});
