/**
 * M2.45：**QQ 平台的图片域名白名单**。
 *
 * 这一条把「图为什么裂」彻底钉死了：平台按一份硬编码的 SSRF 白名单下载图片，
 * 不在名单里的域名**一定**显示不出来 —— 与稳定性、HTTPS、防盗链都无关。
 * 名单来源与完整踩坑记录见 docs/QQ-markdown-能力实测.md。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MEDIA_HOSTS, isAllowedMediaHost } from '../src/card/media-host.ts';

test('白名单内的域名：平台取得到（头像为什么一定能显示）', () => {
  for (const url of [
    'https://q.qlogo.cn/qqapp/1905686871/ABC/100',
    'https://gchat.qpic.cn/abc.png',
    'https://qbot.ugcimg.cn/1905686871/a/b',
    'https://multimedia.nt.qq.com.cn/download?fileid=1',
    'https://bucket-125.cos.ap-guangzhou.myqcloud.com/cards/x.png',
    'https://cdn.example.tencentcos.cn/cards/x.png',
    'https://cdn.example.tencentcos.com/cards/x.png',
    'https://share.weiyun.com/x.png',
  ]) {
    assert.equal(isAllowedMediaHost(url), true, `应当放行：${url}`);
  }
});

test('白名单外的域名：一律取不到 —— 我们试过的全在这里', () => {
  for (const url of [
    // 三次真机裂图的现场
    'https://picui.ogmua.cn/s1/2026/09/30/x.webp',
    'https://n.uguu.se/x.png',
    // 还没配就对的（它也一样会裂）
    'https://cdn.jsdelivr.net/gh/me/cards@main/cards/x.png',
    'https://raw.githubusercontent.com/me/cards/main/x.png',
    // 自建托管同样无效：自建域名不可能落在那九个里
    'https://my-own-host.example.com/cards/x.png',
  ]) {
    assert.equal(isAllowedMediaHost(url), false, `应当拦下：${url}`);
  }
});

test('畸形 URL 不抛错（返回 false，绝不让渲染层崩）', () => {
  assert.equal(isAllowedMediaHost(''), false);
  assert.equal(isAllowedMediaHost('not a url'), false);
  assert.equal(isAllowedMediaHost('//q.qlogo.cn/x'), false, '没有协议的相对地址不算');
});

test('名单条数是写死的 G 表（平台改名单时这条会红，提醒去看文档）', () => {
  assert.equal(MEDIA_HOSTS.length, 9);
  assert.deepEqual([...MEDIA_HOSTS], [
    '*.qpic.cn',
    // 头像域名：开源项目那份名单里没有，但实测能显示 ⇒ 留下，并注明依据
    '*.qlogo.cn',
    '*.qq.com',
    '*.weiyun.com',
    '*.qq.com.cn',
    '*.ugcimg.cn',
    '*.myqcloud.com',
    '*.tencentcos.cn',
    '*.tencentcos.com',
  ]);
});
