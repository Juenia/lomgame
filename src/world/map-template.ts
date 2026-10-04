/**
 * 世界地图的 HTML 模板（M2.54）—— **画什么全在这儿**，纯函数、无 IO。
 *
 * ## 版式
 *
 *   顶部：世界时钟（时段 / 月相 / 雾日 / 季节）+ 世界种子
 *   中部：区域 → 城市 → 地点。每个地点一格，**左侧色条 = 天气**，**底色明暗 = 危险度**
 *   底部：图例（只列此刻真的出现过的天气）+ 玩家位置
 *
 * ## 两条排版原则
 *
 * 1. **正常压下去，异常跳出来。** 全服大多是好天气，如果每种天气都画得一样重，
 *    图上就全是噪音。所以只有罕见天气（血月 / 灰雾潮 / 灵界渗透）给发光边框，
 *    其余安静地待着 —— 玩家的视线应该被"哪里不对"吸引。
 * 2. **不给不存在的数字留位置。** 图上每一个字都来自世界状态；没有的东西不画，
 *    宁可留白，也不摆一个好看的假指标（这是项目对卡面定过的同一条规矩）。
 */
import type { WorldMapData } from './map.ts';

/** 设计网格。出图是它的 scale 倍（默认 2） */
export const MAP_W = 620;
export const MAP_H = 1120;

/** 天气 → 颜色。与角色卡同一套暗色调（金 / 灰 / 暗红） */
const WEATHER_COLOR: Record<string, string> = {
  clear: '#c9a961',
  fog: '#8d8a7e',
  rain: '#5f7d8c',
  storm: '#7a6a9a',
  silence: '#4a4a46',
  blood_moon: '#a83c3c',
  greyfog_tide: '#728470',
  spirit_creep: '#3f7d68',
};

const colorOf = (weatherId: string): string => WEATHER_COLOR[weatherId] ?? '#6b6960';

/** 危险度 → 底色深浅（1 最浅、4 最深）。用底色而不是图标：图标要图例，底色不用 */
const DANGER_BG = ['', 'rgba(201,169,97,.045)', 'rgba(201,169,97,.075)', 'rgba(181,96,63,.085)', 'rgba(181,96,63,.14)'];

function esc(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CSS = [
  '*{margin:0;padding:0;box-sizing:border-box}',
  'body{width:' + MAP_W + 'px;height:' + MAP_H + 'px;background:#0f1310;color:#e2ddd0;',
  '  font:13px/1.5 "Noto Sans SC","Microsoft YaHei",sans-serif;overflow:hidden}',
  '.wrap{padding:22px 24px}',
  /* 顶部 */
  '.head{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid rgba(201,169,97,.22);padding-bottom:9px}',
  '.head h1{font-size:19px;font-weight:400;letter-spacing:.34em;color:#c9a961}',
  '.head .seed{font-size:10.5px;color:#5f5d55;letter-spacing:.08em}',
  '.clock{margin-top:9px;font-size:12.5px;color:#9d9a8c;letter-spacing:.04em}',
  '.clock b{color:#e8d3a0;font-weight:400}',
  '.clock .fog{color:#c9c4b4}',
  /* 区域 / 城市 */
  '.region{margin-top:15px}',
  '.region>h2{font-size:12px;font-weight:400;color:#c9a961;letter-spacing:.22em;',
  '  border-left:2px solid #c9a961;padding-left:8px;margin-bottom:8px}',
  '.city{margin-bottom:9px;background:#0a0e0b;border:1px solid rgba(201,169,97,.11);padding:7px 9px 9px}',
  '.city>h3{font-size:11.5px;font-weight:400;color:#a9a496;letter-spacing:.1em;margin-bottom:7px}',
  '.locs{display:flex;flex-wrap:wrap;gap:4px}',
  /* 地点格 */
  '.loc{position:relative;width:90px;height:36px;padding:4px 6px 4px 10px;',
  '  display:flex;align-items:center;overflow:hidden}',
  '.loc .bar{position:absolute;left:0;top:0;bottom:0;width:4px}',
  '.loc .nm{font-size:10.5px;line-height:1.25;color:#ddd8ca;overflow:hidden;',
  '  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
  '.loc.epic{box-shadow:0 0 0 1px rgba(201,169,97,.4), 0 0 10px -2px rgba(201,169,97,.35)}',
  '.loc.epic .nm{color:#f0e6cd}',
  '.loc.here{box-shadow:0 0 0 1.5px #c9a961}',
  '.loc.here::after{content:"◉";position:absolute;right:4px;bottom:1px;font-size:9px;color:#c9a961}',
  '.loc .soon{position:absolute;right:4px;top:4px;width:5px;height:5px;border-radius:50%;',
  '  background:#c9a961;box-shadow:0 0 5px rgba(201,169,97,.85)}',
  '.legend i.dot{width:8px;height:8px;border-radius:50%;background:#c9a961;',
  '  box-shadow:0 0 5px rgba(201,169,97,.85)}',
  /* 底部 */
  '.foot{margin-top:16px;border-top:1px solid rgba(201,169,97,.18);padding-top:10px}',
  '.legend{display:flex;flex-wrap:wrap;gap:11px}',
  '.legend span{display:flex;align-items:center;gap:5px;font-size:11px;color:#9d9a8c}',
  '.legend i{width:9px;height:9px;display:block}',
  '.stat{margin-top:9px;font-size:11px;color:#6b6960;letter-spacing:.04em}',
  '.stat b{color:#c9a961;font-weight:400}',
  '.herebar{margin-top:8px;font-size:12px;color:#e8d3a0}',
  '.herebar em{font-style:normal;color:#6b6960;margin-right:6px}',
].join('\n');

type MapLoc = WorldMapData['regions'][number]['cities'][number]['locations'][number];

function locationBox(location: MapLoc): string {
  const cls = ['loc'];
  if (location.epic) cls.push('epic');
  if (location.here) cls.push('here');
  const color = colorOf(location.weatherId);
  const base = DANGER_BG[location.danger] ?? DANGER_BG[1];
  /*
   * 天气色**晕染进格子左边**，而不是只在最左侧画一条 4px 的线。
   * 实测第一版：58 个格子里那条细线在手机上看几乎分辨不出（晴的金和雾的灰尤其像），
   * 整张图读起来就是一片同色的方块 —— 那就白画了。
   */
  const bg = 'linear-gradient(90deg,' + color + '2e 0,' + color + '16 15%,' + base + ' 24%,' + base + ' 100%)';
  return '<div class="' + cls.join(' ') + '" style="background:' + bg + '">' +
    '<i class="bar" style="background:' + color + '"></i>' +
    '<div class="nm">' + esc(location.name) + '</div>' +
    // 金点 = 三小时内会变天。世界在动，就靠这一颗点说出来
    (location.changesInMin === null ? '' : '<i class="soon"></i>') +
    '</div>';
}

function cityBlock(city: WorldMapData['regions'][number]['cities'][number]): string {
  return '<div class="city"><h3>' + esc(city.name) + '</h3>' +
    '<div class="locs">' + city.locations.map(locationBox).join('') + '</div></div>';
}

export function worldMapHtml(data: WorldMapData): string {
  const clock = data.clock;
  const parts: string[] = [];
  parts.push('<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>' + CSS + '</style></head><body>');
  parts.push('<div class="wrap">');

  parts.push('<div class="head"><h1>世 界</h1>' +
    '<div class="seed">世界种子 ' + esc(data.seed) + '</div></div>');
  parts.push('<div class="clock">' +
    '<b>' + esc(clock.timeOfDayLabel) + '</b>　·　' +
    esc(clock.seasonLabel) + '　·　月相 第 ' + clock.moonPhase + ' 日' +
    (clock.fullMoon ? '（<b>月圆</b>）' : '') + '　·　' +
    (clock.foggy ? '<span class="fog">雾日</span>' : '无雾') +
    '</div>');

  for (const region of data.regions) {
    parts.push('<div class="region"><h2>' + esc(region.name) + '</h2>' +
      region.cities.map(cityBlock).join('') + '</div>');
  }
  if (data.orphans.length > 0) {
    parts.push('<div class="region"><h2>无所属</h2><div class="city"><h3>未归属任何城市</h3>' +
      '<div class="locs">' + data.orphans.map(locationBox).join('') + '</div></div></div>');
  }

  parts.push('<div class="foot">');
  parts.push('<div class="legend">' + data.legend.map((item) =>
    '<span><i style="background:' + colorOf(item.id) + '"></i>' + esc(item.label) + '</span>').join('') +
    '<span><i class="dot"></i>三小时内变天</span>' +
    '</div>');
  parts.push('<div class="stat">' + data.stats.regions + ' 个区域　·　' + data.stats.cities +
    ' 座城市　·　<b>' + data.stats.locations + '</b> 处地点' +
    (data.stats.epic > 0 ? '　·　<b>' + data.stats.epic + '</b> 处异象' : '　·　全境平静') +
    (data.stats.soon > 0 ? '　·　<b>' + data.stats.soon + '</b> 处即将变天' : '') +
    '</div>');
  if (data.here !== null) {
    parts.push('<div class="herebar"><em>你在</em>' + esc(data.here.locationName) + '</div>');
  }
  parts.push('</div>');

  parts.push('</div></body></html>');
  return parts.join('\n');
}
