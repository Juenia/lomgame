/**
 * `koishi` 的最小类型桩。
 *
 * ## 为什么需要它
 *
 * 本仓库**没有** koishi 依赖（那是上游框架，不该塞进游戏仓库），
 * 但插件源码要能通过 `tsc` —— 否则"类型对不对"就只能靠肉眼。
 * 于是这里声明插件真正用到的那几样东西。
 *
 * ⚠️ 只在**没装 koishi** 时才该被解析到。真在 Koishi 项目里开发时，
 * 请删掉这个文件（或把插件复制出去）——真实的 `koishi` 类型比这里精确得多，
 * 而两边的声明会打架（TS 的 `declare module` 不会覆盖已存在的模块，
 * 但留着它容易让人以为这些就是全部 API）。
 */
declare module 'koishi' {
  export interface Author {
    id?: string;
    name?: string;
  }

  export interface Session {
    content?: string;
    userId: string;
    username?: string;
    channelId: string;
    guildId?: string;
    isDirect?: boolean;
    messageId?: string;
    timestamp?: number;
    author?: Author;
  }

  export interface Bot {
    selfId: string;
    sendMessage(channelId: string, content: unknown): Promise<unknown>;
    sendPrivateMessage?(userId: string, content: unknown): Promise<unknown>;
    /**
     * adapter 的内部接口（认证由它管）。QQ 官方通道上挂着富媒体上传那几步
     * （`uploadPrepareGuild` / `uploadPartFinishGuild` / `sendFileGuild` …）——
     * 见 index.ts 的 officialUploader。OneBot 上没有它，于是那条路自然不成立。
     */
    internal?: unknown;
  }

  export interface Logger {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
    /** 屏蔽名单命中这类「按设计就该安静」的事件走这里 —— 默认级别看不到，要查时再打开 */
    debug(message: string, meta?: Record<string, unknown>): void;
  }

  /** 只用到 put（分片上传）—— Koishi 的 http 是抛错式的，不抛就是成功 */
  export interface HttpService {
    put(url: string, data?: unknown, config?: { headers?: Record<string, string> }): Promise<unknown>;
  }

  export interface Context {
    logger: Logger;
    bots: Bot[];
    http: HttpService;
    on(event: 'message', listener: (session: Session) => void | Promise<void>): void;
    on(event: 'dispose' | 'ready', listener: () => void | Promise<void>): void;
  }

  /** schemastery 的最小形状：本插件只用到 string / number / boolean / object 与 default */
  export interface SchemaLike<T> {
    default(value: T): SchemaLike<T>;
    description(text: string): SchemaLike<T>;
    /** 控制台按它渲染控件：`role('textarea')` = 多行输入框（屏蔽群名单要一行一个） */
    role(role: string): SchemaLike<T>;
  }
  /** `Schema<T>` 作为类型用（Koishi 里值也是这个名字，两者在不同命名空间，可以共存） */
  export type Schema<T> = SchemaLike<T>;

  export interface SchemaStatic {
    string(): SchemaLike<string>;
    number(): SchemaLike<number>;
    boolean(): SchemaLike<boolean>;
    object<T>(shape: { [K in keyof T]: SchemaLike<T[K]> }): SchemaLike<T>;
  }
  export const Schema: SchemaStatic;

  /** 消息元素工厂（只用到图片） */
  export function h(type: string, attrs?: unknown, children?: unknown): unknown;
  export namespace h {
    function image(source: string | ArrayBuffer | Uint8Array): unknown;
  }
}
