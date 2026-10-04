/**
 * **QQ 平台的图片域名白名单**（M2.45）。
 *
 * ## 为什么需要这个模块
 *
 * 平台的图片下载受一份**硬编码的 SSRF 白名单**约束 ——
 * 不在这份名单里的域名，图片**一定**显示不出来，与它稳不稳定、是不是 HTTPS、
 * 有没有防盗链**全都无关**。
 *
 * 名单来源：开源项目 openclaw 的 `QQBOT_MEDIA_SSRF_POLICY`
 * （提交 `ddb7a8d` / PR #65788，2026-09 更新）。完整清单与踩坑记录见
 * `docs/QQ-markdown-能力实测.md`。
 *
 * ## 它推翻了什么
 *
 * 我们先后试过 uguu.se、picui.cn、jsDelivr —— **全部裂图**，而每一个都能上传、
 * 本机回读 200、也没有防盗链。「本机能打开」被当成了判据，那是个假阳性。
 *
 * 更要紧的是：**自建托管同样无效** —— `CARD_PUBLIC_BASE_URL` 指向自己的公网域名时，
 * 那个域名也不在这九个里。
 */
const MEDIA_HOST_ALLOWLIST: readonly RegExp[] = [
  /\.qpic\.cn$/i, // QQ 图片 CDN
  /\.qlogo\.cn$/i, // ⚠️ 头像域名（q.qlogo.cn）—— **openclaw 那份名单里没有它，但头像一直在正常显示**，
  //                  所以按**实测**补进来：能显示的域名才算数，名单是参考不是教条。
  /\.qq\.com$/i, // QQ 主域名
  /\.weiyun\.com$/i, // 腾讯微云
  /\.qq\.com\.cn$/i, // multimedia.nt.qq.com.cn
  /\.ugcimg\.cn$/i, // QQ 机器人 UGC 图床（qbot.ugcimg.cn）
  /\.myqcloud\.com$/i, // 腾讯云 COS
  /\.tencentcos\.cn$/i, // 腾讯云 COS
  /\.tencentcos\.com$/i, // 腾讯云 COS
];

/**
 * 这个 URL 能不能被平台取到（也就是能不能写进 markdown 正文）。
 *
 * ⚠️ **判据是域名，不是「URL 来源可不可控」** —— 这一点我们绕了很久：
 * 自建域名、第三方图床、全球 CDN，全都不在名单里。只有腾讯自己的域名能用。
 */
export function isAllowedMediaHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return MEDIA_HOST_ALLOWLIST.some((pattern) => pattern.test(host));
}

/** 给排查用：把允许的域名说出来（日志 / 后台面板） */
export const MEDIA_HOSTS: readonly string[] = [
  '*.qpic.cn',
  '*.qlogo.cn',
  '*.qq.com',
  '*.weiyun.com',
  '*.qq.com.cn',
  '*.ugcimg.cn',
  '*.myqcloud.com',
  '*.tencentcos.cn',
  '*.tencentcos.com',
];
