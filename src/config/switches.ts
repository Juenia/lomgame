/**
 * 应急开关（W6 封测）
 *
 * 封测期数值冻结，只允许通过这里的开关做「热修」，不做数值改动：
 *   - purifyHalfCost：净化消耗减半（失控/污染死循环时的 P0 处置手段）
 *   - deadlockAlertThreshold：死循环比例超过该值就告警
 * 开关可以来自环境变量，也可以在运行期用 setSwitch 临时打开（用于演练与测试）。
 */
export interface RuntimeSwitches {
  purifyHalfCost: boolean;
  deadlockAlertThreshold: number;
  /** 告警接收人（客服/管理员 QQ），为空则只写日志 */
  adminUserId: string | null;
}

const DEFAULTS: RuntimeSwitches = {
  purifyHalfCost: false,
  deadlockAlertThreshold: 0.05,
  adminUserId: null,
};

const current: RuntimeSwitches = { ...DEFAULTS };

/**
 * 从环境变量装载开关。
 * 注意返回的是**同一个活对象**（不是拷贝）：指令层持有它，运行期 setSwitch 才能立刻生效。
 */
export function loadSwitches(env: NodeJS.ProcessEnv = process.env): RuntimeSwitches {
  current.purifyHalfCost = env.EMERGENCY_PURIFY_HALF?.trim() === '1';
  current.deadlockAlertThreshold = Number(env.DEADLOCK_ALERT_THRESHOLD ?? DEFAULTS.deadlockAlertThreshold);
  current.adminUserId = env.ADMIN_QQ ?? null;
  return current;
}

export function getSwitches(): RuntimeSwitches {
  return { ...current };
}

export function setSwitch<K extends keyof RuntimeSwitches>(name: K, value: RuntimeSwitches[K]): void {
  current[name] = value;
}

export function resetSwitches(): void {
  Object.assign(current, DEFAULTS);
}
