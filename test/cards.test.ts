import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { lintCard, loadRegistry, type ContentRegistry } from '../src/cards/lint.ts';
import { parseCard, type EventCard } from '../src/cards/schema.ts';
import { lintAll } from '../src/cards/lint-cli.ts';
import { loadCards } from '../src/cards/loader.ts';
import { loadLocations } from '../src/data/loader.ts';

/** 测试里手写的卡先过 schema，拿到 cooldown_days 之类的默认值 */
function asCard(raw: unknown): EventCard {
  // M2.40：`name` 已成必填（群里的显示名）—— 手写的卡在唯一入口补默认值
  const withName = typeof raw === 'object' && raw !== null && !('name' in raw) ? { name: '测试卡', ...raw } : raw;
  const parsed = parseCard(withName);
  assert.equal(parsed.ok, true, `测试卡本身不合法：${parsed.ok ? '' : parsed.issues.join('; ')}`);
  if (!parsed.ok) throw new Error('unreachable');
  return parsed.card;
}

const registryFile = new URL('../src/cards/registry.yaml', import.meta.url);
const cardFile = new URL('../src/cards/daily/daily_001.yaml', import.meta.url);

function registry(): ContentRegistry {
  return loadRegistry(parseYaml(readFileSync(registryFile, 'utf8')));
}

test('schema：合法事件卡通过，缺字段报错', () => {
  const good = parseCard(parseYaml(readFileSync(cardFile, 'utf8')));
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.equal(good.card.id, 'daily_001');
    assert.equal(good.card.daily_limit, 1);
    assert.equal(good.card.trigger.type, 'daily');
  }

  const bad = parseCard({ id: 'x', trigger: { type: 'daily' } });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.ok(bad.issues.some((i) => i.includes('texts')));
});

test('lint：引用不存在的物品/flag/地点一律报 error', () => {
  const card = asCard({
    id: 'daily_999',
    trigger: { type: 'daily', weight: 10, cond: ['flag:not_exist'] },
    effects: [{ item: '不存在的物品', n: 1 }],
    texts: { priv: '一段足够长的氛围文本内容' },
    daily_limit: 1,
  });
  const issues = lintCard(card, registry());
  const errors = issues.filter((i) => i.level === 'error').map((i) => i.message);
  assert.ok(errors.some((m) => m.includes('未登记 flag')));
  assert.ok(errors.some((m) => m.includes('未登记物品')));
});

test('lint：明显设计错误（空效果、权重为 0、序列区间反了）', () => {
  const card = asCard({
    id: 'daily_998',
    trigger: { type: 'daily', weight: 0, cond: [], min_seq: 8, max_seq: 3, location: ['不存在的地方'] },
    effects: [],
    texts: { priv: '短' },
    daily_limit: 1,
  });
  const issues = lintCard(card, registry());
  const errors = issues.filter((i) => i.level === 'error').map((i) => i.message);
  const warns = issues.filter((i) => i.level === 'warn').map((i) => i.message);
  assert.ok(errors.some((m) => m.includes('weight 必须大于 0')));
  assert.ok(errors.some((m) => m.includes('min_seq(8) 不能大于 max_seq(3)')));
  assert.ok(errors.some((m) => m.includes('未登记地点')));
  assert.ok(warns.some((m) => m.includes('没有任何 effects')));
  assert.ok(warns.some((m) => m.includes('texts.priv 太短')));
});

test('lint：location 引用必须能在 locations 数据里找到（W4 验收项）', () => {
  const { locations } = loadLocations();
  const known = new Set(locations.map((location) => location.name));
  const { cards } = loadCards();

  for (const card of cards) {
    for (const location of card.trigger.location ?? []) {
      for (const name of location.split('/')) {
        assert.ok(known.has(name.trim()), `${card.id} 引用了不存在的地点：${name}`);
      }
    }
    for (const cond of card.trigger.cond) {
      if (!cond.startsWith('location:')) continue;
      const name = cond.slice('location:'.length);
      assert.ok(known.has(name), `${card.id} 的 cond 引用了不存在的地点：${name}`);
    }
  }

  // 反例：引用不存在的地点必须被 lint 拦下
  const bad = asCard({
    id: 'daily_997',
    trigger: { type: 'daily', weight: 5, cond: [], location: ['不存在的地点'] },
    effects: [{ dig: 1 }],
    texts: { priv: '一段足够长的氛围文本内容' },
    daily_limit: 1,
  });
  const issues = lintCard(bad, registry());
  assert.ok(issues.some((issue) => issue.level === 'error' && issue.message.includes('未登记地点')));
});

test('lint：仓库里的事件卡零 error，且 W2 内容量达标', () => {
  const issues = lintAll();
  const errors = issues.filter((i) => i.level === 'error');
  assert.deepEqual(errors, []);
  const { cards } = loadCards();
  assert.ok(cards.length >= 30, `W2 要求 30 张日常卡，当前 ${cards.length} 张`);
  assert.deepEqual(
    [...new Set(cards.map((c) => c.id))].length,
    cards.length,
    '卡 id 不能重复',
  );
});
