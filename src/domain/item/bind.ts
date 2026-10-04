import { z } from 'zod';

/** 单独成文件：地点 / 背包 / 交易都要用，避免循环依赖 */
export const BindTypeSchema = z.enum(['bound', 'unbound']);

/** bound = 绑定（不可交易）；unbound = 非绑定 */
export type BindType = z.infer<typeof BindTypeSchema>;
