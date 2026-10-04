/**
 * 角色卡出图 CLI（M2.47）：**从库里读真实角色**，出一张 PNG。
 *
 * 跑法：
 *   node scripts/render-card-cli.ts --db data/game.db --out build/cards
 *   node scripts/render-card-cli.ts --user <userId> --out build/cards
 *   node scripts/render-card-cli.ts --name 克莱恩 --out build/cards
 *
 * ## 为什么要有它（而不只是接进路由）
 *
 * 路由那条路要求「有人给机器人发指令」才跑得起来 —— 那样卡面一改就得等真人来试。
 * 这个 CLI 让**同一份组装逻辑**（`characterCardData`）可以离线跑：
 * 改完渲染器立刻能拿库里真实数据出图核对，不必起服务、不必等人发消息。
 * 出图链路与生产链路共用 `characterCardData` + `renderCharacterCard`，不存在两套。
 *
 * ## 与路由的分工
 *   本 CLI：选角色（读库）→ 查城市/教会名 → 算晋升率与闸门 → 组装 → 出图
 *   路由（后续）：同样的组装，只是头像来自消息头、图片由通道发出
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { characterCardData, type CardFacts } from '../src/card/contract.ts';
import { onebotAvatarUrl, officialAvatarUrl, resolveAvatarPath } from '../src/card/avatar.ts';
import { renderCharacterCard } from '../src/card/render.ts';
import { loadCities, loadChurches } from '../src/data/loader.ts';
import { computePromotionSuccess } from '../src/domain/character/rules.ts';
import { lossOfControlThresholdFor } from '../src/domain/character/rules.ts';
import { CharacterRepo } from '../src/infra/db/characters.ts';
import { openDatabase } from '../src/infra/db/sqlite.ts';
import type { CharacterState } from '../src/domain/character/types.ts';

interface Options {
  db: string;
  out: string;
  user?: string;
  name?: string;
  limit: number;
  /** 直接给一个头像直链；不给就按 --official-appid / --onebot 拼，都没有则画首字纹章 */
  avatar?: string;
  officialAppId?: string;
  onebot?: string;
  noAvatar: boolean;
  /** AI 出的卡面底图（见 docs/角色卡-卡面规范.md §3）。给了就不画程序化星盘 */
  background?: string;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    db: join(process.cwd(), 'data', 'game.db'),
    out: join(process.cwd(), 'build', 'cards'),
    limit: 200,
    noAvatar: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} 后面缺一个值`);
      i += 1;
      return value;
    };
    if (arg === '--db') options.db = next();
    else if (arg === '--out') options.out = next();
    else if (arg === '--user') options.user = next();
    else if (arg === '--name') options.name = next();
    else if (arg === '--limit') options.limit = Number(next());
    else if (arg === '--avatar') options.avatar = next();
    else if (arg === '--official-appid') options.officialAppId = next();
    else if (arg === '--onebot') options.onebot = next();
    else if (arg === '--no-avatar') options.noAvatar = true;
    else if (arg === '--background') options.background = next();
    else throw new Error(`不认识的参数：${arg}`);
  }
  return options;
}

/** 头像直链：官方 openid 优先，其次 OneBot 的 QQ 号；两者都没有就不带头像 */
function avatarUrlFor(state: CharacterState, options: Options): string | undefined {
  if (options.avatar) return options.avatar;
  if (options.officialAppId) return officialAvatarUrl(options.officialAppId, state.userId);
  if (options.onebot) return onebotAvatarUrl(options.onebot);
  return undefined;
}

/**
 * 文件名**只用 ASCII**。
 *
 * 为什么不是「保留中文」：这批文件要被人肉比对、贴进聊天、写进报告，ASCII 名最省事；
 * 而且它们会被交给外部进程（曾经是 PowerShell 5.1，现在是 Edge 无头）。
 * 角色名照样画在卡面上，只是不进文件名。
 */
function fileSafe(text: string): string {
  const ascii = text.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return (ascii.length > 0 ? ascii : 'x').slice(0, 40);
}

const options = parseArgs(process.argv.slice(2));
const db = openDatabase(options.db);
const repo = new CharacterRepo(db);

const cityName = new Map(loadCities().cities.map((city) => [city.id, city.name]));
const churchName = new Map(loadChurches().churches.map((church) => [church.id, church.name]));

let characters = repo.all();
if (options.user !== undefined) characters = characters.filter((c) => c.userId === options.user);
if (options.name !== undefined) characters = characters.filter((c) => c.name === options.name);
characters = characters.slice(0, options.limit);

if (characters.length === 0) {
  console.error(`库里没有匹配的角色（db=${options.db}）`);
  process.exit(1);
}

mkdirSync(resolve(options.out), { recursive: true });

let rendered = 0;
let withAvatar = 0;
const failures: string[] = [];

for (const state of characters) {
  const facts: CardFacts = {
    cityName: state.currentCityId ? cityName.get(state.currentCityId) : undefined,
    churchName: state.churchId ? churchName.get(state.churchId) : undefined,
    // 晋升率只对已入途径的人有意义：普通人没有序列，公式要求 sequence 非空
    promotionSuccess:
      state.pathway !== null && state.sequence !== null
        ? computePromotionSuccess({ dig: state.dig, mad: state.mad, cor: state.cor, sequence: state.sequence })
        : undefined,
    lossGate: lossOfControlThresholdFor(state.sequence),
  };

  if (!options.noAvatar) {
    const url = avatarUrlFor(state, options);
    if (url !== undefined) {
      const file = await resolveAvatarPath({ key: state.userId, url });
      if (file !== undefined) {
        facts.avatarPath = file;
        withAvatar += 1;
      }
    }
  }

  const data = characterCardData(state, facts);
  // 底图：显式给了就用它，否则按途径查 data/artwork/<pathway>.png（缺图退回程序化星盘）
  if (options.background !== undefined) data.backgroundPath = options.background;
  else {
    const art = join(process.cwd(), 'data', 'artwork', (state.pathway ?? 'mortal') + '.png');
    if (existsSync(art)) data.backgroundPath = art;
  }
  const file = join(resolve(options.out), `${fileSafe(state.name)}_${fileSafe(state.userId)}.png`);
  try {
    writeFileSync(file, renderCharacterCard(data));
    rendered += 1;
    const seqText = state.sequence === null ? '普通人' : `序列 ${state.sequence}`;
    console.log(`✓ ${file}  ${state.name} / ${state.pathway ?? 'mortal'} / ${seqText}${facts.avatarPath ? ' / 头像✓' : ''}`);
  } catch (error) {
    failures.push(`${state.name}: ${(error as Error).message}`);
  }
}

console.log(`\n出图 ${rendered}/${characters.length} 张（带头像 ${withAvatar}）→ ${resolve(options.out)}`);
if (failures.length > 0) {
  console.error(`失败 ${failures.length}：`);
  for (const f of failures) console.error('  ' + f);
  process.exitCode = 1;
}
