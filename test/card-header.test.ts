/**
 * M2.86：**顶部玩家信息条**（用户拍板）。
 *
 * > 「顶部玩家信息 <头像+昵称+性别符号抽象显示+换行+所在地点> 长久化图片绘制，置顶部，做常驻显示，
 * >   只有角色卡不显示，图片自绘增加缓存，不要每次都重画，没变化则不花」
 *
 * 这里守三件事：**画得对**（三个字段都在）、**缓存对**（没变化不重画）、**失败不阻塞**。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HEADER_H, HEADER_W, headerCacheKey, headerHtml, renderHeader } from '../src/card/header.ts';

const base = { nickname: '克莱恩', gender: 'male' as const, locationName: '廷根市 · 迷雾街区' };

test('信息条：昵称 / 性别符号 / 地点三个字段都在图上', () => {
  const html = headerHtml({ ...base, pathwayLabel: '占卜家 · 序列 9' });
  assert.ok(html.includes('克莱恩'), '要有昵称');
  assert.ok(html.includes('廷根市 · 迷雾街区'), '要有地点');
  assert.ok(html.includes('♂'), '性别要画成**符号**（用户说的「抽象显示」），不是汉字「男」');
  assert.ok(!html.includes('>男<'), '不该出现汉字性别');
  assert.ok(html.includes('占卜家'), '途径可选，给了就要画');
  assert.ok(html.includes(String(HEADER_W)) && html.includes(String(HEADER_H)), '尺寸要与设计网格一致');
});

test('信息条：三种性别各有各的符号与颜色', () => {
  const m = headerHtml({ ...base, gender: 'male' });
  const f = headerHtml({ ...base, gender: 'female' });
  const o = headerHtml({ ...base, gender: 'other' });
  assert.ok(m.includes('♂') && f.includes('♀') && o.includes('⚧'));
  assert.notEqual(m, f);
  assert.notEqual(f, o);
});

test('信息条：没有头像时画名字首字的纹章（降级路径）', () => {
  const html = headerHtml(base);
  assert.ok(html.includes('av mono'), '没有头像该走 mono 分支');
  assert.ok(html.includes('克'), '纹章用名字首字');
  const withAvatar = headerHtml({ ...base, avatarDataUri: 'data:image/png;base64,AAAA' });
  assert.ok(withAvatar.includes('<img'), '有头像就该用 img');
});

test('信息条：**没变化就不重画**（缓存键的三条纪律）', () => {
  const k1 = headerCacheKey(base);
  assert.equal(k1, headerCacheKey({ ...base }), '同样的输入必须同一个键');
  assert.notEqual(k1, headerCacheKey({ ...base, nickname: '奥黛丽' }), '换昵称要出新图');
  assert.notEqual(k1, headerCacheKey({ ...base, gender: 'female' }), '换性别要出新图');
  assert.notEqual(k1, headerCacheKey({ ...base, locationName: '贝克兰德' }), '**换地点要出新图**（这是最常变的一项）');
  assert.notEqual(k1, headerCacheKey({ ...base, avatarDataUri: 'data:image/png;base64,BBBB' }), '换头像要出新图');
  // 途径也要进键（「序列 9 → 序列 8」时那一行会变）
  assert.notEqual(k1, headerCacheKey({ ...base, pathwayLabel: '占卜家 · 序列 8' }));
});

test('信息条：出图失败**不抛异常**（装饰图不该卡死消息）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hdr-'));
  try {
    // 用一个不存在的 Edge 路径之类的方式很难模拟，这里改为验证：
    // 在 Edge 可用的机器上应当拿到 buffer；不可用时必须返回 undefined 而不是抛。
    let out: Awaited<ReturnType<typeof renderHeader>>;
    try {
      out = await renderHeader(base, { dir });
    } catch (error) {
      assert.fail('renderHeader 不该抛：' + String(error).slice(0, 120));
    }
    if (out !== undefined) {
      assert.ok(out.png.length > 0, '出了图就该有字节');
      assert.ok(existsSync(out.file), '出图要落盘（缓存）');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('信息条：第二次同内容必须命中缓存（0 次重画）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hdr2-'));
  try {
    const first = await renderHeader(base, { dir });
    if (first === undefined) return;   // 这台机器没有 Edge —— 跳过（不是失败）
    const second = await renderHeader(base, { dir });
    assert.ok(second !== undefined);
    assert.equal(second!.fromCache, true, '同内容第二次必须走缓存');
    assert.equal(second!.key, first.key);
    // 换了地点就该重画
    const changed = await renderHeader({ ...base, locationName: '贝克兰德 · 皇后区' }, { dir });
    assert.ok(changed !== undefined);
    assert.equal(changed!.fromCache, false, '换了地点必须重画');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
