import type { InternalMessage } from '../adapter/types.ts';

/** OneBot 的 @ 会以 CQ 码形式出现在 raw_message 里；同时兼容手打的 @QQ号 与纯 QQ 号 */
export function parseAtTarget(text: string): string | null {
  const cq = /\[CQ:at,qq=(\d+)\]/.exec(text);
  if (cq) return cq[1] ?? null;
  const plain = /^@(\d{5,})$/.exec(text.trim());
  if (plain) return plain[1] ?? null;
  const digits = /^(\d{5,})$/.exec(text.trim());
  return digits ? (digits[1] ?? null) : null;
}

/** 解析正整数，非法返回 null */
export function parsePositiveInt(text: string | undefined): number | null {
  if (text === undefined) return null;
  if (!/^\d+$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function displayName(msg: InternalMessage): string {
  return msg.nickname || msg.userId;
}
