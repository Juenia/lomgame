/**
 * 把一张图上传到 QQ 富媒体，换回一个**能写进 markdown 的公网 URL**。
 *
 * ## 为什么非要有这一步
 *
 * 官方通道下「图 + 正文 + 按钮」要合成**一条**，唯一形态是 markdown 正文里嵌图
 * （`![](url)`），而那个 url 必须落在平台白名单域名上 —— 只能由 QQ 自己的富媒体
 * 上传换来（`raw_url` 落在 `*.myqcloud.com`）。
 *
 * ## 四步是从哪抄的
 *
 * 与内核 `src/adapter/qq-official/index.ts` 的 `#uploadToOfficialRawUrl` **逐字同构**，
 * 那条路真机验过（M2.86）：
 *
 *   ① `POST /v2/{groups|users}/{id}/upload_prepare` → upload_id + 每片的 presigned_url
 *   ② 逐片 `PUT presigned_url`（**content-type 必须是图片类型**，写错了 markdown 里会裂）
 *   ③ `POST .../upload_part_finish` 逐片通知完成
 *   ④ `POST .../files`（`srv_send_msg: false`）→ 响应里带 `raw_url`
 *
 * ⚠️ 只是「路径同构」：**请求由 adapter-qq 替我们发**（`bot.internal.*` 管着 token），
 * 所以这里不碰凭据、也不需要知道 appId。
 *
 * ## 失败一律返回 undefined
 *
 * 上传失败的原因五花八门（权限没开、配额、网络、平台改接口），而它**不是致命错误**：
 * 调用方回传 undefined，服务端回落成「图单独发一条」—— 玩家最多看到老样子，
 * 不会因为这一步什么都看不到。
 */

/** 上传要用的四个动作（按结构约定，图的是能在测试里用假的替身跑通流程） */
export interface OfficialUploadApi {
  /** `POST .../upload_prepare` */
  prepare(targetId: string, isDirect: boolean, body: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** `POST .../upload_part_finish` */
  partFinish(targetId: string, isDirect: boolean, body: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** `POST .../files`（合并；`srv_send_msg: false` 表示只要 file_info，不直接发） */
  finish(targetId: string, isDirect: boolean, body: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** 分片 PUT（走 Koishi 的 ctx.http） */
  put(url: string, bytes: Uint8Array, contentType: string): Promise<{ ok: boolean; status: number }>;
}

export interface UploadTarget {
  targetId: string;
  /** 私聊走 `/v2/users/*`，群走 `/v2/groups/*` */
  isDirect: boolean;
}

/** 扩展名：官方要靠它认图片类型，缺了会当成未知文件 */
function extensionFor(mediaType: string): string {
  if (mediaType === 'image/jpeg') return 'jpg';
  if (mediaType === 'image/webp') return 'webp';
  if (mediaType === 'image/gif') return 'gif';
  return 'png';
}

/**
 * 走完四步，拿到 `raw_url`。
 *
 * @returns 能写进 markdown 的 URL；任何一步不对就 `undefined`（调用方回落）
 */
export async function uploadImageForMarkdown(
  api: OfficialUploadApi,
  target: UploadTarget,
  image: { base64: string; mediaType: string },
): Promise<string | undefined> {
  try {
    const bytes = Buffer.from(image.base64, 'base64');
    if (bytes.length === 0) return undefined;

    // ① 准备
    const prep = await api.prepare(target.targetId, target.isDirect, {
      file_type: 1,
      file_size: bytes.length,
      file_name: `card.${extensionFor(image.mediaType)}`,
    });
    const uploadId = String(prep.upload_id ?? '');
    const parts = Array.isArray(prep.parts)
      ? (prep.parts as Array<{ index?: unknown; presigned_url?: unknown }>)
      : [];
    if (uploadId === '' || parts.length === 0) return undefined;

    // ② 逐片 PUT + ③ 逐片通知完成
    for (const part of parts) {
      const partUrl = typeof part.presigned_url === 'string' ? part.presigned_url : '';
      const partIndex = typeof part.index === 'number' ? part.index : 0;
      if (partUrl === '') return undefined;
      const put = await api.put(partUrl, bytes, image.mediaType);
      if (!put.ok) return undefined;
      await api.partFinish(target.targetId, target.isDirect, {
        upload_id: uploadId,
        part_index: partIndex,
        block_size: bytes.length,
      });
    }

    // ④ 合并拿 raw_url
    const merged = await api.finish(target.targetId, target.isDirect, {
      file_type: 1,
      upload_id: uploadId,
      srv_send_msg: false,
    });
    const rawUrl = typeof merged.raw_url === 'string' ? merged.raw_url : '';
    return rawUrl === '' ? undefined : rawUrl;
  } catch {
    // 网络 / 平台报错都算「这一步没成」—— 回落，不上抛
    return undefined;
  }
}