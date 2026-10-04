/**
 * 生物仓储（M2.8）：creature_species / creatures / sightings / creature_ticks。
 *
 * 四张表各管一件事：
 *   creature_species  物种模板（启动时从 YAML 覆盖式播种）
 *   creatures         生物实例（世界状态，跑在生态 tick 上）
 *   sightings         遭遇记录（审计）
 *   creature_ticks    生态 tick 的幂等表与水位线
 *
 * 判定层（domain/creature/*）不认识这里 —— 它只吃纯数据、吐纯数据。
 * 本文件的职责就是「把库里的东西变成纯数据」和「把纯数据写回库」。
 */
import type { Db } from './sqlite.ts';
import type {
  BehaviorTrigger,
  Creature,
  CreatureBehavior,
  CreatureDrop,
  CreatureHabit,
  CreatureRelations,
  CreatureSpecies,
  CreatureStatus,
  PerceptionLayer,
  SightingAction,
} from '../../domain/creature/types.ts';

const HOUR_MS = 60 * 60 * 1000;

/** 库里的 status 一定是这四个之一（迁移里有 CHECK 守着） */
function toStatus(value: unknown): CreatureStatus {
  const text = String(value ?? 'healthy');
  if (text === 'hungry' || text === 'evolving' || text === 'dying') return text;
  return 'healthy';
}

function parseJson<T>(raw: unknown, fallback: T): T {
  try {
    const parsed = JSON.parse(String(raw ?? ''));
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

/**
 * 把库里的 relations_json 解析成关系对象；NULL / 坏数据 / 空对象一律 undefined。
 *
 * 为什么空对象也当 undefined：内容表里没写 relations 的物种在库里是 NULL，
 * 而手写 INSERT（测试、审计脚本）可能写进一个空对象 —— 两者对判定层必须等价，
 * 否则同一个物种会因为"从哪张表读回来的"而表现不同。
 */
function relationsFromRow(raw: unknown): CreatureRelations | undefined {
  if (raw === null || raw === undefined) return undefined;
  const parsed = parseJson<Partial<CreatureRelations> | null>(raw, null);
  if (parsed === null || typeof parsed !== 'object') return undefined;
  return {
    role: (parsed.role ?? 'consumer') as CreatureRelations['role'],
    prey: Array.isArray(parsed.prey) ? parsed.prey.map(String) : [],
    predators: Array.isArray(parsed.predators) ? parsed.predators.map(String) : [],
    symbiosis: Array.isArray(parsed.symbiosis) ? parsed.symbiosis.map(String) : [],
    parasite: Array.isArray(parsed.parasite) ? parsed.parasite.map(String) : [],
  };
}

export class CreatureRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /* ---------------- 物种模板 ---------------- */

  /**
   * 从内容表播种物种模板（**覆盖式**，幂等）。
   *
   * 为什么每次启动都重写：物种表是「内容在库里的运行时副本」。
   * 内容同学改了 creatures.yaml，重启就该生效 —— 与 items/locations 一个口径。
   * 生物**实例**不受影响：它们只引用 species_id，名字和描述从模板现读。
   */
  seedSpecies(speciesList: readonly CreatureSpecies[], now: number): number {
    const stmt = this.#db.prepare(
      `INSERT INTO creature_species (
         id, name, base_sequence, habitat_json, pathway_affinity_json, drops_json,
         behaviors_json, habits_json, tick_rate, base_hp, flavor, perception_json,
         relations_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, base_sequence = excluded.base_sequence,
         habitat_json = excluded.habitat_json, pathway_affinity_json = excluded.pathway_affinity_json,
         drops_json = excluded.drops_json, behaviors_json = excluded.behaviors_json,
         habits_json = excluded.habits_json, tick_rate = excluded.tick_rate,
         base_hp = excluded.base_hp, flavor = excluded.flavor,
         perception_json = excluded.perception_json,
         relations_json = excluded.relations_json, updated_at = excluded.updated_at`,
    );
    for (const species of speciesList) {
      stmt.run(
        species.id,
        species.name,
        species.baseSequence,
        JSON.stringify(species.habitat),
        JSON.stringify(species.pathwayAffinity),
        JSON.stringify(species.drops),
        JSON.stringify(species.behaviors),
        JSON.stringify(species.habits),
        species.tickRate,
        species.baseHp,
        species.flavor,
        JSON.stringify(species.perception),
        /*
         * M2.58：关系网落库。没声明关系的物种写 NULL ——
         * 与空对象是两种不同的东西：NULL 读回来是 undefined（落回序列差规则），
         * 而 '{}' 会读成一个四条边全空的关系对象。写侧区分它们，读侧才分得清。
         */
        species.relations === undefined ? null : JSON.stringify(species.relations),
        now,
      );
    }
    return speciesList.length;
  }

  countSpecies(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM creature_species').get() as { n: number };
    return row.n;
  }

  /* ---------------- 生物实例 ---------------- */

  all(): Creature[] {
    const rows = this.#db
      .prepare('SELECT * FROM creatures ORDER BY id ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.#toCreature(row));
  }

  /** 某个地点此刻的生物（遭遇判定的候选池） */
  atLocation(locationId: string): Creature[] {
    const rows = this.#db
      .prepare('SELECT * FROM creatures WHERE location_id = ? ORDER BY id ASC')
      .all(locationId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.#toCreature(row));
  }

  byId(id: string): Creature | null {
    const row = this.#db.prepare('SELECT * FROM creatures WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.#toCreature(row) : null;
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM creatures').get() as { n: number };
    return row.n;
  }

  insertMany(creatures: readonly Creature[]): number {
    const stmt = this.#db.prepare(
      `INSERT OR REPLACE INTO creatures (
         id, species_id, location_id, sequence, hp, max_hp, status,
         age_hours, feed_count, last_fed_at, spawned_at, migrated_from
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const creature of creatures) {
      stmt.run(
        creature.id,
        creature.speciesId,
        creature.locationId,
        creature.sequence,
        creature.hp,
        creature.maxHp,
        creature.status,
        creature.ageHours,
        creature.feedCount,
        creature.lastFedAt,
        creature.spawnedAt,
        creature.migratedFrom,
      );
    }
    return creatures.length;
  }

  /** 只更新生态 tick 说「变了」的那些（changed 列表），其余一动不动 */
  updateMany(creatures: readonly Creature[], ids: readonly string[]): number {
    if (ids.length === 0) return 0;
    const keep = new Set(ids);
    const stmt = this.#db.prepare(
      `UPDATE creatures SET
         location_id = ?, sequence = ?, hp = ?, max_hp = ?, status = ?,
         age_hours = ?, feed_count = ?, last_fed_at = ?, migrated_from = ?
       WHERE id = ?`,
    );
    let count = 0;
    for (const creature of creatures) {
      if (!keep.has(creature.id)) continue;
      stmt.run(
        creature.locationId,
        creature.sequence,
        creature.hp,
        creature.maxHp,
        creature.status,
        creature.ageHours,
        creature.feedCount,
        creature.lastFedAt,
        creature.migratedFrom,
        creature.id,
      );
      count += 1;
    }
    return count;
  }

  deleteMany(ids: readonly string[]): number {
    if (ids.length === 0) return 0;
    const stmt = this.#db.prepare('DELETE FROM creatures WHERE id = ?');
    let count = 0;
    for (const id of ids) {
      const result = stmt.run(id);
      count += Number(result.changes);
    }
    return count;
  }

  #toCreature(row: Record<string, unknown>): Creature {
    return {
      id: String(row.id),
      speciesId: String(row.species_id),
      locationId: String(row.location_id),
      sequence: Number(row.sequence),
      hp: Number(row.hp),
      maxHp: Number(row.max_hp ?? row.hp),
      status: toStatus(row.status),
      ageHours: Number(row.age_hours ?? 0),
      feedCount: Number(row.feed_count ?? 0),
      lastFedAt: row.last_fed_at === null || row.last_fed_at === undefined ? null : Number(row.last_fed_at),
      spawnedAt: Number(row.spawned_at ?? 0),
      migratedFrom: row.migrated_from === null || row.migrated_from === undefined ? null : String(row.migrated_from),
    };
  }

  /* ---------------- 遭遇记录（审计） ---------------- */

  recordSighting(input: {
    id: string;
    characterId: string;
    creatureId: string;
    speciesId: string;
    layer: PerceptionLayer;
    seed: string;
    at: number;
  }): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO sightings
           (id, character_id, creature_id, species_id, layer, action, seed, harvest_json, resolved_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?)`,
      )
      .run(
        input.id,
        input.characterId,
        input.creatureId,
        input.speciesId,
        input.layer,
        input.seed,
        input.at,
      );
  }

  /**
   * **这个玩家见过这个物种吗**（M2.87）。
   *
   * 用来给「观察」一个**正反馈**：第一次看清某个物种与第二十次不是一回事。
   *
   * 为什么这件事重要（用户：「没有负面反馈和正向反馈，纯白开水？
   * 事件白开水等于游戏是废的」）：在这之前「观察」只付 MAD、什么也换不回来 ——
   * 而**在诡秘的世界观里，「知道」本身就是资源**。
   *
   * 判据是「这个 character 有没有留下过该 species 的目击记录」——
   * 不看 layer、不看动作：**看见过就是看见过**（哪怕是模糊的一团）。
   */
  hasSeenSpecies(characterId: string, speciesId: string): boolean {
    return this.sightingCountOf(characterId, speciesId) > 0;
  }

  /**
   * 这个玩家目击过某物种**几次**。
   *
   * ⚠️ **判「首见」必须用计数，不能用 `hasSeenSpecies`。**
   *
   * 因为 `creature-hooks.ts` 在**遭遇发生的那一刻**就写了目击记录（那是「他为什么
   * 没遇到」的唯一答案来源），等玩家选「观察」时那条记录早就在了 ——
   * 用 `hasSeenSpecies` 判首见会**永远为真**，于是每次观察都发首见奖励。
   *
   * 所以判据是 `count <= 1`：减掉本次那条，才是「在这之前见过没有」。
   */
  sightingCountOf(characterId: string, speciesId: string): number {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n FROM sightings WHERE character_id = ? AND species_id = ?')
      .get(characterId, speciesId) as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /** 这个玩家一共见过多少个物种（`.图鉴` 的「我的见闻」用它） */
  seenSpeciesCount(characterId: string): number {
    const row = this.#db
      .prepare('SELECT COUNT(DISTINCT species_id) AS n FROM sightings WHERE character_id = ?')
      .get(characterId) as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /**
   * 玩家此刻**未决**的那次遭遇（最近一条还没选动作的）。
   *
   * 遭遇是个未决状态：玩家没选动作之前，那只生物还站在那里 ——
   * 所以「谁此刻遇到了什么」是从这张表里读出来的，不放在角色身上
   * （放角色身上会让「换个地点探索」变成隐式地放弃上一次遭遇，而那是玩家没做的决定）。
   */
  openSighting(characterId: string): {
    id: string;
    creatureId: string;
    speciesId: string;
    layer: PerceptionLayer;
    seed: string;
    at: number;
  } | null {
    const row = this.#db
      .prepare(
        `SELECT id, creature_id, species_id, layer, seed, resolved_at
         FROM sightings WHERE character_id = ? AND action IS NULL
         ORDER BY resolved_at DESC LIMIT 1`,
      )
      .get(characterId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      creatureId: String(row.creature_id),
      speciesId: String(row.species_id),
      layer: String(row.layer) as PerceptionLayer,
      seed: String(row.seed ?? ''),
      at: Number(row.resolved_at ?? 0),
    };
  }

  /** 玩家选了动作之后回填（采集结果一起写） */
  resolveSighting(id: string, action: SightingAction, harvest: readonly { itemId: string }[]): void {
    this.#db
      .prepare('UPDATE sightings SET action = ?, harvest_json = ? WHERE id = ?')
      .run(action, harvest.length > 0 ? JSON.stringify(harvest) : null, id);
  }

  /** 最近的遭遇（虚拟玩家与报告用） */
  recentSightings(limit: number): Array<{ characterId: string; layer: string; action: string | null; seed: string }> {
    const rows = this.#db
      .prepare('SELECT character_id, layer, action, seed FROM sightings ORDER BY resolved_at DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      characterId: String(row.character_id),
      layer: String(row.layer),
      action: row.action === null || row.action === undefined ? null : String(row.action),
      seed: String(row.seed ?? ''),
    }));
  }

  countSightings(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM sightings').get() as { n: number };
    return row.n;
  }

  /** 感知层次分布（报告 §验收要求「感知分层分布」） */
  layerDistribution(): Map<string, number> {
    const rows = this.#db
      .prepare('SELECT layer, COUNT(*) AS n FROM sightings GROUP BY layer')
      .all() as Array<{ layer: string; n: number }>;
    return new Map(rows.map((row) => [row.layer, row.n]));
  }

  /* ---------------- 生态 tick 幂等 ---------------- */

  /** 抢占一个小时的生态 tick；返回 true 表示本次真的执行 */
  claimTick(tickKey: string, tickAt: number, executedAt: number, summary: Record<string, unknown>): boolean {
    const result = this.#db
      .prepare(
        `INSERT OR IGNORE INTO creature_ticks (tick_key, tick_at, executed_at, summary_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(tickKey, tickAt, executedAt, JSON.stringify(summary));
    return Number(result.changes) > 0;
  }

  hasTick(tickKey: string): boolean {
    return Boolean(this.#db.prepare('SELECT 1 AS ok FROM creature_ticks WHERE tick_key = ?').get(tickKey));
  }

  /** 水位线：最后结算过的那一格（键 + 它代表的整点毫秒） */
  lastTick(): { key: string; at: number } | null {
    const row = this.#db
      .prepare('SELECT tick_key, tick_at FROM creature_ticks ORDER BY tick_key DESC LIMIT 1')
      .get() as { tick_key: string; tick_at: number } | undefined;
    if (!row) return null;
    return { key: String(row.tick_key), at: Number(row.tick_at) };
  }

  /**
   * 回填这一小时的结算摘要。
   *
   * 为什么先 claim 再回填：claim 是幂等闸门（必须最早、且是原子的），
   * 而摘要要等生态跑完才知道。两次写同一行，代价是一次 UPDATE。
   */
  setTickSummary(tickKey: string, summary: Record<string, unknown>): void {
    this.#db
      .prepare('UPDATE creature_ticks SET summary_json = ? WHERE tick_key = ?')
      .run(JSON.stringify(summary), tickKey);
  }

  countTicks(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM creature_ticks').get() as { n: number };
    return row.n;
  }

  /**
   * 把每个 tick 的 summary 汇总起来 —— 报告里的「迁移次数 / 进化次数」直接读它，
   * 不需要再从历史状态反推（状态反推不出「发生过什么」）。
   */
  tickTotals(): Map<string, number> {
    const rows = this.#db.prepare('SELECT summary_json FROM creature_ticks').all() as Array<{
      summary_json: string;
    }>;
    const totals = new Map<string, number>();
    for (const row of rows) {
      const summary = parseJson<Record<string, number>>(row.summary_json, {});
      for (const [key, value] of Object.entries(summary)) {
        if (typeof value !== 'number') continue;
        totals.set(key, (totals.get(key) ?? 0) + value);
      }
    }
    return totals;
  }

  /** 物种模板（从库读回，供报告与「这只当时是什么」的审计） */
  speciesById(): Map<string, CreatureSpecies> {
    const rows = this.#db.prepare('SELECT * FROM creature_species').all() as Array<Record<string, unknown>>;
    const out = new Map<string, CreatureSpecies>();
    for (const row of rows) {
      const id = String(row.id);
      out.set(id, {
        id,
        name: String(row.name),
        baseSequence: Number(row.base_sequence),
        habitat: parseJson<string[]>(row.habitat_json, []),
        pathwayAffinity: parseJson<string[]>(row.pathway_affinity_json, []),
        drops: parseJson<CreatureDrop[]>(row.drops_json, []),
        behaviors: parseJson<CreatureBehavior[]>(row.behaviors_json, []),
        habits: parseJson<CreatureHabit[]>(row.habits_json, []),
        tickRate: String(row.tick_rate) === 'daily' ? 'daily' : 'hourly',
        baseHp: Number(row.base_hp),
        flavor: String(row.flavor ?? ''),
        perception: parseJson<Record<PerceptionLayer, string>>(row.perception_json, {
          blur: '',
          silhouette: '',
          full: '',
          advantage: '',
          essence: '',
        }),
        /*
         * M2.58：关系网。NULL / 解析不出 → **不带这个键**，读侧就是 undefined，
         * 判定层据此落回 M2.8 的序列差规则 —— 与"内容表里没写 relations"同一条路径。
         * 这里不能兜底成空关系对象：那会让老库里的物种凭空进入关系网，
         * 而关系网是纯加法的，空关系虽然不改判定，却会让报告显示"这个物种有声明"，
         * 那是一个只骗人不骗代码的错。
         */
        ...(relationsFromRow(row.relations_json) === undefined
          ? {}
          : { relations: relationsFromRow(row.relations_json) }),
      });
    }
    return out;
  }
}

/** 行为触发的白名单（schema 与库两侧共用一份，防止两边漂移） */
export const BEHAVIOR_TRIGGERS: readonly BehaviorTrigger[] = [
  'hpLow',
  'night',
  'fog',
  'hungry',
  'threatened',
  'always',
];

export { HOUR_MS };
