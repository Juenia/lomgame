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
      // M2.7.6 / M2.85：普通人阶段的主入口是 .线索
      '线索',
      // M2.85 内容填充 P1：新增的 .图鉴（六张设定表的读取点）
      '图鉴',
      '状态',
      // M2.47：把角色数据画成一张图（通道发不出图时回落文字卡）
      '角色',
      // M2.38 任务 1（P0）：途径专属行动的**执行入口**（在此之前那张表只有文案）
      '行动',
      '帮助',
      // M2.86：图片版指令表（`.菜单 [编号]`，共 6 张）
      '菜单',
      // M2.45：真机 markdown 能力探测 —— 只进注册表，**不进 .帮助 的手写清单**
      //（HELP_TEXT 是写死的，所以玩家看不到它）。G 表红了正好提醒来加这两行。
      'mdprobe',
      '探针',
          '事件',
      '探索',
      // M2.85 RPG 化：.看 这里有什么 / .走 走过去 / .查 追查阴谋
      '看',
      '查',
      // M2.85 B：装备与用便士换一件非凡物品
      '装备栏',
      '装备',
      '卸下',
      '买',
      // M2.87 交易体系：.商店 看货架 / .卖 出手背包里的东西
      '商店',
      '卖',
      // M2.85 D：委托（.委托 / .接 / .交）
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
  // M2.120：日常遭遇的结算命令（菜单选项的 command，不是给玩家手打的）
  '遇见',
      '净化',
      '占卜',
      '队伍',
      '反馈',
      // M2.2：《世界》总览与地区天气
      '世界',
      // M2.3：当日摘要 + 菜单入口
      '今日',
      // M2.5：晋升仪式与干扰
      '仪式',
      '干扰',
      // M2.6：通缉系统 —— 犯罪（.袭击）与情报变现（.举报）
      '袭击',
      '举报',
      // M2.7：跨城市移动（看目的地 / 出发 / 处理路途事件）
      '移动',
      // M2.8：遭遇的处置（观察 / 对峙 / 撤退 / 互动）
      '遭遇',
      // M2.9：PVE 回合制战斗
      '战斗',
      // M2.10：PVP 挑战
      '挑战',
      // M2.16：教会 —— 入教（顶级）/ 身份页与捐献（顶级 + 子指令）
      '加入教会',
      '教会',
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
