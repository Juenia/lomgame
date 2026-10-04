/**
 * 背包规则（纯函数）：绑定/非绑定的堆叠与扣减规则只有这一份实现。
 * InventoryRepo（SQLite）与模拟器（内存）都调用这里，避免两套账本算法漂移。
 */
import type { BindType } from './bind.ts';

export interface Slot {
  itemId: string;
  bindType: BindType;
  quantity: number;
}

export interface Deduction {
  bindType: BindType;
  quantity: number;
}

export interface RemovalPlan {
  ok: boolean;
  /** 按「先扣非绑定，再扣绑定」算出的扣减明细 */
  deductions: Deduction[];
}

export function countOf(slots: readonly Slot[], itemId: string): number {
  return slots
    .filter((slot) => slot.itemId === itemId)
    .reduce((sum, slot) => sum + slot.quantity, 0);
}

export function countByBind(slots: readonly Slot[], itemId: string, bindType: BindType): number {
  return slots
    .filter((slot) => slot.itemId === itemId && slot.bindType === bindType)
    .reduce((sum, slot) => sum + slot.quantity, 0);
}

/** 单物品扣减计划：不足则 ok=false（绝不做部分扣减） */
export function planRemoval(slots: readonly Slot[], itemId: string, quantity: number): RemovalPlan {
  if (quantity <= 0) return { ok: true, deductions: [] };
  const unbound = countByBind(slots, itemId, 'unbound');
  const bound = countByBind(slots, itemId, 'bound');
  if (unbound + bound < quantity) return { ok: false, deductions: [] };

  const deductions: Deduction[] = [];
  const takeUnbound = Math.min(unbound, quantity);
  if (takeUnbound > 0) deductions.push({ bindType: 'unbound', quantity: takeUnbound });
  const rest = quantity - takeUnbound;
  if (rest > 0) deductions.push({ bindType: 'bound', quantity: rest });
  return { ok: true, deductions };
}

/** 多材料扣减计划：全有或全无 */
export function planRemovalMany(
  slots: readonly Slot[],
  needs: ReadonlyArray<{ itemId: string; qty: number }>,
): RemovalPlan & { perItem: Array<{ itemId: string; deductions: Deduction[] }> } {
  const perItem: Array<{ itemId: string; deductions: Deduction[] }> = [];
  for (const need of needs) {
    const plan = planRemoval(slots, need.itemId, need.qty);
    if (!plan.ok) return { ok: false, deductions: [], perItem: [] };
    perItem.push({ itemId: need.itemId, deductions: plan.deductions });
  }
  return { ok: true, deductions: perItem.flatMap((entry) => entry.deductions), perItem };
}

export function addItem(slots: Slot[], itemId: string, quantity: number, bindType: BindType): void {
  if (quantity <= 0) return;
  const existing = slots.find((slot) => slot.itemId === itemId && slot.bindType === bindType);
  if (existing) existing.quantity += quantity;
  else slots.push({ itemId, bindType, quantity });
}

export function removeItem(
  slots: Slot[],
  itemId: string,
  quantity: number,
  now?: number,
): boolean {
  void now;
  const plan = planRemoval(slots, itemId, quantity);
  if (!plan.ok) return false;
  for (const deduction of plan.deductions) {
    const slot = slots.find(
      (candidate) => candidate.itemId === itemId && candidate.bindType === deduction.bindType,
    );
    if (slot) slot.quantity -= deduction.quantity;
  }
  for (let i = slots.length - 1; i >= 0; i -= 1) {
    if ((slots[i]?.quantity ?? 0) <= 0) slots.splice(i, 1);
  }
  return true;
}
