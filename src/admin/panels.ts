/**
 * 数据面板的服务端（M2.52）：总览 / 运营指标 / 备份 / 玩家反馈。
 *
 * ## 只组装，不重算
 *
 * 留存、告警、日报、备份、审计归档都是别处已经写好、**有测试**的东西
 * （ops/stats、ops/alerts、ops/daily-report、infra/backup、infra/archive）。
 * 后台再算一遍就会出现两套口径，而「后台说 X、日报说 Y」是最难向人解释的一类不一致。
 * 所以这里只做三件事：取数、拼装、把字段名换成中文。
 */
import { basename } from 'node:path';
import { listBackups } from '../infra/backup.ts';
import { FeedbackRepo } from '../infra/db/feedback.ts';
import type { Db } from '../infra/db/sqlite.ts';
import { archiveStats } from '../infra/archive.ts';
import type { OneBotStatus } from './adapter.ts';
import { checkAlerts, type Alert } from '../ops/alerts.ts';
import { buildDailyReport } from '../ops/daily-report.ts';
import { COMPLAINT_CATEGORY, computeBetaStats, computeGameplayStats } from '../ops/stats.ts';

/** /health 的那份快照（main.ts 里组装，后台直接复用，不另算一份） */
export interface HealthSnapshot {
  commands: string[];
  characters: number;
  cards: number;
  locations: number;
  recipes: number;
  items: number;
  abilities: number;
  lostControlEvents: number;
  /** DailyTickRepo.latest() 给的是整行，不是日期字符串 */
  lastTick: { date: string; executedAt: number } | null;
  world: {
    /** moonPhase 是 0—29 的数字（worldClock 的口径），不是名字 */
    seed: string; timeOfDay: string; moonPhase: number; foggy: boolean;
    locations: number; lightTicks: number; heavyTicks: number;
    lastLightAt: number | null; lastHeavyAt: number | null;
  };
  backup: { file: string; bytes: number; count: number } | null;
  audit: { hotRemaining: number; archivedTotal: number };
  timeTravelDays: number;
  dbPath: string;
  /**
   * M2.75：QQ 官方通道的**登录状态**。OneBot 通道没有这一段，所以是 null。
   *
   * 为什么放进 /health：运维手上通常只有一条 curl。以前要判断「机器人为什么不理人」，
   * 得先登录后台、再翻日志、再去开放平台看配额 —— 现在这一条就够。
   */
  qq: QqLoginHealth | null;
  /**
   * M2.77：OneBot 通道的连接状态（内置正向 WS）。
   * HTTP 上报模式下没有「连接」这个概念，所以 connected 是 null ——
   * 面板要能区分「没连上」和「这种模式本来就没有连接」。
   */
  onebot: OneBotHealth | null;
}

/**
 * /health 里的 OneBot 段 = 后台面板用的那份状态（**同一个类型**）。
 * 两处各写一遍迟早会漂移，而「/health 说 A、面板说 B」既不会报错也没人解释得清。
 */
export type OneBotHealth = OneBotStatus;

/** /health 里的 QQ 登录段（每个字段都对应一个具体的故障假设） */
export interface QqLoginHealth {
  appId: string;
  sandbox: boolean;
  /** WebSocket 会话是否就绪（identify 成功且没在等重连） */
  connected: boolean;
  tokenRemainingSec: number | null;
  /** 主动续期开着没有。关着时「token 到期」要靠下一条消息来发现 */
  tokenAutoRefresh: boolean;
  gateway: {
    identifies: number;
    resumes: number;
    reconnects: number;
    /** 因致命关闭码停止重连的次数。>0 就是「重连不会好，必须人介入」 */
    fatalStops: number;
    /**
     * 本次启动是不是**靠落盘会话续接**上来的（M2.76）。
     * true = 重启没有烧 identify 配额，也没有丢掉重启期间的事件。
     */
    resumedFromDisk: boolean;
    lastClose: { code: number; reason: string; at: number } | null;
  };
  /** 最近一次登录体检的结论（没跑过是 null） */
  login: {
    ok: boolean;
    at: number;
    verdict: string;
    bot: string | null;
    sessionRemaining: number | null;
    sessionTotal: number | null;
  } | null;
}

export function overviewPayload(health: HealthSnapshot, db: Db, date: string, pid: number, startedAt: string) {
  const alerts = checkAlerts(db, date);
  return {
    process: { pid, startedAt, dbPath: health.dbPath, timeTravelDays: health.timeTravelDays },
    // 规模：数字都给出来源，免得「角色数」到底是注册数还是建号数说不清
    scale: [
      { label: '角色', value: health.characters },
      { label: '指令', value: health.commands.length },
      { label: '角色卡模板', value: health.cards },
      { label: '地点', value: health.locations },
      { label: '配方', value: health.recipes },
      { label: '物品', value: health.items },
      { label: '能力', value: health.abilities },
    ],
    world: health.world,
    ops: {
      alerts,
      lostControlEvents: health.lostControlEvents,
      lastTick: health.lastTick,
    },
    backup: health.backup,
    audit: health.audit,
    date,
  };
}

export function opsPayload(db: Db, date: string) {
  const gameplay = computeGameplayStats(db);
  const beta = computeBetaStats(db);
  const alerts = checkAlerts(db, date);
  const report = buildDailyReport(db, date);
  return {
    date,
    gameplay,
    beta,
    alerts,
    // 日报是别处写好的 markdown，后台只负责显示与复制，不再拼一遍
    reportMarkdown: report.markdown,
  };
}

export function backupView(dir: string) {
  const entries = listBackups(dir);
  return {
    dir,
    entries: entries.map((e) => ({ file: basename(e.file), bytes: e.bytes, mtime: e.mtime })),
    totalBytes: entries.reduce((n, e) => n + e.bytes, 0),
    // 备份文件是按日期命名的，这里顺手把「最新一份是哪天」算出来给总览用
    latest: entries[0] ? basename(entries[0].file) : null,
  };
}

export interface FeedbackView {
  rows: Array<{
    id: number; userId: string; content: string; category: string;
    status: string; createdAt: number; handledAt: number | null;
  }>;
  total: number;
  complaints: number;
}

export function feedbackView(db: Db, limit = 100): FeedbackView {
  const repo = new FeedbackRepo(db);
  return {
    // 原文照发：反馈是人写的话，任何「摘要」都可能把关键信息抹掉
    rows: repo.recent(limit).map((r) => ({
      id: r.id, userId: r.userId, content: r.content, category: r.category,
      status: r.status, createdAt: r.createdAt, handledAt: r.handledAt,
    })),
    total: repo.count(),
    complaints: repo.countByCategory(COMPLAINT_CATEGORY),
  };
}

/** 反馈分类的中文名。写进 schema.ts 那种元数据表也可以，但这里只有这一处用它 */
export const FEEDBACK_STATUS_LABEL: Record<string, string> = {
  new: '待处理',
  triaged: '已分类',
  fixed: '已修复',
  wontfix: '不修',
  duplicate: '重复',
};

export const FEEDBACK_CATEGORY_LABEL: Record<string, string> = {
  '': '未分类',
  投诉: '投诉',
  建议: '建议',
  bug: '缺陷',
  平衡: '平衡',
  内容: '内容',
  其他: '其他',
};

export const alertLevelLabel = (level: Alert['level']): string => (level === 'P0' ? 'P0 紧急' : 'P1 注意');
