/**
 * 封测演练（W6）：用真实 HTTP + 真实服务进程跑 8 天，验证埋点与日报链路。
 *
 * 重要：这里的数据是**演练数据**（虚拟玩家的固定到访模式），
 * 不是真实玩家数据；它只能证明「采集与报表可用」，不能用来宣称留存达标。
 *
 *   node scripts/beta-rehearsal.ts --db data/beta-rehearsal.db
 */
import { join } from 'node:path';
import { cleanupDb, startTestServer } from '../src/loadtest/harness.ts';
import { buildMessageEvent, reportEvent } from '../src/loadtest/client.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return (index >= 0 ? process.argv[index + 1] : undefined) ?? fallback;
}

const dbPath = arg('db', join(process.cwd(), 'data', 'beta-rehearsal.db'));
cleanupDb(dbPath);

/** 每天新增多少用户（演练脚本设定的到访曲线，不是真实数据） */
const FRESH_PER_DAY = [40, 20, 12, 8, 6, 4, 3, 2];
/** 按「距首次活跃的天数」设定的回流比例，用来生成可解释的留存曲线 */
const RETURN_RATE_BY_AGE = [0.75, 0.6, 0.5, 0.42, 0.36, 0.3, 0.26];

function cohortOf(day: number): number[] {
  const size = FRESH_PER_DAY[day - 1] ?? 0;
  return Array.from({ length: size }, (_, i) => 900000 + day * 100 + i);
}

/** 每天的到访名单：同一批 user_id 反复出现，才能算出真实的留存 */
function attendanceFor(day: number): { returning: number[]; fresh: number[] } {
  const fresh = cohortOf(day);
  const returning: number[] = [];
  for (let past = 1; past < day; past += 1) {
    const age = day - past;
    const rate = RETURN_RATE_BY_AGE[age - 1] ?? 0.2;
    const cohort = cohortOf(past);
    const keep = Math.round(cohort.length * rate);
    returning.push(...cohort.slice(0, keep));
  }
  return { returning, fresh };
}

const COMMANDS = [
  '.状态',
  '.扮演 我占卜今天的运势',
  '.探索 廷根市',
  '.背包',
  '.占卜 今天会出事吗',
  '.休息',
  '.扮演 我整夜不睡，盯着黑暗',
  '.队伍 创建',
];

async function runDay(day: number, users: number[], createNew: boolean): Promise<{ ok: number; fail: number }> {
  const server = await startTestServer({ dbPath, timeTravelDays: day - 1, startOps: false });
  let ok = 0;
  let fail = 0;
  try {
    await Promise.all(
      users.map(async (userId, index) => {
        const steps: string[] = [];
        if (createNew) steps.push(`.创建 玩家${userId % 1000} ${['愚者', '战士', '不眠者'][index % 3]}`);
        steps.push(...COMMANDS.slice(0, 4 + (index % 4)));
        for (const [stepIndex, rawText] of steps.entries()) {
          const result = await reportEvent(
            server.appPort,
            buildMessageEvent({
              messageId: `reh-${day}-${userId}-${stepIndex}`,
              userId: String(userId),
              rawText,
              scene: stepIndex % 2 === 0 ? 'group' : 'private',
              nickname: `玩家${userId % 1000}`,
            }),
            10_000,
            server.token,
          );
          if (result.ok) ok += 1;
          else fail += 1;
        }
      }),
    );
  } finally {
    await server.stop();
  }
  return { ok, fail };
}

let totalOk = 0;
let totalFail = 0;
for (let day = 1; day <= 8; day += 1) {
  const { returning, fresh } = attendanceFor(day);
  const users = [...returning, ...fresh];
  const result = await runDay(day, users, fresh.length > 0);
  totalOk += result.ok;
  totalFail += result.fail;
  console.log(`第 ${day} 天：用户 ${users.length}（回流 ${returning.length} / 新增 ${fresh.length}），指令 ok=${result.ok} fail=${result.fail}`);
}

console.log(`演练结束：指令总数 ${totalOk}，失败 ${totalFail}，库文件 ${dbPath}`);
console.log('提示：这是演练数据（固定到访模式），只能证明采集与报表链路可用，不代表真实留存。');
