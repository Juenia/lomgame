/**
 * 角色卡服务（M2.47）：**路由层与渲染实现之间的那一层**。
 *
 * ## 为什么要分这一层
 *
 * 渲染要起 PowerShell 进程（约 300—500ms）、下载头像、读写文件 ——
 * 这些都不该出现在 `router/commands/` 里：
 *   · 路由层是纯业务编排，混进 IO 之后**测试必须起真进程**才能跑；
 *   · 通道能力（能不能发图）属于接入层，路由只该问「发出去了吗」。
 *
 * 所以路由只依赖 `CardService` 这个接口；测试给它一个假的，改一个字段就能断言结果。
 *
 * ## 降级是三条路，不是一条
 *   1. 能发图 → 发图；
 *   2. 发不了图 → 文本状态卡（`renderStatus`）+ 图片落盘的路径；
 *   3. 服务没配（无头像来源/无输出目录）→ 直接走第 2 条。
 * 三条路玩家都拿得到完整信息，这就是「降级是正常路径」的具体形态。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dataPath } from '../infra/paths.ts';
import { resolveAvatarPath } from './avatar.ts';
import { uploadCardImage, type GithubUploadConfig, type UploadProvider } from './uploader.ts';
import { characterCardData, type CardFacts } from './contract.ts';
import { renderCharacterCard } from './render.ts';
import type { CharacterState } from '../domain/character/types.ts';

export interface CardRequest {
  character: CharacterState;
  /** 调用方查好的事实（城市名 / 教会名 / 晋升率 / 闸门） */
  facts: CardFacts;
  /** 这个玩家此刻的头像直链；没有就不带 */
  avatarUrl?: string;
}

/**
 * 公网 URL 的三种来源。
 *
 * 调用方要靠它决定「这张图能不能写进 markdown 正文」：
 *   · `self-hosted`：服务自己的 `/cards/` 路由（部署方掌握域名）；
 *   · `github`：GitHub 仓库 + jsDelivr —— 同样**不需要部署方自建服务**，且实测 200 / image/png；
 *   · `upload`：第三方临时图床（uguu / picui …）—— **实测真机都会裂图**，不写进正文。
 */
export type PublicUrlSource = 'self-hosted' | 'github' | 'upload';

export interface CardOutcome {
  /** 卡片 PNG 字节 */
  png: Uint8Array;
  /** 落盘位置（发不出图时把路径告诉玩家；也用于排查） */
  path: string;
  /**
   * 公网可访问的 URL（配了 `CARD_PUBLIC_BASE_URL` 才有）。
   *
   * QQ 官方 Markdown 的图片要求「可在公网访问的资源 url」，平台会下载转存；
   * 本地文件路径对平台毫无意义，所以官方通道只认这个字段。
   */
  publicUrl?: string;
  /**
   * `publicUrl` 是哪来的（M2.45 第十三版）。
   *
   * 调用方**必须**知道这个：只有**自建托管**那条路（服务自己的 `/cards/` 路由）是可控的 ——
   * 域名由部署者掌握、不会过期；第三方图床（uguu）在真机上**验证过会破图**
   * （链接过期、平台抓取失败都会）。把图写进 markdown 正文之前，就是靠这一位决定的。
   */
  publicUrlSource?: PublicUrlSource;
  /** 这次是不是用上了头像（排查「为什么卡上是首字」用） */
  usedAvatar: boolean;
}

export interface CardService {
  /** 生成一张卡。失败抛错，由调用方决定怎么降级 */
  generate(request: CardRequest): Promise<CardOutcome>;
}

export interface CardServiceOptions {
  /** 出图目录；默认 `<cwd>/data/cards`（已被 .gitignore 的 /data/ 覆盖） */
  outDir?: string;
  /** 头像缓存目录 */
  avatarDir?: string;
  /**
   * 卡面底图目录：按途径取 `<pathway>.png`（mortal / seer / warrior / ...）。
   *
   * 见 docs/角色卡-卡面规范.md §3：美术由出图工具出，这里只负责把它铺上去。
   * 文件不存在就退回程序化星盘 —— **没有素材也是能出卡的**，不能因为缺图就报错。
   */
  artworkDir?: string;
  /** 头像缓存有效期 */
  avatarTtlMs?: number;
  /**
   * 卡片的公网基址（末尾斜杠会被归一化）。
   *
   * 有它 ⇒ 每张卡带 `<基址>/cards/<文件名>`；没它 ⇒ 只有本地路径，
   * 于是官方通道走文字降级（不报错）。HTTP 侧的静态路由见 main.ts 的 `/cards/`。
   */
  publicBaseUrl?: string;
  /**
   * 临时图床（默认不用）。见 uploader.ts 顶部对两条路的取舍。
   *
   * 只在**没有** publicBaseUrl 时生效：自建托管优先（数据不出自己的机器）。
   */
  uploadProvider?: UploadProvider;
  /**
   * `uploadProvider === 'github'` 时的仓库配置。
   *
   * 为什么把 GitHub 单列出来（而不是塞进 provider 字符串里）：它是**唯一一条不需要部署方
   * 自建服务**的持久外链方案 —— 一个仓库 + 一个 token，链接走 jsDelivr（国内有节点）。
   * 用户口径：「我要放行给用户用的，我自己整个腾讯云 COS 算怎么回事。」
   */
  githubUpload?: GithubUploadConfig;
  /** 注入上传实现，测试用（避免真打图床） */
  upload?: typeof uploadCardImage;
  /** 注入渲染函数，测试用（避免真起 PowerShell） */
  render?: (data: ReturnType<typeof characterCardData>) => Buffer;
  /**
   * 出图链路的日志口（可选）。
   *
   * 为什么需要：上传图床是这里唯一的外部依赖，它失败时**不抛错**（回落文字卡），
   * 于是「为什么官方通道没图」会变成一个只能靠猜的问题。
   */
  logger?: { info?: (message: string, meta?: Record<string, unknown>) => void; warn?: (message: string, meta?: Record<string, unknown>) => void };
}

/** 文件名**只用 ASCII**：这批文件要人肉比对、贴进聊天、写进报告，ASCII 名最省事 */
function fileSafe(text: string): string {
  const ascii = text.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return (ascii.length > 0 ? ascii : 'x').slice(0, 40);
}

export function createCardService(options: CardServiceOptions = {}): CardService {
  const outDir = resolve(options.outDir ?? dataPath('cards'));
  const render = options.render ?? renderCharacterCard;
  const upload = options.upload ?? uploadCardImage;
  // 归一化：拼接时不要再判断末尾有没有斜杠
  const publicBase = options.publicBaseUrl?.replace(/\/+$/, '');

  return {
    async generate(request: CardRequest): Promise<CardOutcome> {
      const facts: CardFacts = { ...request.facts };

      // 头像拿不到是常态（无网 / 平台没给 openid），失败就走首字纹章
      let usedAvatar = false;
      if (request.avatarUrl !== undefined && request.avatarUrl.length > 0) {
        const file = await resolveAvatarPath({
          key: request.character.userId,
          url: request.avatarUrl,
          dir: options.avatarDir,
          ttlMs: options.avatarTtlMs,
        });
        if (file !== undefined) {
          facts.avatarPath = file;
          usedAvatar = true;
        }
      }

      const data = characterCardData(request.character, facts);
      /*
       * 底图按途径取。**缺图不是错误**：existsSync 为假就退回程序化星盘，
       * 这样新开一条途径忘了出素材时，玩家拿到的是"朴素但完整"的卡，不是一张报错。
       */
      if (options.artworkDir !== undefined) {
        const art = join(options.artworkDir, (request.character.pathway ?? 'mortal') + '.png');
        if (existsSync(art)) data.backgroundPath = art;
      }
      const png = render(data);
      mkdirSync(outDir, { recursive: true });
      // 文件名带时间戳：同一个人反复出卡不互相覆盖，便于回溯「他当时是什么样」
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const fileName = `${fileSafe(request.character.name)}_${fileSafe(request.character.userId)}_${stamp}.png`;
      const path = join(outDir, fileName);
      writeFileSync(path, png);

      /*
       * 公网 URL 的两种来源，**自建托管优先**：
       *   1. 配了 CARD_PUBLIC_BASE_URL ⇒ 用服务自己的 /cards/ 路由（数据不出机器）；
       *   2. 没配、但配了图床 ⇒ 上传换一个临时 URL。
       * 两者都没有就只给本地路径，官方通道据此回落文字卡。
       */
      let publicUrl = publicBase !== undefined ? `${publicBase}/cards/${fileName}` : undefined;
      let publicUrlSource: PublicUrlSource | undefined =
        publicUrl !== undefined ? 'self-hosted' : undefined;
      if (publicUrl === undefined && options.uploadProvider !== undefined) {
        const uploaded = await upload(png, 'image/png', options.uploadProvider, {
          ...(options.githubUpload !== undefined ? { github: options.githubUpload } : {}),
        });
        if (uploaded !== undefined) {
          publicUrl = uploaded.url;
          // GitHub 与临时图床要分开记：前者能安全写进正文，后者真机会裂
          publicUrlSource = uploaded.provider === 'github' ? 'github' : 'upload';
          // 上传成功要留痕：出图链路上唯一一个"外部依赖"，排查时第一眼就要看到它
          options.logger?.info?.('[card] 已上传图床', {
            provider: uploaded.provider,
            url: uploaded.url,
          });
        } else {
          /*
           * 上传失败**必须出声**：它只表现为「官方通道没图、只剩文字」，
           * 而那条路上不会抛任何异常 —— 没有这条日志就只能靠耗时猜（真发生过）。
           */
          options.logger?.warn?.('[card] 图床上传失败，官方通道将回落文字卡', {
            provider: options.uploadProvider,
          });
        }
      }
      return {
        png,
        path,
        usedAvatar,
        ...(publicUrl !== undefined ? { publicUrl } : {}),
        ...(publicUrlSource !== undefined ? { publicUrlSource } : {}),
      };
    },
  };
}
