/**
 * SQLite 备份（W5 运维项）：每日一份，保留 7 天。
 * 用 VACUUM INTO 生成一致性快照 —— 不需要停服，也不会拷到写了一半的 WAL。
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db/sqlite.ts';
import { dateKey } from './date.ts';

export interface BackupEntry {
  file: string;
  bytes: number;
  mtime: number;
}

export interface BackupResult {
  /** 本次实际写出的文件（当天已备份过则为已存在的那个） */
  file: string;
  bytes: number;
  created: boolean;
  pruned: string[];
}

export function backupFileName(now: number): string {
  return `backup-${dateKey(now)}.db`;
}

export function listBackups(dir: string): BackupEntry[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith('backup-') && name.endsWith('.db'))
    .map((name) => {
      const file = join(dir, name);
      const stat = statSync(file);
      return { file, bytes: stat.size, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/** 只保留最近 retainDays 天（按文件名里的日期判断，不依赖文件系统时间） */
export function pruneBackups(dir: string, retainDays: number, now: number): string[] {
  const cutoff = new Date(now - retainDays * 24 * 60 * 60 * 1000);
  const cutoffKey = dateKey(cutoff.getTime());
  const pruned: string[] = [];
  for (const entry of listBackups(dir)) {
    const stamp = entry.file.replace(/^.*backup-/, '').replace(/\.db$/, '');
    if (stamp < cutoffKey) {
      rmSync(entry.file, { force: true });
      pruned.push(entry.file);
    }
  }
  return pruned;
}

export function backupDatabase(
  db: Db,
  dir: string,
  now: number,
  options: { retainDays?: number } = {},
): BackupResult {
  const retainDays = options.retainDays ?? 7;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, backupFileName(now));

  if (existsSync(file)) {
    return { file, bytes: statSync(file).size, created: false, pruned: [] };
  }

  // 路径里可能有单引号，按 SQLite 的规则转义
  const escaped = file.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  const bytes = statSync(file).size;
  return { file, bytes, created: true, pruned: pruneBackups(dir, retainDays, now) };
}
