/**
 * 管理后台的 .env 读写（M2.49）。
 *
 * ## 为什么不是 process.env
 *
 * 机器人启动时用 process.loadEnvFile() 读一次 .env，之后进程里的 process.env
 * 就是**快照**。管理后台要能改 QQ 适配器的 appid / secret / 沙箱开关，
 * 改完还得让下次启动生效 —— 所以真正要动的是**磁盘上的 .env 文件**。
 *
 * ## 为什么要保留注释与顺序
 *
 * .env 是人手写的，里面有分组注释。整份重写会把注释冲掉、把顺序打乱，
 * 下次有人打开这个文件就不知道该填什么了。所以这里只做**行级替换**：
 * 认识的行原地改值，不认识的行原样保留。
 */

import { readFileSync, writeFileSync } from 'node:fs';

export interface EnvFile {
  /** 文件的每一行（含注释与空行），写回时按这个顺序 */
  lines: string[];
}

/** .env 里的一个 key（例：QQ_BOT_APPID=123 得到 ['QQ_BOT_APPID', '123']） */
const LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** 去掉值两端的引号 —— .env 允许 SECRET="abc" 这种写法 */
function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

export function readEnv(path: string): EnvFile {
  try {
    return { lines: readFileSync(path, 'utf8').split(/\r?\n/) };
  } catch {
    // 文件不存在是正常情况（CI / 生产用环境变量注入），给一个空壳而不是抛错
    return { lines: [] };
  }
}

/** 读一个 key；没有就返回 undefined（调用方自己决定默认值） */
export function envGet(file: EnvFile, key: string): string | undefined {
  for (const line of file.lines) {
    const m = LINE.exec(line);
    if (m !== null && m[1] === key) return unquote(m[2] ?? '');
  }
  return undefined;
}

/** 改一个 key：有就原地改，没有就追加到末尾 */
export function envSet(file: EnvFile, key: string, value: string): void {
  for (let i = 0; i < file.lines.length; i += 1) {
    const m = LINE.exec(file.lines[i] ?? '');
    if (m !== null && m[1] === key) {
      file.lines[i] = key + '=' + value;
      return;
    }
  }
  file.lines.push(key + '=' + value);
}

export function writeEnv(path: string, file: EnvFile): void {
  // 末尾补一个换行：多数编辑器与 git diff 都期望如此
  const text = file.lines.join('\n').replace(/\n*$/, '') + '\n';
  writeFileSync(path, text, 'utf8');
}

/**
 * 密钥打码。
 *
 * 管理后台会把配置回显给页面，**secret 不能原样送回去** —— 页面源码、浏览器缓存、
 * 截图都是泄漏面。只露头尾各 4 位，够确认「填的是哪一个」，不够还原。
 */
export function maskSecret(value: string | undefined): string {
  if (value === undefined || value.length === 0) return '';
  if (value.length <= 10) return '*'.repeat(value.length);
  return value.slice(0, 4) + '*'.repeat(Math.min(20, value.length - 8)) + value.slice(-4);
}
