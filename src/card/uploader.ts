/**
 * 卡图上传（M2.47）：给官方通道准备一个**公网可访问的 URL**。
 *
 * ## 为什么需要上传这一步
 *
 * 官方 markdown 的图片要求「可在公网访问的资源 url，开放平台会下载转存该资源」——
 * 而卡是本地 PowerShell 画的。两条路：
 *   1. **自建托管**：服务把出图目录挂在 `GET /cards/<文件名>.png`，
 *      你把它暴露到公网（反代 / 内网穿透），配 `CARD_PUBLIC_BASE_URL` ⇒ 用这条；
 *   2. **临时图床**：把图 POST 给一个公开图床，拿它返回的 URL ⇒ 就是本模块。
 *
 * 第 1 条是首选（数据不出自己的机器）；第 2 条**默认关闭**，因为卡面会被交给第三方，
 * 且临时图床的文件会过期。开启方式：`CARD_IMAGE_UPLOAD=uguu`。
 *
 * ## 过期这件事为什么可以接受
 *
 * 官方会**下载转存**图片 —— 一旦平台抓过，群里显示的就是它自己那份。
 * 所以临时 URL 只需要在「发出消息 → 平台抓取」这个窗口里有效（通常几秒到几分钟）。
 * 真机如果出现「图过一会儿裂了」，说明平台没转存 —— 那时应当切回第 1 条。
 *
 * ## 实测记录（2026-09-30，本机）
 *
 * | 服务 | 结果 |
 * | --- | --- |
 * | **picui.cn** | ✅ **可用、无需 key、国内站**：`POST https://picui.cn/api/v1/upload`（字段 `file`）⇒ `data.links.url` 形如 `https://picui.ogmua.cn/s1/2026/09/30/xxx.webp`，回读 200 / image/webp |
 * | **uguu.se** | ⚠️ 能传（`POST /upload.php`，字段 `files[]`），但它的域名在 **QQ 服务器那一侧抓不到** —— 写进 markdown 就是一张裂图（真机实测） |
 * | telegra.ph / catbox.moe / tmpfiles.org | ❌ 本机网络不通（`fetch failed`） |
 * | freeimage.host | ❌ `You have been forbidden to use this website.` |
 *
 * ⚠️ **判据不是「能上传」，而是「平台抓得到」** —— 这正是 uguu 那次的教训：
 * 本机回读 200 不等于 QQ 抓得到。所以**国内可达的图床**才是对的那一类，
 * picui 因此成为默认（见 `service.ts` 的 `CARD_IMAGE_UPLOAD`）。
 */

/** 能解析成 http(s) 就返回规范化的地址，否则 undefined */
function asHttpUrl(raw: string): string | undefined {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export interface UploadResult {
  /** 公网可访问的图片 URL */
  url: string;
  /** 用的哪个服务（日志与排查用） */
  provider: string;
}

export interface UploadOptions {
  /** 注入的 fetch，测试用 */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** `provider === 'github'` 时必填 */
  github?: GithubUploadConfig;
}

/** 支持的图床。新增一个只要在这里加一条 + 写一个解析函数 */
export type UploadProvider = 'github' | 'picui' | 'uguu';

/**
 * GitHub 图床的配置（**推荐**：它不需要部署方自建任何服务）。
 *
 * 一个仓库 + 一个 token 就够：图提交进仓库，链接走 jsDelivr / raw。
 * 本机实测（2026-09-30）：
 *   · `cdn.jsdelivr.net/gh/…` → 200 / **image/png** / 1.1s
 *   · `raw.githubusercontent.com/…` → 200 / **image/png** / 0.4s
 * `Content-Type` 正确这一点很关键：有些图床回 `text/plain`，markdown 里就不显示。
 */
export interface GithubUploadConfig {
  /** `owner/repo` */
  repo: string;
  /** 有 `contents:write` 权限的 token（PAT） */
  token: string;
  /** 分支，默认 main */
  branch?: string;
  /** 走哪条 CDN；默认 jsdelivr（国内节点更多） */
  cdn?: 'jsdelivr' | 'raw';
}

/**
 * 上传一张图，返回公网 URL。
 *
 * @returns 成功给出 URL；**失败返回 undefined**（调用方回落文字卡，不抛错）
 */
export async function uploadCardImage(
  bytes: Uint8Array,
  mediaType: string,
  provider: UploadProvider,
  options: UploadOptions = {},
): Promise<UploadResult | undefined> {
  const doFetch = options.fetchImpl ?? fetch;
  const ext = mediaType === 'image/jpeg' ? 'jpg' : mediaType === 'image/png' ? 'png' : 'webp';
  try {
    if (provider === 'github') {
      const cfg = options.github;
      if (cfg === undefined || cfg.repo === '' || cfg.token === '') return undefined;
      const branch = cfg.branch ?? 'main';
      /*
       * 文件名带时间戳 + 随机后缀：GitHub 的 contents API 对**同名文件**要求带上旧的 `sha`，
       * 每次都用新名字就不用处理那一层（也正好留住每一张卡的历史）。
       */
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const rand = Math.random().toString(36).slice(2, 8);
      const path = `cards/${stamp}-${rand}.${ext}`;
      const response = await doFetch(`https://api.github.com/repos/${cfg.repo}/contents/${path}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          // GitHub 要求带 UA，缺了直接 403
          'User-Agent': 'lord-of-mysteries-bot',
        },
        body: JSON.stringify({
          message: `card ${path}`,
          content: Buffer.from(bytes).toString('base64'),
          branch,
        }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (!response.ok) return undefined;
      const url =
        (cfg.cdn ?? 'jsdelivr') === 'raw'
          ? `https://raw.githubusercontent.com/${cfg.repo}/${branch}/${path}`
          : `https://cdn.jsdelivr.net/gh/${cfg.repo}@${branch}/${path}`;
      return { url, provider: 'github' };
    }
    if (provider === 'picui') {
      /*
       * 国内图床（**默认**）：无需 key、CDN 在国内（`picui.ogmua.cn`），
       * 所以 QQ 平台抓得到 —— 这是 uguu 那条路的反面。
       * 它会自动把 PNG 转成 webp（返回的 mimetype 是 image/webp），对 markdown 没有影响。
       */
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: mediaType }), `card.${ext}`);
      const response = await doFetch('https://picui.cn/api/v1/upload', {
        method: 'POST',
        body: form,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (!response.ok) return undefined;
      const payload = (await response.json()) as {
        status?: boolean;
        data?: { links?: { url?: string } };
      };
      if (payload.status !== true) return undefined;
      const clean = asHttpUrl(payload.data?.links?.url ?? '');
      if (clean === undefined) return undefined;
      return { url: clean, provider: 'picui' };
    }
    if (provider === 'uguu') {
      const form = new FormData();
      form.append('files[]', new Blob([bytes], { type: mediaType }), `card.${ext}`);
      const response = await doFetch('https://uguu.se/upload.php', {
        method: 'POST',
        body: form,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (!response.ok) return undefined;
      const payload = (await response.json()) as { success?: boolean; files?: Array<{ url?: string }> };
      if (payload.success !== true) return undefined;
      const url = payload.files?.[0]?.url;
      if (typeof url !== 'string' || url.length === 0) return undefined;
      // 只认能解析成 http(s) 的地址：坏 URL 在官方 markdown 里不会报错，只会静默不显示
      const clean = asHttpUrl(url) ?? asHttpUrl(url.replace(/\\\//g, '/'));
      if (clean === undefined) return undefined;
      return { url: clean, provider: 'uguu' };
    }
    return undefined;
  } catch {
    // 网络异常是常态（图床挂了 / 被墙 / 超时），不当错误上抛
    return undefined;
  }
}
