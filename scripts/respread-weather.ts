/**
 * 一次性把世界的天气节拍打散（M2.53）。
 *
 * ## 为什么需要它
 *
 * M2.53 之前，天气的时长是恒定的 6 小时，而冷启动时所有地点又从**同一个整点**起步 ——
 * 58 个地点于是永远同步换天气：整点一到全服一起变。那不是世界在演化，那是钟表在响。
 * 挂在它下游的东西全被带着走（环境播报在同一刻齐发、扩散全服一起落地）。
 *
 * 新代码给每个地点自己的相位与抖动时长，所以**新写入的天气**自然会错开；
 * 但已经躺在库里的那些行还带着旧相位，要等它们各自过期才会散开（最多 9 小时）。
 *
 * 这个脚本让人**立刻**看到效果：保留每个地点当前的天气内容与 since，
 * 只把 until 换成本地自己的抖动时长。
 *
 * ## 它不藏在 tick 里，是有意的
 *
 * 我写过一版「自动打散」放在 ensureWeatherRows 里，两个理由让它必须拿掉：
 *   1. 判据（几个地点 until 相同）分不清「旧数据」和「测试夹具故意对齐」，
 *      实测直接把 test/m2-4 的三条用例打红；
 *   2. ensureWeatherRows 也在**只读路径**上被调用 —— 那等于让读操作写库。
 * 迁移是迁移，不该藏在 tick 里。
 *
 * 用法：node scripts/respread-weather.ts [--dry]
 */
import { openDatabase } from '../src/infra/db/sqlite.ts';
import { WorldRepo } from '../src/infra/db/world.ts';
import { weatherPhaseAt } from '../src/domain/world/weather.ts';

const dry = process.argv.includes('--dry');
const db = openDatabase('data/game.db');
const repo = new WorldRepo(db);
const seed = repo.seed();
const now = Date.now();
const states = repo.weatherStates();

if (states.length === 0) {
  console.log('库里还没有天气行 —— 直接启动机器人就会按新相位初始化。');
  process.exit(0);
}

const before = new Map<number, number>();
for (const state of states) before.set(state.until, (before.get(state.until) ?? 0) + 1);

const next = states.map((state) => ({
  ...state,
  /*
   * 保留天气内容，但**相位也重排**。
   *
   * 只改节拍（until = since + 新时长）是不够的：58 个地点的 since 本来就一样，
   * 于是 until 仍然全挤在同一个 6—18 小时窗口里，铺不满一整天。
   * 相位改用 weatherPhaseAt —— 与冷启动同一个派生，铺满 24 小时。
   */
  since: now,
  until: now + weatherPhaseAt(seed, state.locationId),
}));

if (!dry) repo.upsertWeather(next, now);

const after = new Map<number, number>();
for (const state of next) after.set(state.until, (after.get(state.until) ?? 0) + 1);

const show = (title: string, m: Map<number, number>): void => {
  console.log(title + '：' + m.size + ' 个不同的到期时刻');
  for (const [until, n] of [...m].sort((a, b) => a[0] - b[0])) {
    console.log('  ' + new Date(until).toLocaleString() + '  →  ' + n + ' 个地点');
  }
};
console.log('世界 seed=' + seed + '，共 ' + states.length + ' 个地点' + (dry ? '（--dry 预演，不写库）' : ''));
show('打散前', before);
show('打散后', after);

// 已过期的地点会在下一个 tick 立刻换天气，这是正常的：它们本来就该换了
const overdue = next.filter((state) => state.until <= now).length;
if (overdue > 0) {
  console.log('注意：' + overdue + ' 个地点的到期时刻已经过了 —— 下一个 tick 会立刻给它们换天气。');
}
