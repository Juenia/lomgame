/**
 * 权柄的**应用**（M2.76）—— 把内容表里的一条权柄变成一次真实的世界状态改写。
 *
 * ## 它只做一件事
 *
 * 往**覆盖层**（\`world_overrides\`，迁移 0032）写一条有期限的天气覆盖。
 * 之后所有读天气的地方都会先看到它 —— 因为读路径只有一处
 * （\`WorldRepo.weatherOf\`），优先级也在那一处写死。
 *
 * ## 为什么不在这里播报
 *
 * 播报是**另一条边**（world_events），而它的形状与本模块无关：
 * 有些触发方已经有播报管道（世界 tick），有些没有（后台手动）。
 * ⇒ 本模块保持「只改状态」，播报由调用方按自己的管道发 —— 这样两条边各自可测。
 *
 * ## 到期
 *
 * \`until\` 一到，覆盖**自动失效**：读的时候带 \`until > now\`，不需要清理任务。
 * 这一条是刻意的 —— 需要清理的覆盖层会在「忘了清理」时留下永久天气。
 */
import type { AuthorityDef } from '../domain/world/authority.ts';
import { weightedPick } from '../domain/random.ts';
import type { Rng } from '../domain/character/types.ts';
import type { WorldRepo } from './db/world.ts';

const HOUR_MS = 3_600_000;

/**
 * 把一条权柄落到世界上，返回它的到期时刻。
 *
 * ## M2.87：从「只改天气」扩展成通用改写
 *
 * 在这之前这个函数只写**一条** `kind: 'weather'` 的覆盖 ——
 * 也就是说权柄改写的只有天气（用户点出的：「权柄改写的只有天气？」）。
 *
 * 而 `world_overrides` 表本来就有通用的 `kind` 列，只是从来没人写过第二个值。
 * 现在按 `authority.effects` 逐条写，天气仍然是其中之一（且有它自己的位置，
 * 因为它有专属的读取点 `overrideWeatherOf`）。
 *
 * ⚠️ **写入与读取必须成对**。只加数据不加读点，症状是「内容写了、世界没变」——
 * 不报错、日志里也看得见那条权柄事件。所以每加一个 kind，都要在
 * `WORLD_OVERRIDE_READERS` 里留下它被谁读的证据（见 domain/world/authority.ts）。
 */
export function applyAuthority(world: WorldRepo, authority: AuthorityDef, now: number): number {
  const until = now + Math.round(authority.duration_hours * HOUR_MS);
  // 天气：一直有（schema 里它是必填），走它自己的读取点
  world.setOverride(
    {
      kind: 'weather',
      scope: authority.scope,
      value: authority.weather,
      until,
      source: 'authority:' + authority.id,
    },
    now,
  );
  // 其余改写维度
  for (const effect of authority.effects) {
    world.setOverride(
      {
        kind: effect.kind,
        scope: effect.scope ?? authority.scope,
        value: effect.value,
        until,
        source: 'authority:' + authority.id,
      },
      now,
    );
  }
  return until;
}

/**
 * 抽一条权柄。
 *
 * ## M2.91：**两级等权** —— 先抽途径，再抽该途径里的权柄
 *
 * 原来是一级等权（在全部权柄里平抽一条）。那时「一条途径 = 一条权柄」，
 * 所以「权柄等权」与「途径等权」恰好是同一件事。
 *
 * 而权柄表正要从 22 条扩到「每条途径好几条」（原作里愚者一系就有愚弄 / 重组 /
 * 奇迹 / 历史 / 变形 / 空间）。一旦条数不均，一级等权就会让**权柄多的途径更常出手**
 * —— 那不是设计，是数据条数的副作用：内容同学给某条途径多写两条权柄，世界就偏心了。
 *
 * 所以先按途径等权抽一次，再在该途径内等权抽。22 条时两者逐位等价（每条途径恰好一条），
 * 扩表之后才真正开始起作用。
 *
 * ⚠️ 它比原来**多消耗一次** `rng.next()`。安全：调用点用的是独立种子的 rng
 * （`seedFrom([seed, 'authority', targetHour])`），不与天气 / 事件共享随机流。
 */
export function pickAuthority(authorities: readonly AuthorityDef[], rng: Rng): AuthorityDef | null {
  if (authorities.length === 0) return null;
  const byPathway = new Map<string, AuthorityDef[]>();
  for (const authority of authorities) {
    const list = byPathway.get(authority.pathway);
    if (list === undefined) byPathway.set(authority.pathway, [authority]);
    else list.push(authority);
  }
  // 排序：同一份数据 + 同一个种子，在任何进程里都要抽到同一条
  const pathways = [...byPathway.keys()].sort();
  const index = Math.min(pathways.length - 1, Math.floor(rng.next() * pathways.length));
  return weightedPick(byPathway.get(pathways[index]!)!, () => 1, rng);
}
