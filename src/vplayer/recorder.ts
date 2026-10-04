/**
 * 行为日志（W7）：每条指令一行 JSONL，可回溯、可复算。
 * 同时保留在内存里供覆盖率与异常统计使用。
 */
import { createWriteStream, type WriteStream } from 'node:fs';
import type { ActionRecord } from './types.ts';

export class Recorder {
  #stream: WriteStream | null = null;
  #records: ActionRecord[] = [];

  constructor(filePath?: string) {
    if (filePath) this.#stream = createWriteStream(filePath, { flags: 'w' });
  }

  record(entry: ActionRecord): void {
    this.#records.push(entry);
    this.#stream?.write(`${JSON.stringify(entry)}\n`);
  }

  get records(): readonly ActionRecord[] {
    return this.#records;
  }

  async close(): Promise<void> {
    if (!this.#stream) return;
    await new Promise<void>((resolve) => this.#stream!.end(resolve));
    this.#stream = null;
  }
}
