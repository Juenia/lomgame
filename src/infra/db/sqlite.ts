import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = DatabaseSync;

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

export function openDatabase(filePath: string): Db {
  if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

/** 顺序执行未应用的迁移，每个文件一个事务，返回本次新应用的文件名 */
export function migrate(db: Db, migrationsDir: string = DEFAULT_MIGRATIONS_DIR): string[] {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);',
  );
  const applied: string[] = [];
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const done = db.prepare('SELECT 1 AS ok FROM schema_migrations WHERE name = ?').get(file);
    if (done) continue;
    db.exec('BEGIN');
    try {
      db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(
        file,
        Date.now(),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`迁移失败 ${file}: ${(error as Error).message}`);
    }
    applied.push(file);
  }
  return applied;
}

export function closeDatabase(db: Db): void {
  db.close();
}

/** 多步账务（交易结算、扣材料）必须整体成功或整体回滚 */
export function withTransaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
