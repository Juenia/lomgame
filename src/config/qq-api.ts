/**
 * QQ 官方开放平台的两个 API 基址（M2.104 从 `adapter/qq-official/gateway.ts` 搬到配置层）。
 *
 * ## 为什么要把两个字符串单独放一个文件
 *
 * 运营后台的「通道配置」表单要用它们把 `sandbox` 开关翻译成基址
 * （见 `src/admin/adapter.ts` 的 `patchFromForm`）。而那两个值原来住在
 * `adapter/qq-official/gateway.ts` 里 —— 那个模块带着 WS 连接、心跳、重连一整套，
 * 于是**任何一个只是想在表单里选一下环境的进程，都会把整条官方网关链路加载进来**。
 *
 * 这一条在「无适配器 / 纯 API 版」（`bridge-api/`）上是致命的：
 * 那一版的全部意义就是不加载任何平台适配器，而后台是它必须复用的东西
 * —— 由 `bridge-api/test/no-platform-adapter.test.ts` 那条运行时判据守着。
 *
 * 所以：**地址是配置，协议实现才是适配器。** 两者分开放。
 */

/**
 * 正式环境 API 基址。
 *
 * 官方文档「API 调用指南 → 统一请求地址」写的是 `https://api.bot.qq.com`。
 * 本机实测两个域名都可用且指向同一后端（`/users/@me`、`/gateway` 均 200）。
 * 这里保留 `api.sgroup.qq.com` 的理由是：`GET /gateway` 返回的 WS 地址正是它
 * （平台自己在用这个域名），而且整条端到端链路是在这个域名上跑通的 ——
 * 不在没有实测机会的时候替换已验证的东西。
 */
export const API_BASE_PROD = 'https://api.sgroup.qq.com';

/** 沙箱环境。**只有把群加进沙箱后台的那个环境才会推事件** —— 两个都要能切 */
export const API_BASE_SANDBOX = 'https://sandbox.api.sgroup.qq.com';
