/**
 * 数据编辑的读写层（M2.49）。
 *
 * ## 用 Document API 而不是 parse / stringify
 *
 * src/data/*.yaml 里大量的注释是**设计记录**（「M2.19：水手序列 9 的主材料 ——
 * 与上面那件地域物产是两件东西」）。yaml.parse 成对象再 stringify 回去，
 * 注释全丢，下一个读这个文件的人就不知道那些物品为什么长这样。
 * 所以走 parseDocument：改哪一项就改哪一项，其余原样保留。
 *
 * ## 每次写入先备份
 *
 * 这是**全服内容**。改错一个数字，所有玩家下一次判定都会受影响，
 * 而且未必立刻看得出来。备份落在 data/backups/，按时间戳命名。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseDocument, type Document, type YAMLMap } from 'yaml';
import type { EntitySpec, FieldSpec } from './schema.ts';
import { entityById, tagFieldOf, validateField } from './schema.ts';
import { COND_STATUSES, isValidCond, parseCond } from '../domain/event/trigger.ts';

export interface DataRow {
  id: string;
  /**
   * 这一条的**中文显示名**（取 titleKey 那个字段的值）。
   *
   * ⚠️ 有些实体的 titleKey 就是 id（routes 那种没有中文名的表），
   * 于是 title === id —— 前端把两者拼成「中文名（id）」时要判重，
   * 否则那一列会显示成 `tingen-backlund（tingen-backlund）`。
   */
  title: string;
  /** 列表页要显示的几个关键字段（已经是中文） */
  summary: string;
  /**
   * 这一条的**分类**（M2.90）—— 取 kind 字段的**英文 id 原值**，不给中文。
   *
   * 为什么原样给：列表页顶部那排筛选 chips 要的形状是「一组值 + 各多少条」，
   * 而中文名由前端从**同一份字段元数据**（enumMap）派生 —— 服务端再翻一次
   * 就等于有了第二份中文表，两处必然漂移（AGENTS §3.1）。
   *
   * 该实体没有分类字段、或这一条没填时不带这个键。
   */
  tag?: string;
}

/**
 * 这个实体的记录分布在**哪些文件**里（M2.76）。
 *
 * 除 dir 模式外都只有一个文件；dir 模式下一个文件一条记录。
 *
 * ⚠️ 必须排序。readdirSync 的顺序**不保证**（不同文件系统不一样），
 * 而列表页顺序一跳，运营就会以为自己的内容丢了 —— 这是最没必要的一种惊吓。
 */
function recordFiles(root: string, spec: EntitySpec): { file: string; path: string }[] {
  const base = resolve(root, spec.file);
  if (spec.rootMode !== 'dir') return [{ file: spec.file, path: base }];
  if (!existsSync(base)) throw new Error('找不到数据目录：' + spec.file);
  return readdirSync(base).filter((f) => f.endsWith('.yaml')).sort()
    .map((f) => ({ file: spec.file + '/' + f, path: join(base, f) }));
}

/**
 * seq / map 模式必须有 rootKey。
 *
 * 类型上它是可选的（single / dir 用不到），所以在这里补一道运行时闸门：
 * 万一哪天有人把一个 single 实体的 rootMode 写错，报错要指向**这个实体**，
 * 而不是「undefined 上没有 get」这种看不出所以然的话。
 */
function rootKeyOf(spec: EntitySpec): string {
  if (spec.rootKey === undefined) {
    throw new Error('实体 ' + spec.id + ' 是 ' + String(spec.rootMode) + ' 模式，却在找 rootKey');
  }
  return spec.rootKey;
}

/** 取根键下面的列表（YAMLSeq） */
function seqOf(doc: Document, spec: EntitySpec): YAMLMap[] {
  const seq = doc.get(rootKeyOf(spec)) as { items?: YAMLMap[] } | undefined;
  return (seq?.items ?? []).filter((n): n is YAMLMap => typeof (n as YAMLMap).get === 'function');
}

const asText = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

/**
 * strlist 在列表页的样子（M2.77）。
 *
 * **有中文映射时把映射后的值列出来**：「可用途径 占卜家 / 不眠者 / 神秘学家」一眼就知道
 * 这座城市能走什么路，而「可用途径 4 项」什么也没说 —— 运营得点进去才知道。
 *
 * 没有映射的（locations.events 那种一列几百个卡片 id）仍然只说数量：列出来会把摘要撑爆。
 */
function strlistSummary(f: FieldSpec, v: unknown[]): string {
  if (f.valueMap === undefined) return v.length + ' 项';
  if (v.length === 0) return '（空）';
  const names = v.slice(0, 4).map((x) => f.valueMap?.[String(x)] ?? String(x));
  return names.join(' / ') + (v.length > 4 ? ' 等 ' + v.length + ' 项' : '');
}
/** YAML 节点 → JS 值（node.get 返回的是节点，不是值，见 listEntity 的注释） */
const json = (v: unknown): unknown => (v as { toJSON?: () => unknown } | undefined)?.toJSON?.() ?? v;

/**
 * 一条记录在 YAML 里的句柄（M2.76）。
 *
 * 两种**根形状**统一成同一件事：有一个 id，且能按字段名读写一个值。
 *
 *   rootMode 'seq'（默认）—— 根键下面是对象数组，一条记录一个对象，
 *                            id 取自 idKey 那个字段（历史上所有实体）
 *   rootMode 'map'        —— 根键下面是「键 → 值」，一条记录一个键。
 *                            id **就是键名**，fields 里除 idKey 外的那一个字段承载值。
 *
 * 为什么值得抽出来：不然 listEntity / readEntity / writeEntity 三处各写一遍
 * 「seq 怎么找、map 怎么找」—— 三份分支一定会漂移，而漂移的表现是
 * 「列表页看得到、点进去打不开」这种半坏状态。
 *
 * 用到 map 的两张表都是长文案池：失控文本（途径 → 10 条）、卡片片段（片段名 → 若干条）。
 * 它们天生是「一个键配一组文本」，硬塞进对象数组就得给每条文本编一个 id —— 
 * 那个 id 没有任何意义，还得跟着文本一起维护。
 */
interface Rec {
  id: string;
  get(key: string): unknown;
  has(key: string): boolean;
  set(key: string, value: unknown): void;
  del(key: string): void;
}

function recordsOf(doc: Document, spec: EntitySpec): Rec[] {
  /*
   * single：**整份文件就是一条记录**（群规则、封测公告、内容注册表）。
   *
   * 它没有 id —— 用实体自己的 id 当记录的 id，列表页只有一行。
   * 读写的 target 是文档根部：Document 本身就有 get / set / delete。
   */
  if (spec.rootMode === 'single' || spec.rootMode === 'dir') {
    return [{
      // dir 模式的每个文件里都写着 id；single 的记录 id 就是实体 id
      id: spec.rootMode === 'single' ? spec.id : (asText(json(doc.get(spec.idKey ?? ''))) || spec.id),
      get: (key: string) => json(doc.get(key)),
      has: (key: string) => doc.get(key) !== undefined,
      set: (key: string, value: unknown) => doc.set(key, value),
      del: (key: string) => { doc.delete(key); },
    }];
  }
  if (spec.rootMode !== 'map') {
    return seqOf(doc, spec).map((node) => ({
      id: asText(node.get(spec.idKey ?? '')),
      get: (key: string) => json(node.get(key)),
      has: (key: string) => node.get(key) !== undefined,
      set: (key: string, value: unknown) => node.set(key, value),
      del: (key: string) => { node.delete(key); },
    }));
  }
  const root = doc.get(rootKeyOf(spec)) as YAMLMap | undefined;
  // 除 idKey 外的那一个字段承载值 —— map 根的记录只有一个字段，多的没地方放
  const valueKey = spec.fields.find((f) => f.key !== spec.idKey)?.key ?? '';
  return ((root?.items ?? []) as { key: unknown; value: unknown }[]).map((pair) => {
    const key = asText(json(pair.key));
    return {
      id: key,
      get: (k: string) => (k === spec.idKey ? key : k === valueKey ? json(pair.value) : undefined),
      has: (k: string) => k === spec.idKey || (k === valueKey && pair.value !== undefined),
      /*
       * idKey 的写入是**空操作**：改「哪条途径」等于改键名，而键名是这个池子的
       * 唯一坐标 —— 判定层按途径 id 取文本。界面上它本来就是只读的，
       * 这里再挡一次，免得将来有人放开它、把文本挪到另一条途径上而不自知。
       */
      set: (k: string, value: unknown) => {
        if (k === valueKey && root !== undefined) root.set(key, value);
      },
      del: (k: string) => {
        if (k === valueKey && root !== undefined) root.delete(key);
      },
    };
  });
}

/**
 * 列表页：一条记录一行，附一段中文摘要。
 *
 * ⚠️ 两个坑都在这里踩过：
 *   1. node.get(key) 返回的是 **YAML 节点**，不是 JS 值 —— 直接 Array.isArray 全是 false，
 *      于是 rows/strlist 会退化成打印整个 JSON。必须先 toJSON()。
 *   2. ref 类型存的是**别的实体的 id**（cities 里的 tingen），摘要里要翻成那个实体的显示名，
 *      否则界面上全是英文 id —— 与「英文分类做好中文映射」这条相违背。
 */
export function listEntity(root: string, spec: EntitySpec): DataRow[] {
  // id → 显示名，按需建一次（引用目标都是小表，几十条）
  const refCache = new Map<string, Map<string, string>>();
  const refName = (entityId: string, id: string): string => {
    let map = refCache.get(entityId);
    if (map === undefined) {
      map = new Map();
      const target = entityById(entityId);
      if (target !== undefined) {
        try {
          for (const r of listEntity(root, target)) map.set(r.id, r.title);
        } catch { /* 目标文件坏了不该连带把这一页打挂 */ }
      }
      refCache.set(entityId, map);
    }
    return map.get(id) ?? id;
  };

  // 分类字段算一次、整表共用：它只取决于实体，不取决于记录（M2.90）
  const tagKey = tagFieldOf(spec)?.key ?? null;

  return scanRecords(root, spec).map(({ rec }) => {
    const id = rec.id;
    // single 模式没有 title 字段，回退到实体自己的中文名（而不是英文 id）
    const raw = asText(rec.get(spec.titleKey ?? '')) || (spec.rootMode === 'single' ? spec.label : id);
    // map 根的 id 是英文键名（途径 id），列表页要显示中文 —— 与枚举同一条口径
    const title = spec.titleMap?.[raw] ?? raw;
    const bits = new Map<string, string>();
    for (const f of spec.fields) {
      if (f.key === spec.idKey || f.key === spec.titleKey) continue;
      if (f.type === 'readonly') continue;   // 嵌套结构塞进摘要只会是一坨 JSON
      const v = rec.get(f.key);
      /*
       * object 只展开**枚举子字段**一层（卡片的 trigger.type 就是它）。
       * 全展开会把摘要撑爆；完全不展开则列表页看不到「这张卡是每日还是随机」——
       * 而那正是扫一眼列表时最想知道的事。
       *
       * ⚠️ M2.90：**触发条件（condlist）也要展开**。
       *
       * 序列专属卡有 511 张，列表页原来每行的摘要是「触发方式 每日 · 效果 3 条」——
       * 而它们唯一的区别就在 cond 里（`pathway:sun` + 序列区间）。
       * 摘要里看不到它，运营要在 511 行里找「太阳途径序列 8 的那张」就只能靠 id 猜。
       * 条件为空的卡不占位（否则「触发条件 无条件」会白占一格）。
       */
      if (f.type === 'object') {
        const obj = (v !== null && typeof v === 'object' ? v : {}) as Record<string, unknown>;
        const parts: string[] = [];
        for (const c of f.objectFields ?? []) {
          const cv = obj[c.key];
          if (cv === undefined || cv === null) continue;
          if (c.type === 'enum' && c.enumMap !== undefined) {
            parts.push(c.label + ' ' + (c.enumMap[String(cv)] ?? String(cv)));
            continue;
          }
          if (c.type === 'condlist' && Array.isArray(cv) && cv.length > 0) {
            const list = cv.map((x) => String(x));
            parts.push(c.label + ' ' + list.slice(0, 2).join('、') +
              (list.length > 2 ? ' 等 ' + list.length + ' 条' : ''));
          }
        }
        // 整个 object 占**一个**位：展开成好几段会把后面真正想看的字段挤出摘要
        if (parts.length > 0) bits.set(f.key, parts.join(' · '));
        continue;
      }
      if (v === undefined || v === null || v === '') continue;
      const shown =
        f.type === 'bool' ? (v === true ? '是' : '否')
        : f.type === 'enum' && f.enumMap !== undefined ? (f.enumMap[String(v)] ?? String(v))
        : f.type === 'ref' && f.ref !== undefined ? refName(f.ref, String(v))
        // 列表类字段在摘要里说"几行/几项"就够了，逐条铺开会把一行撑爆
        : f.type === 'rows' && Array.isArray(v) ? (v.length + ' 行')
        : f.type === 'strlist' && Array.isArray(v) ? strlistSummary(f, v)
        : f.type === 'map' && typeof v === 'object' ? (Object.keys(v).length + ' 项')
        : f.type === 'maplist' && Array.isArray(v) ? (v.length + ' 条')
        : f.type === 'condlist' && Array.isArray(v) ? (v.length === 0 ? '无条件' : v.slice(0, 2).join('、') + (v.length > 2 ? ' 等 ' + v.length + ' 条' : ''))
        : String(v);
      bits.set(f.key, f.label + ' ' + shown);
    }
    /*
     * 摘要显示哪三个：实体声明了 summaryKeys 就按它来，否则就是字段表里的前三个。
     *
     * 为什么需要声明：关键词未必排在前面。城市的「可用途径」写在第四个字段上，
     * 默认摘要里根本露不出来 —— 而「这座城市能走哪几条路」正是打开城市列表时
     * 要判断的第一件事。写死成「前三个」等于让字段顺序替内容做决定。
     */
    const order = spec.summaryKeys ?? [...bits.keys()];
    const tag = tagKey === null ? '' : asText(rec.get(tagKey));
    return {
      id,
      title,
      summary: order.map((k) => bits.get(k))
        .filter((x): x is string => x !== undefined).slice(0, 3).join(' · '),
      ...(tag === '' ? {} : { tag }),
    };
  });
}

/** 一条记录 + 它住在哪个文件（写回和备份都要按**记录自己那个文件**来，不能都用 spec.file） */
interface Located {
  rec: Rec;
  /** 相对 root 的路径，人看的（报错、备份日志） */
  file: string;
  /** 绝对路径，写回用的 */
  path: string;
  /** 这个记录所属的文档 —— 改它、再写它 */
  doc: Document;
}

/**
 * 扫描这个实体的**全部**记录（跨文件）。
 *
 * 单文件实体也走这里：一条路比分两条更不容易漂移，代价只是多一层循环。
 *
 * ⚠️ 对 dir 模式（事件卡，137 个文件）这是一次「读目录 + 全部 parse」，
 * 实测约 70ms —— 列表页和「打开一张卡」都要走它，可接受。
 * 如果哪天卡片涨到上千张，再按 id 反查文件名（id 与文件名同名的约定）来省这一步；
 * 现在不做：**多一条只在性能出问题时才需要的路径，就多一处会漂移的分支**。
 */
function scanRecords(root: string, spec: EntitySpec): Located[] {
  const out: Located[] = [];
  for (const f of recordFiles(root, spec)) {
    if (!existsSync(f.path)) throw new Error('找不到数据文件：' + f.file);
    const doc = parseDocument(readFileSync(f.path, 'utf8'));
    for (const rec of recordsOf(doc, spec)) out.push({ rec, file: f.file, path: f.path, doc });
  }
  return out;
}

/** 取一条记录的原始字段（值保持 yaml 的原始类型，前端按字段类型渲染控件） */
export function readEntity(root: string, spec: EntitySpec, id: string): Record<string, unknown> | null {
  const found = scanRecords(root, spec).find((l) => l.rec.id === id);
  if (found === undefined) return null;
  const rec = found.rec;
  const out: Record<string, unknown> = {};
  for (const f of spec.fields) {
    if (rec.has(f.key)) out[f.key] = rec.get(f.key);
  }
  return out;
}


/**
 * 一次性读出某个实体的**全部记录**（M2.83）。
 *
 * 为什么需要它：`listEntity` + `readEntity` 是「每条记录扫一遍文件」——
 * 对 948 条物品就是 948 次全文件解析。列表页一次只读一个实体，够用；
 * 而「把全部内容跑一遍」的体检会因此慢到没人愿意跑（实测 1862 条要两分半）。
 *
 * 这个函数只扫**一次**。
 */
export function readAll(
  root: string, spec: EntitySpec,
): Array<{ id: string; row: Record<string, unknown> }> {
  return scanRecords(root, spec).map(({ rec }) => {
    const row: Record<string, unknown> = {};
    for (const f of spec.fields) {
      if (rec.has(f.key)) row[f.key] = rec.get(f.key);
    }
    return { id: rec.id, row };
  });
}

/** 建一个跨表校验的上下文（一次体检共用一份，缓存才有效） */
export const newCrossCtx = (root: string): CrossCtx => {
  const cc: CrossCtx = { root, ids: new Map() };
  cc.ids.set('__flags__', loadFlagSet(root));
  return cc;
};

/**
 * **只校验、不写盘**（M2.83）。
 *
 * 与 writeEntity 分开，是因为那个函数还要备份、还要写文件 ——
 * 而「拿全部内容跑一遍」只想知道「有没有过不了校验的」。
 * 校验逻辑本身不走两条路：两边调的是同一对 validateField / crossCheck。
 */
export function checkRecord(
  cc: CrossCtx, spec: EntitySpec, patch: Record<string, unknown>,
): string | null {
  const fields = new Map<string, FieldSpec>(spec.fields.map((f) => [f.key, f]));
  for (const [key, raw] of Object.entries(patch)) {
    const field = fields.get(key);
    if (field === undefined || field.readOnly === true) continue;
    const bad = validateField(field, raw);
    if (bad !== null) return bad;
    const cross = crossCheck(cc, field, raw);
    if (cross !== null) return cross;
  }
  return null;
}
/** 改的是哪几个字段，用来说明"这次动了什么" */
export interface WriteResult {
  changed: string[];
  backup: string;
}

/**
 * 保存一条记录。
 *
 * patch 里**没有出现的字段不动** —— 前端只提交改过的字段，
 * 这样并发编辑两个不同字段不会互相覆盖，也不会把没在界面上显示的字段抹掉。
 */
/**
 * M2.65：把「可选字段的空值」规范化成 `undefined`（= 不写这个键）。
 *
 * 顶层可选字段留空 → undefined（写回时删键）；
 * 表格里 optional 的列留空 → 这一行少一个键。
 * 其余值原样透传 —— 这个函数**只**负责这一件事，不顺手做别的清洗。
 */
function pruneOptional(field: FieldSpec, value: unknown): unknown {
  if (field.type === 'rows' && Array.isArray(value)) {
    return value.map((row) => {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) return row;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
        const col = (field.rowFields ?? []).find((c) => c.key === k);
        if (col?.optional === true && (v === '' || v === null || v === undefined)) continue;
        out[k] = v;
      }
      return out;
    });
  }
  // undefined 也算：可选布尔的「未设置」那一档从控件里交上来就是 undefined
  if (field.optional === true && (value === '' || value === null || value === undefined)) return undefined;
  if (field.type === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const sub = (field.objectFields ?? []).find((c) => c.key === k);
      if (sub?.optional === true && (v === '' || v === null || v === undefined)) continue;
      out[k] = v;
    }
    return out;
  }
  /*
   * maplist：**没有任何键的一条丢掉**。
   *
   * 它在判定层是一条「什么都不做」的效果，但会占着一个位置 ——
   * 读内容的人会以为这张卡有那么多条效果，然后去找那条为什么没生效。
   */
  if (field.type === 'maplist' && Array.isArray(value)) {
    return value.filter((row) => typeof row === 'object' && row !== null && Object.keys(row).length > 0);
  }
  return value;
}

/* ================================================================== *
 * 跨表校验（M2.83）：值必须**在别的地方真实存在**
 * ================================================================== */

/**
 * `validateField` 是一个纯函数（只看值和字段元数据），所以它管不了这一类：
 * 「这个地点 id 是真的吗」「这个 flag 在注册表里吗」「这条条件语法认得吗」。
 *
 * 而那几条恰恰最容易出**静默故障** —— 写错一个地点 id，判定层只是永远匹配不上：
 * 不报错、不警告，卡就是不出。运营会以为是概率问题，然后去调权重。
 *
 * 放在这里而不是 schema.ts，是因为它需要 root（去目标表里查）；
 * 放在服务端而不是只做前端控件，是因为**绕过前端直接打 API 完全可能**，
 * 而且运营迟早会手写 yaml —— 那时候这一层是唯一的防线。
 */
export interface CrossCtx {
  root: string;
  /** 目标实体 id → 它有哪些记录 id（一次写入内复用，不然 950 条物品会被反复全扫） */
  ids: Map<string, Set<string> | null>;
}

/**
 * 目标实体里的全部记录 id；读不到返回 null。
 *
 * ⚠️ null 与空集**不是一回事**：空集是「这张表里一条都没有」，null 是「查不动」。
 * 把后者当成前者，会让每一次保存都被一大堆「目标不存在」挡住，
 * 而真正的原因（文件坏了 / 目录不对）和用户填的值毫无关系。
 */
function idsOf(ctx: CrossCtx, entityId: string): Set<string> | null {
  return cachedSet(ctx, entityId + '#ids', entityId, (row) => row.id);
}

/**
 * 目标实体里的全部**显示名**（`titleKey` 那一列）；读不到返回 null。
 *
 * ⚠️ M2.90：为什么需要它 —— `location:` 条件比的是**地点名**（见 condIssue 的说明），
 * 而 `idsOf` 给的是记录 id。两者混用的代价是「校验挡住了合法内容、却放过了坏内容」：
 * 写中文名的 511 张卡全被报「地点不存在」，而写 id 的卡（在 `.探索` 路径上**永远不匹配**）
 * 反倒一路放行。
 */
function namesOf(ctx: CrossCtx, entityId: string): Set<string> | null {
  return cachedSet(ctx, entityId + '#names', entityId, (row) => row.title);
}

function cachedSet(
  ctx: CrossCtx,
  cacheKey: string,
  entityId: string,
  pick: (row: DataRow) => string,
): Set<string> | null {
  const hit = ctx.ids.get(cacheKey);
  if (hit !== undefined) return hit;
  const target = entityById(entityId);
  let out: Set<string> | null = null;
  if (target !== undefined) {
    try { out = new Set(listEntity(ctx.root, target).map(pick)); } catch { out = null; }
  }
  ctx.ids.set(cacheKey, out);
  return out;
}

/**
 * 触发条件的**语义**校验（语法那一层由 domain/event/trigger.ts 的 parseCond 负责）。
 *
 * parseCond 对几种写法是宽松的，因为它在判定层**每张卡每次判定**都要跑，
 * 那里加查表不划算；而这里一次保存只跑一遍，可以把「值真的存在吗」也管上：
 *
 *   flag:xxx     —— xxx 必须在 registry.yaml 的 flags 清单里；
 *   location:xxx —— xxx 必须是**地点的名字**（`location.name`），不是 id。
 *
 *   ⚠️ M2.87 修正：这里原来写的是「必须是一个真实地点 id」，而 `loadRegistryFile`
 *   收的是 `locations.map((location) => location.name)` —— **提示与实现不一致**，
 *   照提示写出来的条件永远匹配不上（正是 AGENTS §3.10 第 3 条说的那类事故）。
 *   status:xxx   —— xxx 必须在 COND_STATUSES 里（**parseCond 只检查非空**）；
 *   pathway:xxx  —— parseCond 已经严格校验过，这里不重复。
 *
 * 这几条都是「写错了不会报错、只会永远不成立」的形状，也正是「用户瞎输入」
 * 最容易撞上的地方。
 */
function condIssue(ctx: CrossCtx, cond: string): string | null {
  const text = cond.trim();
  if (!isValidCond(text)) {
    return '「' + text + '」不是认得的条件写法。认得的：' +
      'seq<=8（seq / dig / mad / cor / hp / mp / ap / dp 配 > >= < <= == != 和数字）、' +
      'flag:标记名、location:地点名（如「廷根市」）、pathway:途径id、pathway:mortal、status:状态、party:size>=2';
  }
  const parsed = parseCond(text);
  if (parsed === null) return null;
  if (parsed.kind === 'flag') {
    const flags = idsOf(ctx, '__flags__');
    if (flags !== null && !flags.has(parsed.flag)) {
      return 'flag「' + parsed.flag + '」不在内容注册表的标记清单里 —— ' +
        '这条条件会恒为 false，这张卡永远不出。先去「内容注册表」把它加上。';
    }
  }
  if (parsed.kind === 'location') {
    /*
     * ⚠️ M2.90：**这里比的是地点名，不是 id。**
     *
     * 判定层 evalCond 写的是 `ctx.location === parsed.location`，而 `ctx.location` 在
     * `.探索` 这条路上来自 `location.name`（中文名）—— 于是：
     *   · 写中文名的卡能匹配 ✅
     *   · 写 id 的卡**永远不匹配**，而它在这条校验里反而是「合法」的。
     *
     * 原来这里用 `idsOf(ctx, 'locations')`（记录 id 集合）⇒ 正好**反过来**：
     * 合法的中文名全被挡住（511 张序列卡一张都存不回去），真正的坏写法一路放行。
     * 上面那段注释（「必须是地点的名字」）其实早就写对了，只是实现没跟上 ——
     * 这正是 AGENTS §3.10 第 3 条说的那类事故，只不过这次是**校验层**在说谎。
     */
    const locs = namesOf(ctx, 'locations');
    if (locs !== null && !locs.has(parsed.location)) {
      return '地点「' + parsed.location + '」不存在 —— 这条条件会恒为 false。' +
        '这里要写**地点名**（例如「廷根市」「灰雾之上」），不是地点 id。';
    }
  }
  if (parsed.kind === 'status' && !COND_STATUSES.includes(parsed.status)) {
    return 'status「' + parsed.status + '」不是角色状态（只能是：' + COND_STATUSES.join(' / ') + '）';
  }
  return null;
}

/**
 * 一条记录里的全部跨表校验。返回中文原因，null 表示通过。
 *
 * 递归到 rows / objectFields 里 —— 卡片的触发条件就藏在 `trigger`（object）下面，
 * 只扫顶层会整整漏掉这一类（M2.83 之前就是这样：cond 的校验一条都没有）。
 */
function crossCheck(ctx: CrossCtx, field: FieldSpec, value: unknown): string | null {
  if (value === undefined || value === null) return null;

  /*
   * ⚠️ 只认 `condList` 这个标记，**不要**再判 `type === 'strlist'` ——
   * cond 的字段类型后来从 strlist 改成了专用的 condlist（结构化下拉），
   * 而这里当时写的是 `type === 'strlist' && condList === true`：
   * 类型一改，整条条件校验就**静默失效**了（测试当场抓到）。
   */
  if (field.condList === true && Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string' || item.trim() === '') continue;
      const bad = condIssue(ctx, item);
      if (bad !== null) return field.label + '里的' + bad;
    }
  }

  /*
   * ref / itemRef / itemRefs：值是别的实体的 id，那个 id 必须真的在。
   * itemRefs 是「好几个实体的并集」—— 在其中一个里就算对。
   */
  const targets: string[] = [];
  if (field.ref !== undefined) targets.push(field.ref);
  if (field.itemRef !== undefined) targets.push(field.itemRef);
  for (const e of field.itemRefs ?? []) targets.push(e);
  if (targets.length > 0) {
    const values = Array.isArray(value) ? value : [value];
    // 一个都查不动时不校验：那种情况下报错会指向用户填的值，而问题在别处
    const reachable = targets.filter((t) => idsOf(ctx, t) !== null);
    if (reachable.length > 0) {
      for (const raw of values) {
        if (typeof raw !== 'string' || raw === '') continue;
        // 哨兵值（factions 里的 none = 无主）不走引用校验，它本来就不在任何一张表里
        if ((field.allow ?? []).includes(raw)) continue;
        if (reachable.some((t) => idsOf(ctx, t)?.has(raw) === true)) continue;
        const names = targets.map((t) => entityById(t)?.label ?? t).join(' / ');
        return field.label + '里的「' + raw + '」在' + names + '里找不到 —— ' +
          '判定层会当成「永远匹配不上」，不报错。';
      }
    }
  }

  if (field.type === 'rows' && Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const row = value[i];
      if (typeof row !== 'object' || row === null) continue;
      for (const col of field.rowFields ?? []) {
        const bad = crossCheck(ctx, col, (row as Record<string, unknown>)[col.key]);
        if (bad !== null) return field.label + '第 ' + (i + 1) + ' 行的' + bad;
      }
    }
  }
  if (field.type === 'object' && typeof value === 'object' && !Array.isArray(value)) {
    for (const sub of field.objectFields ?? []) {
      const bad = crossCheck(ctx, sub, (value as Record<string, unknown>)[sub.key]);
      // 子字段自己的标签已经在里面了，这里不再叠一层
      if (bad !== null) return bad;
    }
    /*
     * M2.89：**跨字段规则 —— 有数量就必须有物品。**
     *
     * ## 用户报的问题
     *
     * > 「还有奇遇里的，有些事件只设置了数量，但获得物品是无，查」
     *
     * 我扫了 20 条奇遇，**数据本身是干净的**（没有 quantity 无 itemId 的）。
     * 但界面把两个字段分开显示 —— 没有 itemId 的那几条，「得到的东西」和「数量」
     * 都是空，**两者看不出有关联**，于是读起来就像「设了数量却没东西」。
     *
     * ## 为什么这是「存在性校验」而不是「值域校验」
     *
     * `quantity` 单独看永远是合法的（它是一个正数），错的是**它没有对应物**。
     * 这正是 AGENTS §3.10 那张表里说的第二层：值域管不了、必须查别的字段。
     *
     * ## 为什么写成通用的而不是只给奇遇
     *
     * 同一个形状（`{ itemId, quantity }`）在这个项目里出现在**多处**：
     * 奇遇的 effect、配方的 rows、商店的 stock…… 一处写死一次就要跟着改很多处。
     * 所以规则挂在「对象里同时有这两个键」上，谁有谁受益。
     */
    const obj = value as Record<string, unknown>;
    const hasItem = obj.itemId !== undefined && obj.itemId !== null && String(obj.itemId).trim() !== '';
    const qty = obj.quantity;
    const hasQty = typeof qty === 'number' && qty > 0;
    if (hasQty && !hasItem) {
      return (
        field.label + '里设了数量 ' + String(qty) + '，但没选物品 —— ' +
        '这一条会**什么都不发**（判定层要求两者成对），而界面上看不出来。'
      );
    }
  }
  return null;
}

/**
 * registry.yaml 的 flags —— 它不是一个可比对的「实体」（文件里只有一张字符串列表），
 * 所以单独读一次，用 `__flags__` 这个假实体 id 挂进同一套缓存里。
 */
function loadFlagSet(root: string): Set<string> | null {
  try {
    const doc = parseDocument(readFileSync(resolve(root, 'src/cards/registry.yaml'), 'utf8'));
    const raw = (doc.get('flags') as { toJSON?: () => unknown } | undefined)?.toJSON?.() ?? [];
    return new Set(Array.isArray(raw) ? raw.map((x) => String(x)) : []);
  } catch {
    return null;
  }
}

/**
 * 让新值的**字符串末梢**跟着旧值走（M2.76）。
 *
 * 为什么需要：YAML 的块标量有两种写法 —— `|` 会保留末尾那一个换行，`|-` 不保留。
 * 而 textarea 交上来的值**永远不带**末尾换行。不处理的话，运营每改一个字，
 * 卡片正文的结尾就从 `|` 变成 `|-`：内容没变、diff 却动了整段 ——
 * 而这个仓库的文件里，注释和排版本身就是设计记录，diff 一乱就没人读了。
 *
 * 递归到对象和数组里，因为正文藏在 `texts.priv` 这种嵌套位置上。
 * 只对「旧值本来就是字符串」的位置动手：新加的值一律原样写入。
 */
function alignTrailingNewline(before: unknown, next: unknown): unknown {
  if (typeof next === 'string') {
    if (typeof before !== 'string') return next;
    if (before.endsWith('\n') && !next.endsWith('\n')) return next + '\n';
    if (!before.endsWith('\n') && next.endsWith('\n')) return next.replace(/\n+$/, '');
    return next;
  }
  if (Array.isArray(next)) {
    const b = Array.isArray(before) ? before : [];
    return next.map((x, i) => alignTrailingNewline(b[i], x));
  }
  if (next !== null && typeof next === 'object') {
    const b = (before !== null && typeof before === 'object' && !Array.isArray(before))
      ? (before as Record<string, unknown>) : {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(next as Record<string, unknown>)) {
      out[k] = alignTrailingNewline(b[k], v);
    }
    return out;
  }
  return next;
}

export function writeEntity(
  root: string,
  spec: EntitySpec,
  id: string,
  patch: Record<string, unknown>,
  now: Date = new Date(),
): WriteResult {
  const found = scanRecords(root, spec).find((l) => l.rec.id === id);
  if (found === undefined) throw new Error('找不到这条记录：' + id);
  const { rec, doc, path } = found;

  const fields = new Map<string, FieldSpec>(spec.fields.map((f) => [f.key, f]));
  // 这次的跨表缓存（见 newCrossCtx）
  const cc = newCrossCtx(root);
  const changed: string[] = [];
  for (const [key, raw] of Object.entries(patch)) {
    const field = fields.get(key);
    // 只认元数据里声明过的字段：API 直接打过来一个没声明的键，不该被写进文件
    if (field === undefined || field.readOnly === true) continue;
    const bad = validateField(field, raw);
    if (bad !== null) throw new Error(bad);
    /*
     * 值域对不对只是一半 —— 另一半是「它在别处真的存在吗」。
     * 两条都要过，而且是**在服务端**过：前端控件只是方便。
     */
    const cross = crossCheck(cc, field, raw);
    if (cross !== null) throw new Error(cross);
    /*
     * M2.65：**可选字段的空值不写进文件**（顶层留空 = 删键，表格里留空 = 少一个键）。
     *
     * 为什么非做不可：下拉留空写出的是 `''`，而 zod 那一侧写的是
     * `z.string().min(1).optional()` —— `''` **过不了** min(1)，
     * 于是「把这一格清空」的后果是下一次内容校验整份文件报错，
     * 而那个错误只在热重载 / 重启时才看得见（界面上是一次「保存成功」）。
     */
    const pruned = pruneOptional(field, raw);
    const next = pruned === undefined ? undefined : alignTrailingNewline(rec.get(key), pruned);
    if (next === undefined) {
      if (rec.has(key)) {
        rec.del(key);
        changed.push(field.label);
      }
      continue;
    }
    if (JSON.stringify(rec.get(key) ?? null) === JSON.stringify(next ?? null)) continue;
    rec.set(key, next);
    changed.push(field.label);
  }
  /*
   * 跨字段规则（M2.56）：某个字段的值里必须出现**同一条记录里另一个字段**的值。
   *
   * 目前只有一条用得上：扮演文案的 text 必须含它自己的 tag。判定层按关键词匹配
   * 算消化度，少了那两个字玩家选了不涨 —— 而这**不会报任何错**。
   *
   * ⚠️ 必须遍历**所有**声明了规则的字段，不能只在 patch 里找。
   * 我第一版就是写在字段循环里的，于是「只改 tag」那条路漏了：patch 里没有 text，
   * 循环走不到它，文案就悄悄失效了 —— 测试当场抓到这个（改 tag 为「疾走」时没拦住）。
   * 这里读的是记录的**当前值**（patch 已经写进去了），所以两个字段谁改都拦得住。
   */
  const valueOf = (key: string): unknown => rec.get(key);
  for (const field of spec.fields) {
    if (field.mustContainField === undefined) continue;
    const value = valueOf(field.key);
    const needle = valueOf(field.mustContainField);
    if (typeof value !== 'string' || value === '') continue;
    if (typeof needle !== 'string' || needle === '') continue;
    if (!value.includes(needle)) {
      throw new Error(
        field.label + '里必须出现「' + needle + '」。少了它，玩家选了这条不会涨消化度，' +
          '而这件事不会报任何错 —— 所以这里当场拦住。',
      );
    }
  }

  if (changed.length === 0) return { changed, backup: '' };
  return { changed, backup: flushDoc(root, spec, id, doc, path, now, path) };
}

/**
 * 把改好的文档写回磁盘：备份 + 落盘。
 *
 * **只有这一份实现** —— 改一条（writeEntity）和新建一条（createEntity）走的是同一段代码。
 * 分成两份的代价是那些踩过坑的细节会漂移：末尾到底补不补换行、lineWidth 要不要设 0。
 *
 * `backupFrom` 是要备份的原文件；新建一条 dir 记录时它还不存在，传 null ——
 * 那时候没有「改动前的样子」可留，硬造一个空备份只会让 backups/ 里多一堆垃圾。
 */
function flushDoc(
  root: string, spec: EntitySpec, id: string, doc: Document, path: string,
  now: Date, backupFrom: string | null,
): string {
  const backupDir = join(root, 'data', 'backups');
  mkdirSync(backupDir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  /*
   * 备份名带上**记录 id**。
   *
   * 只用「实体 id + 时间戳」的话，dir 模式（事件卡）下一个实体有 137 条记录，
   * 同一秒内改两张卡会互相覆盖 —— 而「一次调好几张卡的文案」恰好就是最常见的用法，
   * 撞车概率不低。撞了的表现是：想回滚时发现备份里是另一张卡，而备份本身看着很正常。
   */
  const safeId = id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
  const backup = join(backupDir, spec.id + '-' + safeId + '-' + stamp + '.yaml');
  if (backupFrom !== null) copyFileSync(backupFrom, backup);
  /*
   * ⚠️ lineWidth: 0 不能省。
   *
   * yaml 默认 lineWidth=80：items.yaml 里大量条目写成一行流式
   * （- { id: 便士, name: 便士, kind: currency, ... }），几乎每一行都超过 80 字符，
   * 于是**整份文件被折行成块式** —— 实测 359 行变 1127 行，git diff 显示 889 insertions。
   * 内容没丢，但 diff 彻底没法看，而这个文件里的注释是设计记录，被冲散就没人读了。
   *
   * flowCollectionPadding 保持默认（true）：外层 { id: ... } 的空格风格靠它。
   * 副作用：内层写成 [banish] 的那几行会被规范成 [ banish ]，全文件约 3 行 ——
   * 一个开关救不了两种风格，选占多数的那种。
   */
  /*
   * 末尾要有一个换行 —— 仓库里每个文件都以换行结尾。
   *
   * ⚠️ 写成 `doc.toString() + '\n'` 是**错的**：yaml 的 toString **已经**补了换行，
   * 再补一个就是每次保存都往文件末尾多塞一个空行。实测（M2.76）：
   * 改一个字，daily_001.yaml 的第 18 行从「不存在」变成空行。
   * 一次两次看不出来，几十次之后每个文件的结尾都拖着几个空行。
   */
  const text = doc.toString({ lineWidth: 0 });
  writeFileSync(path, text.endsWith('\n') ? text : text + '\n', 'utf8');
  void dirname;
  return backupFrom === null ? '' : backup;
}

/* ================================================================== *
 * 新增一条记录（M2.84）
 * ================================================================== */

/**
 * 新记录的 id 检查。
 *
 * ⚠️ 这里挡的不只是「重复」—— `dir` 模式的 id **会直接变成文件名**
 * （`src/cards/daily/<id>.yaml`），所以 `..`、`/`、`\` 这类东西就是一次**目录穿越**：
 * 填 `../../src/main` 能把文件写到仓库外面去。
 *
 * 这条防护必须在这里，**不能只靠前端输入框** —— 那个框绕过太容易了。
 */
function checkNewId(root: string, spec: EntitySpec, id: string): string | null {
  if (id.length === 0) return 'id 不能为空';
  if (id.length > 64) return 'id 太长了（上限 64 个字符）';
  /*
   * 严不严**要看模式**。
   *
   *   dir —— id **会直接变成文件名**（`src/cards/daily/<id>.yaml`），所以那一档
   *          必须严：ASCII、不含路径分隔符。「严」在这里是有理由的，不是洁癖。
   *   其余 —— id 只是一个值（seq 的 id 字段）或一个键（map）。
   *          `fragments.yaml` 的键本来**就是中文**（「气味」「声音」），
   *          按文件名那套去卡会把合法内容挡在门外 —— 这一版第一次写就踩了。
   */
  if (spec.rootMode === 'dir') {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(id)) {
      return 'id 只能用字母、数字、下划线、点、连字符，且要以字母/数字/下划线开头（它会变成文件名）：' + id;
    }
  } else {
    // 控制字符与首尾空白写进 yaml 会让文件读起来莫名其妙，这一条与模式无关
    if (/[\u0000-\u001f\u007f]/.test(id) || id !== id.trim()) {
      return 'id 里不能有控制字符或首尾空白：' + JSON.stringify(id);
    }
    if (/[/\\]/.test(id)) return 'id 里不能有斜杠：' + id;
  }
  /*
   * 实体自己的 id 约定（卡片那边是 `^[a-z][a-z0-9]*(_[a-z0-9]+)+$`）。
   * 它不属于「安全」，但违反它的记录会被内容 lint 拒掉 ——
   * 在这里报出来，人还能改；等热重载失败才报，那张卡已经写进文件了。
   */
  if (spec.idPattern !== undefined && !spec.idPattern.test(id)) {
    return spec.idHint ?? ('id 不符合这一类的约定：' + String(spec.idPattern));
  }
  if (scanRecords(root, spec).some((l) => l.rec.id === id)) {
    return '已经有一条 id 叫「' + id + '」了';
  }
  return null;
}

/**
 * 新建时的必填检查。
 *
 * ⚠️ `validateField` 对 `undefined` 一律放行 —— 那是「这一次不改这个字段」的意思。
 * 那个语义对**改**是对的，对**新建**是致命的：少写一个必填字段，文件存得下去，
 * 但**下一次加载整份内容会报错**，而保存的那一刻界面上是绿的。
 */
function requiredMissing(spec: EntitySpec, patch: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const f of spec.fields) {
    if (f.readOnly === true || f.optional === true) continue;
    // id 由调用方单独处理（它是新记录的名字，不在 patch 里）
    if (f.key === spec.idKey) continue;
    const v = patch[f.key];
    if (v === undefined || v === null || v === '') out.push(f.label);
  }
  return out;
}

/**
 * 新建一条记录（M2.84）。
 *
 * 这是 AGENTS.md §3.4「让运营能自己加、自己改」里**「自己加」的那一半** ——
 * 在此之前编辑器只能改已有的记录：加一件物品、加一张事件卡、加一个地点，
 * 都得去改文件再重启，而那正是这一整套后台存在的理由。
 *
 * 四种根形状各有各的加法，只有 single 没有：
 *
 *   seq    —— 往根键的数组末尾追加一个对象
 *   map    —— 往根键的映射里加一个键
 *   dir    —— **写一个新文件**（`<id>.yaml`）
 *   single —— 整份文件就是那一条，没有「再加一条」这回事
 */
export function createEntity(
  root: string, spec: EntitySpec, id: string, patch: Record<string, unknown>,
  now: Date = new Date(),
): WriteResult {
  if (spec.rootMode === 'single') {
    throw new Error(spec.label + '是单例（整份文件就是一条记录），没有「新增」这回事');
  }
  const clean = id.trim();
  const idBad = checkNewId(root, spec, clean);
  if (idBad !== null) throw new Error(idBad);

  const missing = requiredMissing(spec, patch);
  if (missing.length > 0) {
    throw new Error(
      '还差这些必填项：' + missing.join('、') +
      '。空着存下去，下一次加载整份内容会报错，而这一刻界面上是绿的。',
    );
  }

  /*
   * 值域 + 跨表：与「改一条」走的是**同一对函数**。
   * 校验分两条路的下场是「新建能绕过全部约束」—— 而那正是最需要约束的入口。
   */
  const fields = new Map<string, FieldSpec>(spec.fields.map((f) => [f.key, f]));
  const cc = newCrossCtx(root);
  const body: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(patch)) {
    const field = fields.get(key);
    if (field === undefined || field.readOnly === true) continue;
    const bad = validateField(field, raw);
    if (bad !== null) throw new Error(bad);
    const cross = crossCheck(cc, field, raw);
    if (cross !== null) throw new Error(cross);
    const v = pruneOptional(field, raw);
    if (v !== undefined && v !== null) body[key] = v;
  }
  const changed: string[] = spec.fields
    .filter((f) => body[f.key] !== undefined)
    .map((f) => f.label);

  if (spec.rootMode === 'dir') {
    const rel = spec.file + '/' + clean + '.yaml';
    const path = resolve(root, rel);
    if (existsSync(path)) throw new Error('已经有一个文件叫 ' + rel + ' 了');
    const doc = parseDocument('');
    // dir 模式下每个文件自己写着 id —— 它是这张卡的坐标，不再兼作键名
    if (spec.idKey !== undefined) doc.set(spec.idKey, clean);
    for (const [k, v] of Object.entries(body)) doc.set(k, v);
    flushDoc(root, spec, clean, doc, path, now, null);
    return { changed, backup: '' };
  }

  const file = recordFiles(root, spec)[0];
  if (file === undefined) throw new Error('找不到数据文件：' + spec.file);
  const doc = parseDocument(readFileSync(file.path, 'utf8'));
  if (spec.rootMode === 'map') {
    /*
     * map 模式的 id **就是键名**，而且那个键下面**直接就是内容** ——
     * 没有字段名那一层：
     *
     *     fragments:
     *       气味:            ← 键（id）
     *         - 潮湿的煤灰味   ← 内容，不是 `texts: [...]`
     *
     * 所以这里取「除 idKey 外那一个字段」的**值**写进去。
     * 与 recordsOf 的读法是同一个约定 —— 读写不对称的下场是
     * 「存进去看着对，读出来多一层壳」（这一版第一次写就踩了）。
     */
    const valueKey = spec.fields.find((f) => f.key !== spec.idKey)?.key ?? '';
    doc.setIn([rootKeyOf(spec), clean], body[valueKey]);
  } else {
    const obj: Record<string, unknown> = {};
    if (spec.idKey !== undefined) obj[spec.idKey] = clean;
    for (const [k, v] of Object.entries(body)) obj[k] = v;
    doc.addIn([rootKeyOf(spec)], obj);
  }
  return { changed, backup: flushDoc(root, spec, clean, doc, file.path, now, file.path) };
}
