/**
 * 选项驱动（M2.3）域层出口。
 *
 * 目录结构：
 *   types.ts         数据形状（MenuOption / Menu / WorldSnapshot / PathwayKit）
 *   phrases.ts       标签 → 人话（文案表，不是判定）
 *   play-menu.ts     buildPlayMenu（`.扮演` 的选项生成器）
 *   explore-menu.ts  buildExploreMenu（`.探索 地点` 的选项生成器）
 *   today-menu.ts    buildLocationMenu / buildTodayMenu（`.探索` 无参与 `.今日` 的入口菜单）
 *   next-menu.ts     buildNextMenu（执行完一条指令后的「下一步」选项）
 *   render.ts        Menu → 文本
 */
export * from './types.ts';
export { buildPlayMenu, matchLabel, pathwayKit } from './play-menu.ts';
export { buildExploreMenu } from './explore-menu.ts';
export { buildLocationMenu, buildTodayMenu } from './today-menu.ts';
export { buildNextMenu } from './next-menu.ts';
export { renderWorldEvent, worldEventMenu } from './world-event.ts';
export { FREEFORM_LABEL, renderMenu, renderNextMenu, renderOption } from './render.ts';
export { installTagPhrases, phraseOf, situationBias, SITUATION_NOTE } from './phrases.ts';
