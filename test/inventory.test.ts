import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InventoryRepo } from '../src/infra/db/inventory.ts';
import { migrate, openDatabase } from '../src/infra/db/sqlite.ts';
import { CharacterRepo } from '../src/infra/db/characters.ts';
import { ItemRepo } from '../src/infra/db/items.ts';
import { loadItems } from '../src/data/loader.ts';
import { buildInitialCharacter } from '../src/router/commands/create.ts';

function setup() {
  const db = openDatabase(':memory:');
  migrate(db);
  const characters = new CharacterRepo(db);
  characters.ensureUser('u1', '克莱恩', 0);
  // M2.7.6：创建出来的是普通人（没有途径、没有序列）—— 这个仓库测试只需要一张卡
  const character = buildInitialCharacter({ userId: 'u1', name: '克莱恩', gender: 'male', now: 0 });
  characters.insert(character);
  const inventory = new InventoryRepo(db);
  const items = new ItemRepo(db);
  items.seed(loadItems().items);
  return { db, inventory, items, characterId: character.id };
}

test('背包：入包、累加、查询', () => {
  const { db, inventory, characterId } = setup();
  inventory.add(characterId, '夜香草', 2, 'bound', 1);
  inventory.add(characterId, '夜香草', 3, 'unbound', 2);
  assert.equal(inventory.count(characterId, '夜香草'), 5);
  assert.equal(inventory.countByBind(characterId, '夜香草', 'bound'), 2);
  assert.equal(inventory.countByBind(characterId, '夜香草', 'unbound'), 3);
  assert.equal(inventory.list(characterId).length, 2, '绑定与非绑定分开堆叠');
  db.close();
});

test('背包：扣减先扣非绑定，再扣绑定', () => {
  const { db, inventory, characterId } = setup();
  inventory.add(characterId, '便士', 3, 'unbound', 1);
  inventory.add(characterId, '便士', 5, 'bound', 1);
  assert.equal(inventory.tryRemove(characterId, '便士', 4, 2), true);
  assert.equal(inventory.countByBind(characterId, '便士', 'unbound'), 0);
  assert.equal(inventory.countByBind(characterId, '便士', 'bound'), 4);
  db.close();
});

test('背包：数量不足时整体失败，不做部分扣减', () => {
  const { db, inventory, characterId } = setup();
  inventory.add(characterId, '便士', 2, 'unbound', 1);
  assert.equal(inventory.tryRemove(characterId, '便士', 3, 2), false);
  assert.equal(inventory.count(characterId, '便士'), 2, '失败不能动库存');
  db.close();
});

test('背包：多材料全有或全无', () => {
  const { db, inventory, characterId } = setup();
  inventory.add(characterId, '夜香草', 2, 'bound', 1);
  inventory.add(characterId, '辅助材料·银粉', 1, 'bound', 1);
  const needs = [
    { itemId: '夜香草', qty: 2 },
    { itemId: '辅助材料·银粉', qty: 1 },
  ];
  assert.equal(inventory.tryRemoveMany(characterId, needs, 2), true);
  assert.equal(inventory.count(characterId, '夜香草'), 0);

  inventory.add(characterId, '夜香草', 1, 'bound', 3);
  assert.equal(inventory.tryRemoveMany(characterId, needs, 4), false, '缺一种就不扣任何材料');
  assert.equal(inventory.count(characterId, '夜香草'), 1);
  db.close();
});

test('背包：冻结即移出可用栏位，解冻后原样回来', () => {
  const { db, inventory, characterId } = setup();
  inventory.add(characterId, '辅助材料·银粉', 3, 'unbound', 1);
  assert.equal(inventory.freeze(characterId, '辅助材料·银粉', 2, 2), true);
  assert.equal(inventory.count(characterId, '辅助材料·银粉'), 1);
  inventory.add(characterId, '辅助材料·银粉', 2, 'unbound', 3);
  assert.equal(inventory.count(characterId, '辅助材料·银粉'), 3);
  db.close();
});

test('背包：分页每页 10 条，页码越界自动收敛', () => {
  const { db, inventory, characterId } = setup();
  for (let i = 1; i <= 13; i += 1) inventory.add(characterId, `测试物品${i}`, 1, 'unbound', i);
  const first = inventory.paginate(characterId, 1, 10);
  assert.equal(first.slots.length, 10);
  assert.equal(first.pages, 2);
  assert.equal(first.total, 13);
  const second = inventory.paginate(characterId, 2, 10);
  assert.equal(second.slots.length, 3);
  const clamped = inventory.paginate(characterId, 99, 10);
  assert.equal(clamped.page, 2, '页码越界收敛到最后一页');
  db.close();
});

test('物品元数据：货币（便士）不可绑定，消耗品有效果，魔药有归属', () => {
  const { db, items } = setup();
  assert.equal(items.get('便士')?.bindable, false);
  assert.equal(items.get('便士')?.kind, 'currency');
  assert.equal(items.get('便士')?.tradeable, true, '货币永不绑定，但必须能交易');
  assert.equal(items.get('教会徽记')?.tradeable, false, '身份物不可交易');
  assert.deepEqual(items.get('安神药剂')?.effect, { mad: -5, mp: 5 });
  assert.equal(items.get('potion_seer_9')?.pathway, 'seer');
  assert.equal(items.get('potion_seer_9')?.seq, 9);
  assert.equal(items.findByNameOrName('安神药剂')?.id, '安神药剂');
  assert.equal(items.findByNameOrName('不存在的东西'), null);
  assert.ok(items.count() >= 20);
  db.close();
});
