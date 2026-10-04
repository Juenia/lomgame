/**
 * 世界状态（M2.53）—— **只读**。
 *
 * 读的部分后端本来就齐全（WorldRepo / worldClock / WorldEventRepo），
 * 这里只是把它们摆到一屏里。
 *
 * ⚠️ 这个面板**故意不给任何写操作**。世界状态是全服共享的：推进一次 tick、
 * 改一个地点的天气，影响的是所有在线玩家，而现在没有「改动前快照 + 一键还原」。
 * 在没有回滚之前，后台只该看，不该动手 —— 想手动推进就去用 M2.39 的时间旅行端点
 * （它有 token 校验且会留档）。
 */
import { WorldRepo } from '../infra/db/world.ts';
/* M2.63：M2.58—M2.62 那几轮的运行状态与内容索引 */
import { ZoneStateRepo } from '../infra/db/zone-state.ts';
import { PowerStateRepo, PowerRelationRepo } from '../infra/db/power-state.ts';
import { BoundaryStateRepo } from '../infra/boundary-state.ts';
import { CausalRepo } from '../infra/causal-log.ts';
import { loadBoundaries, loadHistory, loadPowers, loadZones } from '../data/loader.ts';
import { historyEffects, HistoryIndex } from '../domain/world/history.ts';
import { boundaryEventTimes } from '../domain/world/boundary.ts';
import { createSeededRng, seedFrom } from '../domain/rng.ts';
import {
  BOUNDARY_KIND_CN,
  CAUSAL_RELATION_CN,
  POWER_TYPE_CN,
  RELATION_KIND_CN,
  SEAL_LEVEL_CN,
  STANCE_CN,
} from './schema.ts';
import { WorldEventRepo } from '../infra/db/world-events.ts';
import type { Db } from '../infra/db/sqlite.ts';
import { worldClock } from '../domain/world/clock.ts';
import { WORLD_EVENT_TYPE_LABELS } from '../domain/world/events.ts';
import { weatherLabel } from '../domain/world/weather.ts';

export interface WorldRow {
  locationId: string;
  locationName: string;
  weather: string;
  weatherLabel: string;
  since: number;
  until: number;
  pendingWeather: string | null;
  pendingAt: number | null;
}

export function worldView(db: Db, now: number) {
  const repo = new WorldRepo(db);
  const events = new WorldEventRepo(db);
  const clock = worldClock(now, repo.seed());

  /*
   * 天气要连地点名一起取，所以这里直接查表而不是走 weatherStates()
   * —— 后者只有 location_id，界面上一列 id 没人看得懂。
   */
  const raw = db
    .prepare(
      `SELECT w.location_id AS id, COALESCE(l.name, w.location_id) AS name,
              w.weather, w.since, w.until, w.pending_weather, w.pending_at
         FROM location_weather w LEFT JOIN locations l ON l.id = w.location_id
        ORDER BY w.location_id ASC`,
    )
    .all() as Array<Record<string, unknown>>;

  const rows: WorldRow[] = raw.map((r) => ({
    locationId: String(r['id']),
    locationName: String(r['name']),
    weather: String(r['weather']),
    weatherLabel: weatherLabel(String(r['weather']) as never),
    since: Number(r['since']),
    until: Number(r['until']),
    pendingWeather: r['pending_weather'] === null || r['pending_weather'] === undefined
      ? null : String(r['pending_weather']),
    pendingAt: r['pending_at'] === null || r['pending_at'] === undefined ? null : Number(r['pending_at']),
  }));

  const dist = new Map<string, number>();
  for (const r of rows) dist.set(r.weather, (dist.get(r.weather) ?? 0) + 1);

  const byType = new Map<string, number>();
  for (const e of events.latest(200)) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);

  return {
    readOnly: true,
    seed: repo.seed(),
    weatherDurationMs: repo.weatherDurationMs(),
    clock: { timeOfDay: clock.timeOfDay, moonPhase: clock.moonPhase, foggy: clock.foggy },
    ticks: {
      light: repo.countTicks('light'),
      heavy: repo.countTicks('heavy'),
      lastLight: repo.lastTick('light'),
      lastHeavy: repo.lastTick('heavy'),
    },
    weather: {
      rows,
      distribution: [...dist].map(([id, n]) => ({ id, label: weatherLabel(id as never), count: n })),
      pending: rows.filter((r) => r.pendingWeather !== null).length,
    },
    events: {
      live: events.live(now, 20),
      latest: events.latest(20),
      byType: [...byType].map(([type, n]) => ({
        type, label: WORLD_EVENT_TYPE_LABELS[type as never] ?? type, count: n,
      })),
      byVisibility: events.countByVisibility(),
    },
    groups: repo.groups().length,
    state: repo.state(),
    ecology: ecologyView(db),
    /*
     * M2.63：M2.58—M2.62 那五轮加进来的东西。
     *
     * 全部**只读** —— 与上面同一条纪律（世界状态全服共享、没有回滚）。
     * 摆上来的理由很直接：那几样东西会自己动，而在它们可见之前，
     * 「世界到底在不在动」只能靠读代码猜。
     */
    zones: zonesView(db, repo.seed(), now),
    powers: powersView(db, now),
    boundaries: boundariesView(db, repo.seed(), now),
    causal: causalView(db),
  };
}

/**
 * 生态（M2.8）—— 只读。
 *
 * 为什么要把它摆上来：原来世界面板只有天气和事件，生物完全看不见，
 * 于是「生态是不是也在定点刷新」只能靠猜。摆上来之后一眼就能看出问题 ——
 * 实测第一次打开就发现：**只有迁移在动，捕食 / 进化 / 死亡累计全是 0**。
 * 那不是「节奏不对」，那是这个子系统根本没跑起来。
 *
 * 累计那几行直接来自每次 tick 落下的 summary_json（creature-tick 写的），
 * 这里只做加总，不重新判定。
 */
function ecologyView(db: Db) {
  const rows = (sql: string): Array<Record<string, unknown>> =>
    db.prepare(sql).all() as Array<Record<string, unknown>>;

  const bySpecies = rows(
    `SELECT c.species_id AS id, COALESCE(s.name, c.species_id) AS name, COUNT(*) AS n
       FROM creatures c LEFT JOIN creature_species s ON s.id = c.species_id
      GROUP BY c.species_id ORDER BY n DESC`,
  ).map((r) => ({ id: String(r['id']), name: String(r['name']), count: Number(r['n']) }));

  const byLocation = rows(
    `SELECT c.location_id AS id, COALESCE(l.name, c.location_id) AS name, COUNT(*) AS n
       FROM creatures c LEFT JOIN locations l ON l.id = c.location_id
      GROUP BY c.location_id ORDER BY n DESC`,
  ).map((r) => ({ id: String(r['id']), name: String(r['name']), count: Number(r['n']) }));

  const byStatus = rows('SELECT status, COUNT(*) AS n FROM creatures GROUP BY status')
    .map((r) => ({ status: String(r['status']), count: Number(r['n']) }));

  const tickRows = rows(
    'SELECT tick_key, tick_at, executed_at, summary_json FROM creature_ticks ORDER BY tick_at DESC LIMIT 24',
  );

  const totals = { migrate: 0, feed: 0, evolve: 0, birth: 0, death: 0, replenish: 0 };
  const ticks = tickRows.map((r) => {
    let summary: Record<string, number> = {};
    try {
      summary = JSON.parse(String(r['summary_json'])) as Record<string, number>;
    } catch {
      summary = {};
    }
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
      totals[key] += summary[key] ?? 0;
    }
    return {
      tickKey: String(r['tick_key']),
      at: Number(r['tick_at']),
      executedAt: Number(r['executed_at']),
      summary,
    };
  });

  const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;

  return {
    species: one('SELECT COUNT(*) AS n FROM creature_species'),
    creatures: one('SELECT COUNT(*) AS n FROM creatures'),
    locations: byLocation.length,
    bySpecies,
    byLocation,
    byStatus,
    tickCount: one('SELECT COUNT(*) AS n FROM creature_ticks'),
    ticks,
    /** 最近 24 次 tick 的累计。全 0 的项说明那条链路根本没跑起来 */
    totals,
  };
}
/* ================================================================== *
 * M2.63：M2.58—M2.62 的世界状态 —— 只读
 * ================================================================== *
 *
 * 为什么要补这一节：那五轮往世界里加了很多**会自己动的东西**
 * （生态域参数、势力警觉、域恐慌、边界张力、因果图），
 * 而它们在后台一处都看不见 —— 「世界到底在不在动」只能靠读代码猜。
 *
 * ⚠️ 与这个文件其余部分同一条纪律：**只读**。
 * 世界状态是全服共享的，改一次影响所有在线玩家，而这里没有
 * 「改动前快照 + 一键还原」。想手动推进请用时间旅行端点（有 token 且留档）。
 */

/** 势力类型 → 中文 */
function powerTypeCn(type: string): string {
  return POWER_TYPE_CN[type] ?? type;
}

/** 势力对玩家的态度 → 中文 */
function stanceCn(stance: string): string {
  return STANCE_CN[stance] ?? stance;
}

/** 势力之间的关系：ally / hostile / debt */
function relationCn(kind: string): string {
  return RELATION_KIND_CN[kind] ?? kind;
}

/**
 * 因果边的关系：caused / responded / mutated（M2.60）。
 *
 * ⚠️ 与上面那个**不是同一套枚举** —— 势力关系里有 ally，因果边里没有；
 * 因果边里有 caused，势力关系里没有。混用会得到一堆原样回显的英文。
 */
function causalRelationCn(kind: string): string {
  return CAUSAL_RELATION_CN[kind] ?? kind;
}

/** 封印物危险等级 → 中文 */
function sealCn(level: string): string {
  return SEAL_LEVEL_CN[level] ?? level;
}

/** 一张「id → 显示名」的表，用来把库里的英文 id 翻成中文 */
function nameMap(db: Db, sql: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of db.prepare(sql).all() as Array<Record<string, unknown>>) {
    out.set(String(row['id']), String(row['name'] ?? row['id']));
  }
  return out;
}

/**
 * 生态域与域状态（M2.58）。
 *
 * 两张东西一起摆：zones.yaml 是内容（这个世界该是什么脾气），
 * zone_state 是状态（此刻实际攒了多少）。**不并排就看不出一致性** ——
 * 比如「某个域的恐慌涨到 1 之后有没有回落」只有在并列时才发现得了。
 */
function zonesView(db: Db, seed: string, now: number) {
  const stateRepo = new ZoneStateRepo(db);
  const fear = stateRepo.fearByZone();
  const state = stateRepo.all();
  const { zones } = loadZones(undefined, undefined);
  const byId = new Map(zones.map((zone) => [zone.id, zone]));

  const rows = [...fear].map(([zoneId, accumulated]) => {
    const zone = byId.get(zoneId);
    return {
      zoneId,
      name: zone?.name ?? zoneId,
      /** 内容里的基线气质（zones.yaml 的 fear） */
      fearBaseline: zone?.fear ?? 0,
      /** 运行时累积（zone_state.fear） */
      fearAccumulated: accumulated,
      /** 两者相加后夹在 1 以内 —— 判定层实际读的就是这个数 */
      fearEffective: Math.min(1, (zone?.fear ?? 0) + accumulated),
      sightings: state.get(zoneId)?.sightingCount ?? 0,
      lastSightingAt: state.get(zoneId)?.lastSightingAt ?? null,
      spirituality: zone?.spirituality ?? null,
      pollution: zone?.pollution ?? null,
      carryingCapacity: zone?.carryingCapacity ?? null,
    };
  });

  return {
    declared: zones.map((zone) => ({ id: zone.id, name: zone.name, locations: zone.locations.length })),
    rows,
    /*
     * 历史伤痕压出来的域参数偏移（M2.61）——
     * 「历史真的改变了世界吗」在后台的可见形式就是这一栏。
     */
    scars: historyEffects(loadHistory(undefined, {}).history).scars.map((scar) => ({
      location: scar.location,
      dangerBonus: scar.dangerBonus,
      because: scar.because,
      patch: scar.zonePatch,
    })),
    seed,
    now,
  };
}

/** 文明势力与它们的此刻状态（M2.59） */
function powersView(db: Db, now: number) {
  const states = new PowerStateRepo(db).all();
  const relations = new PowerRelationRepo(db).all();
  const { powers } = loadPowers(undefined, undefined);
  const byId = new Map(powers.map((power) => [power.id, power]));
  const historyIndex = new HistoryIndex(loadHistory(undefined, {}).history);

  const rows = powers.map((power) => {
    const state = states.get(power.id);
    return {
      id: power.id,
      name: power.name,
      typeLabel: powerTypeCn(power.type),
      stanceLabel: stanceCn(power.stance),
      homeRegion: power.home_region,
      goals: power.goals,
      /** 内容里的默认外交底图条数 */
      declaredRelations: power.relations.length,
      /** 运行时状态：警觉会涨会落 */
      alert: state?.alert ?? 0,
      reactionCount: state?.reactionCount ?? 0,
      lastReactionAt: state?.lastReactionAt ?? null,
      /** 它在历史里卷进过几件事（M2.61） */
      historyEvents: historyIndex.ofPower(power.id).map((event) => event.name),
    };
  });

  return {
    rows,
    relations: relations.map((relation) => ({
      from: relation.fromPowerId,
      fromName: byId.get(relation.fromPowerId)?.name ?? relation.fromPowerId,
      to: relation.toPowerId,
      toName: byId.get(relation.toPowerId)?.name ?? relation.toPowerId,
      kindLabel: relationCn(relation.kind),
      weight: relation.weight,
    })),
    /** 全部势力的反应次数之和（「这一轮谁真的动过」） */
    totalReactions: rows.reduce((n, row) => n + row.reactionCount, 0),
    now,
  };
}

/** 边界与外部势力（M2.62） */
function boundariesView(db: Db, seed: string, now: number) {
  const state = new BoundaryStateRepo(db).all();
  const { boundaries, foreignPowers } = loadBoundaries(undefined, {});
  const powerById = new Map(foreignPowers.map((power) => [power.id, power]));
  const names = nameMap(db, 'SELECT id, name FROM locations');

  const rows = boundaries.map((boundary) => {
    const record = state.get(boundary.id);
    const foreign = powerById.get(boundary.foreign_power);
    /*
     * 下一次事件在什么时候：用与判定层**同一个**时刻表函数算。
     * 后台自己另算一套的话，两边迟早会漂移，而那种漂移在界面上看不出来 ——
     * 界面说「还有 3 小时」，游戏里却是别的时间。
     */
    let nextAt: number | null = null;
    if (foreign !== undefined) {
      const times = boundaryEventTimes({
        boundaryId: boundary.id,
        basePressure: boundary.base_pressure,
        attention: foreign.attention,
        seed,
        upTo: now + 400 * 24 * 3_600_000,
        rollFor: (index) =>
          createSeededRng(seedFrom(['boundary-gap', seed, boundary.id, index])).next(),
      });
      nextAt = times.find((time) => time > now) ?? null;
    }
    return {
      id: boundary.id,
      name: boundary.name,
      kind: boundary.kind,
      kindLabel: BOUNDARY_KIND_CN[boundary.kind] ?? boundary.kind,
      location: boundary.location,
      locationName: names.get(boundary.location) ?? boundary.location,
      foreignName: foreign?.name ?? boundary.foreign_power,
      attention: foreign?.attention ?? 0,
      inputs: [...boundary.inputs],
      lastEventAt: record?.lastEventAt ?? null,
      lastKind: record?.lastKind ?? null,
      eventCount: record?.eventCount ?? 0,
      nextAt,
    };
  });

  return {
    rows,
    foreignPowers: foreignPowers.map((power) => ({
      id: power.id,
      name: power.name,
      fromRegion: power.from_region,
      attention: power.attention,
      threat: power.threat,
    })),
    totalEvents: rows.reduce((n, row) => n + row.eventCount, 0),
  };
}

/** 因果图与历史留下的东西（M2.60 / M2.61） */
function causalView(db: Db) {
  const causal = new CausalRepo(db);
  const byRelation = causal.countByRelation();

  const recent = (db
    .prepare('SELECT * FROM causal_nodes ORDER BY created_at DESC, id DESC LIMIT 20')
    .all() as Array<Record<string, unknown>>).map((row) => ({
    id: String(row['id']),
    kind: String(row['kind']),
    summary: String(row['summary'] ?? ''),
    intensity: Number(row['intensity'] ?? 0),
    createdAt: Number(row['created_at'] ?? 0),
  }));

  /*
   * 「哪个势力记得什么」—— 按 subject 分组数边。
   * 这是 M2.60 那句「哪个势力记得」的最小可读形式。
   */
  const bySubject = (db
    .prepare(
      'SELECT subject, COUNT(*) AS n FROM causal_edges ' +
      "WHERE subject IS NOT NULL AND subject <> '' GROUP BY subject ORDER BY n DESC LIMIT 20",
    )
    .all() as Array<Record<string, unknown>>).map((row) => ({
    subject: String(row['subject']),
    count: Number(row['n']),
  }));

  const facts = historyEffects(loadHistory(undefined, {}).history);

  return {
    nodes: causal.countNodes(),
    edges: causal.countEdges(),
    byRelation: Object.entries(byRelation).map(([relation, count]) => ({
      label: causalRelationCn(relation),
      count,
    })),
    recent,
    bySubject,
    /*
     * 历史留下的四份「现在」里，旧仇进了关系表、伤痕进了参数，
     * 而封印物与禁忌知识**目前只落数据、未接判定** ——
     * 后台把它们摆出来，是为了让「还有多少东西没接」这件事是看得见的。
     */
    sealed: facts.sealed.map((item) => ({
      location: item.location,
      what: item.what,
      levelLabel: sealCn(item.level),
      because: item.because,
    })),
    taboos: facts.taboos.map((item) => ({
      scope: item.scope,
      what: item.what,
      holder: item.holder,
      because: item.because,
    })),
  };
}