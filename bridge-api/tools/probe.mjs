#!/usr/bin/env node
/**
 * 联调小工具：往 bridge-api 发一条消息，把回执打出来。
 *
 * ## 为什么要有它
 *
 * 「新版本能不能用」在真接上 BEE / Koishi 之前是**没法回答**的 ——
 * 而上游框架那边一旦不通，是框架的问题还是游戏的问题，靠猜很费时间。
 * 这个小工具只依赖 Node（没有任何三方库），把那条链路单独跑一遍：
 *
 *     node bridge-api/tools/probe.mjs --text ".帮助" --user 20001
 *
 * 想连服务器上的实例：
 *
 *     node bridge-api/tools/probe.mjs --api http://10.0.0.5:3200 --token 你的口令 --text ".状态"
 */
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    api: { type: 'string', default: 'http://127.0.0.1:3200' },
    token: { type: 'string', default: '' },
    text: { type: 'string', default: '.帮助' },
    user: { type: 'string', default: 'probe-user' },
    scene: { type: 'string', default: 'private' },
    sceneId: { type: 'string', default: '' },
    platform: { type: 'string', default: 'probe' },
    nickname: { type: 'string', default: '联调探针' },
    poll: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

const api = values.api.replace(/\/+$/, '');
const headers = {
  'content-type': 'application/json',
  ...(values.token !== '' ? { authorization: `Bearer ${values.token}` } : {}),
};
const sceneId = values.sceneId !== '' ? values.sceneId : values.user;

console.log(`→ ${api}/api/v1/inbound`);
const res = await fetch(`${api}/api/v1/inbound`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    platform: values.platform,
    scene: values.scene,
    sceneId,
    userId: values.user,
    nickname: values.nickname,
    text: values.text,
    messageId: `probe-${Date.now()}`,
    sync: true,
  }),
});
const body = await res.json();
if (!res.ok) {
  console.error('入站失败：', res.status, JSON.stringify(body, null, 2));
  process.exit(1);
}
const replies = body.replies ?? [];
console.log(`← 同步回执 ${replies.length} 条`);
for (const item of replies) {
  console.log('─'.repeat(60));
  console.log(`[${item.kind}] ${item.scene} → ${item.targetId}${item.platform ? ` （回给 ${item.platform}）` : ''}`);
  if (item.header) {
    console.log(`  头像: ${item.header.avatarUrl ?? '(无)'} | ${item.header.nickname} ${item.header.pathwayLine ?? ''}`);
  }
  if (item.image) console.log(`  图片: ${item.image.mediaType} ${item.image.base64 ? item.image.base64.length + ' 字符 base64' : item.image.url}`);
  if (item.options) console.log(`  选项: ${item.options.map((o) => `${o.id}.${o.label}`).join(' ')}`);
  console.log(item.text);
}

if (values.poll) {
  console.log('\n→ 轮询 /api/v1/outbound（含主动推送）');
  const pulled = await fetch(`${api}/api/v1/outbound?cursor=0&limit=20&platform=${values.platform}`, { headers });
  const batch = await pulled.json();
  console.log(`← ${batch.items.length} 条，cursor=${batch.cursor}${batch.gap ? '（gap：中间有被裁掉的）' : ''}`);
  for (const item of batch.items) {
    console.log(`  #${item.seq} [${item.kind}] ${item.scene} → ${item.targetId}：${item.text.split('\n')[0]}`);
  }
}
