/**
 * M2.63：内容热重载（后台改完内容立刻生效）。
 *
 * 这一份守的是「数据编辑器保存之后要不要重启进程」这件事：
 *
 *   1. 新内容表（生态域 / 势力 / 历史 / 边界 / 外部势力）都进了数据编辑器；
 *   2. 保存成功后**调热重载**，回执说「已即时生效」；
 *   3. 重载失败时**回执说清楚没生效** —— 而不是假装成功；
 *   4. 没注入热重载时退回旧话术（重启后生效）—— 那是这个字段出现前的行为；
 *   5. 没有字段变化时**不调**重载（省掉一次无谓的索引重建）；
 *   6. 没登录时保存被挡住（热重载不该绕过鉴权）。
 *
 * 第 3 条是重点：它防的是「文件写了、内容校验其实没过，而人以为已经生效」——
 * 于是他会拿着一个跑着旧内容的世界去排查新内容的问题。
 *
 * 这几条走的是**真的 HTTP 那一段**（handleAdmin），包括登录 ——
 * 因为「保存后触发热重载」正接在那一段里。只测 writeEntity 的话，
 * 那行接线整段都不在覆盖面内。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ensureAdminPassword, handleAdmin } from '../src/admin/index.ts';
import { ENTITIES, entityById } from '../src/admin/schema.ts';
import { openDatabase } from '../src/infra/db/sqlite.ts';

const TEST_PASSWORD = 'test-pass-263';
const NL = String.fromCharCode(10);

/* ================================================================== *
 * 一、新增实体都进了数据编辑器
 * ================================================================== */

test('M2.63 编辑器：M2.58—M2.62 的五张内容表都能编辑', () => {
  const expect = [
    ['zones', 'src/data/zones.yaml', 'zones'],
    ['powers', 'src/data/powers.yaml', 'powers'],
    ['history', 'src/data/history.yaml', 'history'],
    ['boundaries', 'src/data/boundaries.yaml', 'boundaries'],
    ['foreign-powers', 'src/data/boundaries.yaml', 'foreign_powers'],
  ] as const;
  for (const [id, file, rootKey] of expect) {
    const spec = entityById(id);
    assert.ok(spec !== undefined, '数据编辑器里没有这个实体：' + id);
    assert.equal(spec.file, file, id + ' 的文件路径不对');
    assert.equal(spec.rootKey, rootKey, id + ' 的根键不对');
    assert.ok(spec.fields.length > 0, id + ' 一个字段都没有');
  }
});

test('M2.63 编辑器：每个新实体的可编辑字段都带中文标签与类型', () => {
  for (const id of ['zones', 'powers', 'history', 'boundaries', 'foreign-powers']) {
    const spec = entityById(id)!;
    for (const field of spec.fields) {
      assert.ok(field.key.length > 0, id + ' 有字段缺 key');
      assert.ok(field.label.length > 0, id + '.' + field.key + ' 缺中文标签');
      assert.ok(field.type.length > 0, id + '.' + field.key + ' 缺类型');
    }
    const idField = spec.fields.find((field) => field.key === spec.idKey);
    assert.ok(idField !== undefined, id + ' 的字段里没有主键 ' + spec.idKey);
    assert.equal(idField.readOnly, true, id + ' 的主键应当只读（改名会打断所有引用）');
  }
});

test('M2.63 编辑器：枚举字段都有中文映射（否则界面上一列英文）', () => {
  const enumFields: Array<[string, string]> = [
    ['powers', 'type'], ['powers', 'stance'],
    ['history', 'type'], ['boundaries', 'kind'],
  ];
  for (const [id, key] of enumFields) {
    const field = entityById(id)!.fields.find((f) => f.key === key);
    assert.ok(field !== undefined, id + ' 没有字段 ' + key);
    assert.equal(field.type, 'enum', id + '.' + key + ' 应当是枚举');
    assert.ok(field.enumMap !== undefined, id + '.' + key + ' 缺中文映射');
    assert.ok(Object.keys(field.enumMap).length > 0);
  }
});

test('M2.63 编辑器：引用字段都指向真实存在的实体', () => {
  const ids = new Set(ENTITIES.map((e) => e.id));
  for (const id of ['zones', 'powers', 'history', 'boundaries', 'foreign-powers']) {
    for (const field of entityById(id)!.fields) {
      if (field.type !== 'ref' || field.ref === undefined) continue;
      assert.ok(ids.has(field.ref), id + '.' + field.key + ' 指向不存在的实体 ' + field.ref);
    }
  }
});

/* ================================================================== *
 * 二、保存之后真的热重载（走真的 HTTP 那一段）
 * ================================================================== */

/**
 * 一个最小的 HTTP 请求壳：只为这一份测试服务。
 *
 * 它模拟 handleAdmin 真正用到的那几个成员：method / url / headers / on。
 * set-cookie 要被接下来（登录要靠它取 token）—— 那是唯一的额外动作。
 */
async function request(input: {
  ctx: unknown;
  method: 'GET' | 'POST';
  url: string;
  body?: string;
  cookie?: string;
}): Promise<{ parsed: Record<string, unknown> | null; status: number; msg: string; setCookie: string }> {
  const req = {
    method: input.method,
    url: input.url,
    headers: input.cookie === undefined ? {} : { cookie: input.cookie },
    on: (event: string, cb: (chunk?: unknown) => void) => {
      if (event === 'data' && input.body !== undefined) cb(Buffer.from(input.body));
      if (event === 'end') cb();
    },
  };
  let payload = '';
  let status = 0;
  let setCookie = '';
  const res = {
    writeHead: (code: number, headers?: Record<string, string>) => {
      status = code;
      if (headers !== undefined && typeof headers['set-cookie'] === 'string') {
        setCookie = headers['set-cookie'];
      }
    },
    end: (text: string) => { payload = text; },
  };
  await handleAdmin(req as never, res as never, input.url, input.ctx as never);
  const parsed = payload === '' ? null : (JSON.parse(payload) as Record<string, unknown>);
  /* 成功时文案在 message，失败时在 error —— 统一成一个 msg */
  return {
    parsed, status, setCookie,
    msg: String(parsed?.['message'] ?? parsed?.['error'] ?? ''),
  };
}

/**
 * 造一个能走完「登录 + 保存」那条路的后台上下文。
 *
 * 数据文件用**临时目录里的副本** —— 绝不能碰仓库里真的 zones.yaml。
 */
function makeCtx(options: {
  reload?: () => { ok: boolean; rebuilt: string[]; errors: string[]; warnings: string[] };
}) {
  const root = mkdtempSync(join(tmpdir(), 'm263-'));
  const spec = entityById('zones')!;
  mkdirSync(join(root, 'src', 'data'), { recursive: true });
  const filePath = join(root, spec.file);
  writeFileSync(
    filePath,
    'zones:' + NL + '  - id: z1' + NL + '    name: 测试域' + NL + '    locations: [loc_a]' + NL,
    'utf8',
  );
  /*
   * 口令：把 .env 写进临时目录，再让 ensureAdminPassword 读它。
   * 那条函数设的是模块级变量，所以每个用例都要重新设一遍（同一个值，幂等）。
   */
  const envPath = join(root, '.env');
  writeFileSync(envPath, 'ADMIN_PASSWORD=' + TEST_PASSWORD + NL, 'utf8');
  ensureAdminPassword(envPath, () => undefined);
  const db = openDatabase(':memory:');
  const ctx = {
    envPath,
    log: () => undefined,
    startedAt: '',
    root,
    db,
    ...(options.reload === undefined ? {} : { reloadContent: options.reload }),
  };
  return { ctx, root, filePath, db };
}

/** 登录并拿到可用的 cookie 头。必须走这一步 —— 保存那条路要登录 */
async function login(ctx: unknown): Promise<string> {
  const out = await request({
    ctx, method: 'POST', url: '/admin/api/login',
    body: JSON.stringify({ password: TEST_PASSWORD }),
  });
  assert.equal(out.status, 200, '测试自己的登录不该失败：' + out.msg);
  assert.ok(out.setCookie.startsWith('dsh_admin='), '登录要发 cookie：' + out.setCookie);
  // 只取「名=值」那一段（后面的 Path / HttpOnly 不是请求头该带的东西）
  return out.setCookie.split(';')[0]!;
}

/** 走一次 POST /admin/api/data/<entity>/<id> */
async function postRow(
  ctx: unknown, entity: string, id: string, patch: Record<string, unknown>, cookie: string,
) {
  return request({
    ctx,
    method: 'POST',
    url: '/admin/api/data/' + entity + '/' + encodeURIComponent(id),
    body: JSON.stringify(patch),
    cookie,
  });
}

test('M2.63 热重载：保存成功后调它，回执说「已即时生效」', async () => {
  let called = 0;
  const h = makeCtx({
    reload: () => {
      called += 1;
      return { ok: true, rebuilt: ['zones', 'powers'], errors: [], warnings: [] };
    },
  });
  try {
    const cookie = await login(h.ctx);
    const out = await postRow(h.ctx, 'zones', 'z1', { name: '改过的域' }, cookie);
    assert.equal(out.parsed?.['ok'], true, '保存该成功：' + out.msg);
    assert.equal(called, 1, '保存成功必须恰好调一次热重载（0 次=改了没生效，2 次=重复重载）');
    assert.ok(out.msg.indexOf('已即时生效') >= 0, '回执要说清楚已生效：' + out.msg);
    assert.ok(out.msg.indexOf('zones') >= 0, '回执要列出换了哪些索引：' + out.msg);
    assert.ok(out.msg.indexOf('重启') < 0, '已经热重载了就不该再让人去重启：' + out.msg);
    assert.ok(readFileSync(h.filePath, 'utf8').indexOf('改过的域') >= 0, '文件要真的改了');
  } finally {
    h.db.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('M2.63 热重载：校验没过时回执说清楚「没生效」', async () => {
  const h = makeCtx({
    reload: () => ({
      ok: false, rebuilt: [],
      errors: ['域 z9: locations 引用了未登记的地点 loc_不存在'], warnings: [],
    }),
  });
  try {
    const cookie = await login(h.ctx);
    const out = await postRow(h.ctx, 'zones', 'z1', { name: '改过的域' }, cookie);
    assert.equal(out.parsed?.['ok'], true, '保存本身成功（文件确实写了）');
    assert.ok(out.msg.indexOf('没有生效') >= 0, '回执必须明说没生效：' + out.msg);
    assert.ok(out.msg.indexOf('未登记的地点') >= 0, '要把校验错带出来：' + out.msg);
  } finally {
    h.db.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('M2.63 热重载：抛错时也不能把这次保存判成失败', async () => {
  const h = makeCtx({
    reload: () => { throw new Error('模拟重载崩了'); },
  });
  try {
    const cookie = await login(h.ctx);
    const out = await postRow(h.ctx, 'zones', 'z1', { name: '改过的域' }, cookie);
    assert.equal(out.parsed?.['ok'], true, '重载崩了不影响「文件已经写了」这个事实');
    assert.ok(out.msg.indexOf('热重载抛错') >= 0, '要说明重载本身崩了：' + out.msg);
    assert.ok(readFileSync(h.filePath, 'utf8').indexOf('改过的域') >= 0, '文件必须已经落盘');
  } finally {
    h.db.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('M2.63 热重载：没注入它时退回旧话术（重启后生效）', async () => {
  /*
   * 这个字段是**可选**的 —— 只想要文件编辑的调用方不该被迫提供它，
   * 而「没提供」时的行为必须与它出现之前逐字相同。
   */
  const h = makeCtx({});
  try {
    const cookie = await login(h.ctx);
    const out = await postRow(h.ctx, 'zones', 'z1', { name: '改过的域' }, cookie);
    assert.equal(out.parsed?.['ok'], true);
    assert.ok(out.msg.indexOf('重启机器人后生效') >= 0, '没有热重载时要退回旧话术：' + out.msg);
  } finally {
    h.db.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('M2.63 热重载：没有变化时不调它（省掉一次无谓的重建）', async () => {
  let called = 0;
  const h = makeCtx({
    reload: () => {
      called += 1;
      return { ok: true, rebuilt: [], errors: [], warnings: [] };
    },
  });
  try {
    const cookie = await login(h.ctx);
    const out = await postRow(h.ctx, 'zones', 'z1', { name: '测试域' }, cookie);
    assert.equal(out.msg, '没有变化。');
    assert.equal(called, 0, '没有任何字段变化时不该触发重载');
  } finally {
    h.db.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('M2.63 热重载：没登录时保存被挡住（热重载不该绕过鉴权）', async () => {
  let called = 0;
  const h = makeCtx({
    reload: () => {
      called += 1;
      return { ok: true, rebuilt: [], errors: [], warnings: [] };
    },
  });
  try {
    const out = await postRow(h.ctx, 'zones', 'z1', { name: '偷偷改' }, '');
    assert.equal(out.status, 401, '没登录必须 401');
    assert.equal(called, 0, '没登录时不该触发热重载');
    assert.ok(readFileSync(h.filePath, 'utf8').indexOf('偷偷改') < 0, '没登录时文件不该被改');
  } finally {
    h.db.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});
