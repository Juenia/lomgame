import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { silentLogger } from '../src/infra/logger.ts';
import { createOneBotApp, startHttpServer } from '../src/main.ts';

interface Captured {
  path: string;
  body: Record<string, unknown>;
}

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

/**
 * 真正走 HTTP 的端到端：模拟 OneBot 实现（NapCat/Lagrange）反向上报，
 * 断言业务回复是通过 OneBot HTTP API 发出去的，而不是只测了纯函数。
 */
test('HTTP 端到端：OneBot 上报 → 路由 → OneBot HTTP API 发送', async () => {
  const captured: Captured[] = [];
  const fakeApi = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      captured.push({
        path: (req.url ?? '').replace(/^\//, ''),
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0 }));
    });
  });
  const apiPort = await listen(fakeApi);

  const app = createOneBotApp(
    {
      dbPath: ':memory:',
      port: 0,
      onebotApiBase: `http://127.0.0.1:${apiPort}`,
      detailToPrivate: true,
    },
    silentLogger,
  );
  const server = startHttpServer(app);
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;

  try {
    const report = await fetch(`http://127.0.0.1:${port}/onebot/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        post_type: 'message',
        message_type: 'group',
        message_id: 70001,
        user_id: 20001,
        group_id: 10001,
        // M2.7.6：创建两步走，群里这一步只会播报「他想取这个名字」
        raw_message: '.创建 克莱恩',
        time: 1789000000,
        sender: { card: '克莱恩' },
      }),
    });
    assert.equal(report.status, 200);

    const groupSend = captured.find((c) => c.path === 'send_group_msg');
    assert.ok(groupSend, '回执必须通过 OneBot API 发出');
    assert.equal(groupSend.body.group_id, 10001);
    /*
     * 群聊与私聊合并成同一条路之后，群里拿到的是**完整菜单**，
     * 不再是「只播报一句『他想取这个名字』+ 明细走私聊」。
     * 这条用例走的是真实 OneBot HTTP 链路，所以它同时也验证了：
     * 这次改动对 OneBot 通道同样生效（它本来就不过滤 @）。
     */
    assert.match(String(groupSend.body.message), /你是男性还是女性/);
    assert.match(String(groupSend.body.message), /1\. 男性/);
    assert.equal(
      captured.filter((c) => c.path === 'send_private_msg').length,
      0,
      '不再额外发私聊明细（内容已经在群里了）',
    );

    /*
     * M2.7.6：创建是**两步**（姓名 → 性别）。
     * 群聊现在也能走完（菜单就在群里），这里仍然走私聊，
     * 顺带把「没有角色时数字回复也能跑通」这条路径压到真实 HTTP 上。
     */
    const selfId = 20001;
    const post = async (messageId: number, rawMessage: string): Promise<void> => {
      const response = await fetch(`http://127.0.0.1:${port}/onebot/event`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          post_type: 'message',
          message_type: 'private',
          message_id: messageId,
          user_id: selfId,
          raw_message: rawMessage,
          time: 1789000000,
          sender: { nickname: '克莱恩' },
        }),
      });
      assert.equal(response.status, 200);
    };
    await post(70002, '.创建 克莱恩');
    await post(70003, '1');

    /*
     * M2.91：**私聊通道的判据**（用户问「是不是把私聊关了」）。
     *
     * 上面那两次上报就是私聊（`message_type: private`），但原来只断言了 HTTP 200 ——
     * 「私聊有没有被回」这件事一条判据都没有。现在钉住：回复必须走
     * `send_private_msg`、并且回到**同一个 user_id**。
     *
     * 与群聊那条（`send_group_msg`）合起来，就是用户要的那句话：
     * **群聊与私聊是一起启用的**，两条都在真实 OneBot HTTP 链路上跑通。
     */
    const privSend = captured.filter((c) => c.path === 'send_private_msg');
    assert.ok(privSend.length >= 2, '私聊的两步（姓名 / 性别）都该有回复，实际 ' + privSend.length + ' 条');
    assert.equal(privSend[0]!.body.user_id, selfId, '私聊回复要回到发消息的那个人');
    assert.match(String(privSend[1]!.body.message), /【创建角色】|你是/, '第二步要给出建号结果');

    // 非消息事件不应触发任何回复
    const before = captured.length;
    await fetch(`http://127.0.0.1:${port}/onebot/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ post_type: 'notice', notice_type: 'group_recall' }),
    });
    assert.equal(captured.length, before);

    const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as {
      ok: boolean;
      characters: number;
      commands: string[];
    };
    assert.equal(health.ok, true);
    assert.equal(health.characters, 1);
    /*
     * ⚠️ M2.90：这份清单是**写死的 G 表**（加一条指令就回来改一次，这是有意的）。
     * 从 M2.85 起陆续加了 `.看 / .查 / .装备栏 / .装备 / .卸下 / .买 / .商店 / .卖 /
     * .委托 / .接 / .交 / .走` 与 M2.86 的 `.菜单`，而这张表没跟上 —— 于是一直红着。
     * 红着的判据等于没有判据：它本来该在**有人加指令**的那一刻提醒你。
     */
    assert.deepEqual(health.commands, [
      '创建',
      '线索',
      '图鉴',
      '状态',
      '角色',
      '行动',
      '帮助',
      '菜单',
      '事件',
      '探索',
      '看',
      '查',
      '装备栏',
      '装备',
      '卸下',
      '买',
      '商店',
      '卖',
      '委托',
      '接',
      '交',
      '走',
      '背包',
      '使用',
      '魔药',
      '服用',
      '交易',
      '确认',
      '取消',
      '晋升',
      '休息',
      '就医',
      '遇见',
      '净化',
      '占卜',
      '队伍',
      '反馈',
      '世界',
      '神战',
      '王座',
      '今日',
      '仪式',
      '干扰',
      '袭击',
      '举报',
      '移动',
      '遭遇',
      '战斗',
      '挑战',
      '加入教会',
      '教会',
      '封禁',
      '解禁',
      '关闭游戏',
      '开启游戏',
      '关闭本群游戏',
      '开启本群游戏',
      '关闭主动推送',
      '开启主动推送',
      '关闭本群主动推送',
      '开启本群主动推送',
      '关闭主动事件推送',
      '开启主动事件推送',
      '关闭本群主动事件推送',
      '开启本群主动事件推送',
      '游戏状态',
      '世界状态',
      '机器人状态',
      '管理',
    ]);

    const missing = await fetch(`http://127.0.0.1:${port}/nothing`);
    assert.equal(missing.status, 404);
  } finally {
    server.close();
    app.close();
    fakeApi.close();
  }
});

test('HTTP 端到端：开启 accessToken 后必须带 Bearer 才受理', async () => {
  const app = createOneBotApp(
    { dbPath: ':memory:', port: 0, onebotApiBase: 'http://127.0.0.1:1', onebotToken: 'secret', detailToPrivate: true },
    silentLogger,
  );
  const server = startHttpServer(app);
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;

  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/onebot/event`, {
      method: 'POST',
      body: JSON.stringify({ post_type: 'message', message_type: 'private', message_id: 1, user_id: 2, raw_message: '.帮助' }),
    });
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`http://127.0.0.1:${port}/onebot/event`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
      body: JSON.stringify({ post_type: 'message', message_type: 'private', message_id: 2, user_id: 2, raw_message: '.帮助' }),
    });
    assert.equal(authorized.status, 200);
  } finally {
    server.close();
    app.close();
  }
});
