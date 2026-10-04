/**
 * 从正文里取指令名（M2.82 从 qq-official 抽出来共用）。
 *
 * 两条通道的灰度白名单要判同一件事：「这条消息是不是在调某条指令」。
 * 各写一份的话，口径迟早会分叉（一边认全角句号一边不认），
 * 而分叉的表现是「某条指令在一条通道上被挡、另一条上放行」—— 很难查。
 *
 * 刻意**不认识路由的 parseCommand**：适配器不该认识指令体系，
 * 真正的解析与判定全在 router。这里只做一次「这段文本像不像一条指令」的粗筛，
 * 服务于灰度开关。
 */
export function commandNameOf(rawText: string): string | null {
  const trimmed = rawText.trim();
  if (!/^[.。．]/.test(trimmed)) return null;
  const body = trimmed.slice(1).trim();
  if (!body) return null;
  return body.split(/\s+/)[0] ?? null;
}
