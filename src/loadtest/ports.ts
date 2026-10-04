import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** 取一个空闲端口（压测里要同时起服务进程与假 OneBot API） */
export async function getFreePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
