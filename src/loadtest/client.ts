/**
 * 压测客户端（W6）：只走真实 HTTP。
 *   - 上报走 POST /onebot/event（模拟 OneBot 反向 HTTP 上报）
 *   - 出站消息由假 OneBot API 收走
 *   - 延迟从「发出请求」到「收到 HTTP 200」计算
 */
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';

export interface OutboundMessage {
  path: string;
  body: Record<string, unknown>;
  at: number;
}

export interface FakeOneBot {
  port: number;
  received: OutboundMessage[];
  server: Server;
  close(): Promise<void>;
  /** 取出并清空已收到的消息 */
  take(): OutboundMessage[];
}

export async function startFakeOneBotApi(): Promise<FakeOneBot> {
  const received: OutboundMessage[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      received.push({
        path: (req.url ?? '').replace(/^\//, ''),
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
        at: Date.now(),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0 }));
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    received,
    server,
    take: () => {
      const out = received.splice(0, received.length);
      return out;
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface MessageEventInput {
  messageId: string;
  userId: string;
  rawText: string;
  scene: 'private' | 'group';
  sceneId?: string;
  nickname?: string;
  /** 覆盖事件时间（秒），默认当前时间 */
  timeSec?: number;
}

/** OneBot 的 message_id 通常是数字；压测里我们用可读字符串，这里做一次兼容 */
function messageIdOf(value: string): number | string {
  return /^\d+$/.test(value) ? Number(value) : value;
}

export function buildMessageEvent(input: MessageEventInput): Record<string, unknown> {
  const time = input.timeSec ?? Math.floor(Date.now() / 1000);
  if (input.scene === 'group') {
    return {
      post_type: 'message',
      message_type: 'group',
      message_id: messageIdOf(input.messageId),
      user_id: Number(input.userId),
      group_id: Number(input.sceneId ?? '10001'),
      raw_message: input.rawText,
      time,
      sender: { card: input.nickname ?? input.userId },
    };
  }
  return {
    post_type: 'message',
    message_type: 'private',
    message_id: messageIdOf(input.messageId),
    user_id: Number(input.userId),
    raw_message: input.rawText,
    time,
    sender: { nickname: input.nickname ?? input.userId },
  };
}

export interface RequestResult {
  ok: boolean;
  status: number;
  costMs: number;
  error?: string;
}

/** 上报一条事件并计时 */
export async function reportEvent(
  port: number,
  event: Record<string, unknown>,
  timeoutMs = 10_000,
  token?: string,
): Promise<RequestResult> {
  const started = performance.now();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/onebot/event`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const costMs = performance.now() - started;
    if (!response.ok) {
      return { ok: false, status: response.status, costMs, error: `HTTP ${response.status}` };
    }
    // 服务端是「先处理完再回 200」，所以这里的耗时就是端到端处理耗时
    await response.text();
    return { ok: true, status: response.status, costMs };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      costMs: performance.now() - started,
      error: (error as Error).message,
    };
  }
}

export async function getJson(port: number, path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return (await response.json()) as Record<string, unknown>;
}
