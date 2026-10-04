/**
 * 角色卡头像（M2.47）：把玩家的 QQ 头像落到本地，供卡面模板读成 data URI。
 *
 * ## 为什么要落到本地
 *
 * 渲染器（Edge 无头）拿到的是一张**自包含的 HTML**，头像必须以 data URI 内嵌
 * （`template.ts` 的 `dataUri()`）。让 Chromium 自己去拉网络图会引入超时/证书/代理
 * 一堆不确定因素，而且失败在渲染进程里只表现为「画不出来」。
 * 所以：**Node 侧下载 + 校验 + 缓存，渲染器只管读文件**。
 *
 * ## 两条头像直链（平台不同，格式不同）
 *
 * | 平台 | 形式 | 出处 |
 * | --- | --- | --- |
 * | QQ 官方机器人 | `q.qlogo.cn/qqapp/{appId}/{openid}/{size}` | `adapter/official.ts` 的 `avatarUrlOf`（M2.44 真机验证过） |
 * | OneBot / 第三方 | `q1.qlogo.cn/g?b=qq&nk={qq}&s={size}` | 公开头像服务，直接用 QQ 号 |
 *
 * ⚠️ 官方通道给的是 **app 维度的 openid**，不是 QQ 号 —— 拿 QQ 号去拼官方链接一定 404，
 * 所以这里按平台分派，不猜。
 *
 * ## 失败一律降级，绝不阻塞出卡
 *
 * 头像拿不到是**常态**（无网、平台没给 openid、玩家换了头像服务没同步）。
 * 渲染器在没有头像时会画「名字首字的纹章」（见 `template.ts` 的 `.monogram` 分支），
 * 所以这里返回 `undefined` 就是正常路径 —— 与按钮降级同一条纪律。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataPath } from '../infra/paths.ts';

/** 头像缓存默认位置：跟着数据库放，别写进源码树 */
export const DEFAULT_AVATAR_DIR = dataPath('avatars');

/** 缓存有效期：QQ 头像会换，但不必每次出卡都拉一遍 */
export const AVATAR_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 只接受这几种魔数 —— 拿 HTML 错误页当图片存下来，画到卡上会是一块空白 */
function sniffMediaType(bytes: Buffer): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

/** 官方机器人头像直链（与 `adapter/official.ts` 的 avatarUrlOf 同构；此处自带一份，避免 card 层依赖 adapter 层） */
export function officialAvatarUrl(appId: string, openid: string, size = 640): string {
  return `https://q.qlogo.cn/qqapp/${encodeURIComponent(appId)}/${encodeURIComponent(openid)}/${size}`;
}

/** OneBot / 第三方头像直链（认 QQ 号） */
export function onebotAvatarUrl(qq: string, size = 640): string {
  return `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(qq)}&s=${size}`;
}

export interface AvatarRequest {
  /** 缓存键：用 QQ 号或 openid 都行，只用来算文件名 */
  key: string;
  /** 直链；不知道就传 undefined，函数直接返回 undefined */
  url?: string;
  /** 缓存目录，默认 `data/avatars` */
  dir?: string;
  /** 缓存有效期（毫秒），默认 7 天。**负数表示任何缓存都算过期**（测试与强制刷新用） */
  ttlMs?: number;
  /** 注入的 fetch，测试用 */
  fetchImpl?: typeof fetch;
}

/**
 * 缓存文件名的词干：键的 SHA-256 前 32 位十六进制。
 *
 * 为什么不用 QQ 号直接当文件名：键将来可能换成 openid（含字母且长度不定），
 * 而文件名要能安全地穿过 **PowerShell 5.1**（它按 ANSI 读命令行参数）。
 * 纯十六进制是最稳的一种 —— 出图链路上任何一段都不会把它读成乱码。
 */
function stemOf(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

/** 缓存文件名：词干 + 嗅探出的后缀 */
function cachePathOf(dir: string, key: string, ext: string): string {
  return join(dir, `${stemOf(key)}${ext}`);
}

/** 在缓存目录里找这个键已有的文件（后缀不定，得扫） */
function findCached(dir: string, key: string): string | undefined {
  const stem = stemOf(key);
  if (!existsSync(dir)) return undefined;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(stem)) return join(dir, name);
  }
  return undefined;
}

/**
 * 取一张可供渲染器读取的头像**本地路径**。
 *
 * @returns 命中的缓存文件，或刚下载落盘的文件；**拿不到时返回 undefined**（由渲染器画首字纹章）
 */
export async function resolveAvatarPath(request: AvatarRequest): Promise<string | undefined> {
  const dir = request.dir ?? DEFAULT_AVATAR_DIR;
  const ttl = request.ttlMs ?? AVATAR_TTL_MS;
  const cached = findCached(dir, request.key);
  if (cached !== undefined) {
    try {
      if (Date.now() - statSync(cached).mtimeMs < ttl) return cached;
    } catch {
      // 缓存文件在扫描后消失（并发清理）：当作没有缓存，继续走下载
    }
  }
  if (request.url === undefined || request.url.length === 0) return undefined;

  const doFetch = request.fetchImpl ?? fetch;
  try {
    const response = await doFetch(request.url, { redirect: 'follow' });
    if (!response.ok) return undefined;
    const bytes = Buffer.from(await response.arrayBuffer());
    const mediaType = sniffMediaType(bytes);
    // 不是图片（多半是错误页）就不落盘 —— 宁可没有头像，也不要一张破图
    if (mediaType === undefined) return undefined;
    const ext = mediaType === 'image/jpeg' ? '.jpg' : mediaType === 'image/png' ? '.png' : mediaType === 'image/gif' ? '.gif' : '.webp';
    mkdirSync(dirname(cachePathOf(dir, request.key, ext)), { recursive: true });
    const file = cachePathOf(dir, request.key, ext);
    writeFileSync(file, bytes);
    // 旧后缀的同键文件（换过头像格式）清掉，避免 findCached 命中陈旧的那张
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (name.startsWith(stemOf(request.key)) && full !== file) {
        try {
          unlinkSync(full);
        } catch {
          // 删不掉就算了：findCached 会命中新的那份
        }
      }
    }
    return file;
  } catch {
    // 网络异常是常态，不当错误上抛
    return undefined;
  }
}
