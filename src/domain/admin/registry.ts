/**
 * **谁是管理员**（M2.172）。
 *
 * ## 三个来源，取并集
 *
 *   .env 的 ADMIN_IDS   运营在后台「服务与访问」里填，一行一个（也认逗号 / 空格分隔）
 *   .env 的 ADMIN_QQ    封测期就有的单个管理员，继续认，不用改配置
 *   上游插件上报        koishi 插件设置窗口 / BEE 插件配置里填的，启动时 POST 给内核
 *
 * 为什么是并集而不是「后者覆盖前者」：这三个来源的**所有者不同** ——
 * .env 是游戏机的，插件配置是机器人框架的。任何一方都不该把另一方的名单抹掉。
 *
 * ## 为什么要有上游这一路
 *
 * 管理员是**在 QQ 上按 QQ 号认的**，而 QQ 号只有上游框架知道得最清楚（尤其官方通道的
 * openid）。让运营在机器人那侧就能配，比要求他们去改游戏机的 .env 更顺手 ——
 * 但那一路是「上报」，不是「权威」：内核自己仍能独立判定，插件挂了也不影响。
 *
 * ## 一个身份只在一种通道里有效
 *
 * OneBot 下 userId 是 QQ 号，官方通道下是 openid —— 两者不通用。
 * 名单里两边都写上即可；匹配用的是**逐字相等**，不做任何猜测。
 */

/** 解析一行一个 / 逗号 / 空格分隔的名单，去空、去重、保持原序 */
export function parseAdminIds(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\s,;，；]+/)) {
    const id = part.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export interface AdminEntry {
  userId: string;
  /** 这个 id 从哪来：env / upstream:<platform> */
  source: string;
}

export class AdminRegistry {
  #env = new Set<string>();
  /** 上游上报的名单，按平台分开存 —— 一个插件挂掉不该让另一个的名单消失 */
  #remote = new Map<string, Set<string>>();

  /** 从环境变量装载（启动时调一次；后台改完 .env 后也可以再调） */
  loadEnv(env: NodeJS.ProcessEnv): void {
    this.#env = new Set(parseAdminIds(env.ADMIN_IDS));
    const single = env.ADMIN_QQ?.trim();
    if (single !== undefined && single !== '') this.#env.add(single);
  }

  /** 上游插件上报（同一个平台重复上报 = 覆盖它自己那一路） */
  setRemote(platform: string, ids: readonly string[]): void {
    this.#remote.set(platform, new Set(ids.map((id) => id.trim()).filter((id) => id !== '')));
  }

  isAdmin(userId: string): boolean {
    if (this.#env.has(userId)) return true;
    for (const ids of this.#remote.values()) if (ids.has(userId)) return true;
    return false;
  }

  /** 后台与 .管理 菜单要看的一览 */
  list(): AdminEntry[] {
    const out: AdminEntry[] = [];
    const seen = new Set<string>();
    for (const id of this.#env) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ userId: id, source: 'env' });
    }
    for (const [platform, ids] of this.#remote) {
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ userId: id, source: 'upstream:' + platform });
      }
    }
    return out;
  }

  /** 环境变量这一路有几个（后台显示用；不含上游上报） */
  envCount(): number {
    return this.#env.size;
  }
}
