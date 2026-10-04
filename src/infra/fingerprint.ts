import type { InternalMessage } from '../adapter/types.ts';

/**
 * 设备指纹钩子（W4：只留接口不实现）。
 *
 * 现状：OneBot v11 报文里没有 IP / 设备字段，因此实现恒返回 null，
 * 交易风控会退化成「按账号」统计（W3 已有行为）。
 * 接官方机器人（或自建网关拿到 IP）后，只要在这里返回一个稳定的 key，
 * 小号限制就会自动切到「同设备」维度 —— 业务侧的判断已经写成 if (fp) { ... }。
 */
export interface DeviceFingerprint {
  /** 稳定标识：同一设备/网络下应尽量一致 */
  key: string;
  /** 来源，便于审计与排查 */
  source: string;
  /** 原始信息（可选，仅用于排查，不入库） */
  raw?: string;
}

export interface FingerprintProvider {
  fingerprintOf(msg: InternalMessage): DeviceFingerprint | null;
}

/** 默认实现：拿不到任何设备信息 */
export const nullFingerprintProvider: FingerprintProvider = {
  fingerprintOf: () => null,
};

export class OneBotFingerprintProvider implements FingerprintProvider {
  /** OneBot 上报不含 IP/设备；等官方机器人或自建网关补齐 */
  fingerprintOf(_msg: InternalMessage): DeviceFingerprint | null {
    return null;
  }
}

/** 测试与本地联调用：把指纹固定成某个值 */
export class StaticFingerprintProvider implements FingerprintProvider {
  #key: string | null;

  constructor(key: string | null) {
    this.#key = key;
  }

  fingerprintOf(_msg: InternalMessage): DeviceFingerprint | null {
    return this.#key === null ? null : { key: this.#key, source: 'static' };
  }
}
