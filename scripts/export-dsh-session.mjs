#!/usr/bin/env node
// scripts/export-dsh-session.mjs —— 把 DSH（DeepSeek Harness）的会话记录导出为可读 Markdown
//
// 数据源：~/.dsh/sessions/<工作区转义名>/session-<id>/session.v4.jsonl.zstd
// 文件是「多帧 zstd 拼接」的 JSONL：每一帧是独立的 zstd 流，Node 的
// zstdDecompressSync 只解第一帧，所以必须逐帧定位（magic: 28 B5 2F FD）解压，
// 再按事件的 seq 去重排序恢复完整事件流。
//
// 用法：
//   node scripts/export-dsh-session.mjs            # 列出设备上的全部会话
//   node scripts/export-dsh-session.mjs --all      # 导出全部会话
//   node scripts/export-dsh-session.mjs --id session-582b59b6   # 导出指定会话
//
// 输出：dsh-sessions/<工作区名>-<会话短id>.md

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

const DSH_SESSIONS = path.join(os.homedir(), '.dsh', 'sessions');
const OUT_DIR = path.join(process.cwd(), 'dsh-sessions');
const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);
const MAX_ARG = 1500;    // 工具参数截断
const MAX_RESULT = 3000; // 工具结果截断

/** 逐帧解压多帧 zstd 文件，返回全部 JSONL 文本行（可能有重复，靠 seq 去重） */
function decompressMultiframe(buf) {
  const positions = [];
  let idx = buf.indexOf(MAGIC);
  while (idx !== -1) { positions.push(idx); idx = buf.indexOf(MAGIC, idx + 1); }
  const lines = [];
  for (const pos of positions) {
    try {
      const out = zlib.zstdDecompressSync(buf.subarray(pos)).toString('utf8');
      for (const l of out.split('\n')) if (l.trim()) lines.push(l);
    } catch { /* 压缩数据内部的巧合 magic，跳过 */ }
  }
  return lines;
}

/** 读取一个会话：返回 { header, events } */
async function loadSession(zstdPath) {
  const buf = await fs.readFile(zstdPath);
  const bySeq = new Map();
  let header = null;
  for (const l of decompressMultiframe(buf)) {
    try {
      const j = JSON.parse(l);
      if (j.type === 'session') { header = j; continue; }
      if (typeof j.seq === 'number') bySeq.set(j.seq, j);
    } catch { /* 忽略坏行 */ }
  }
  const events = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return { header, events };
}

async function listSessions() {
  const out = [];
  for (const ws of await fs.readdir(DSH_SESSIONS).catch(() => [])) {
    const wsDir = path.join(DSH_SESSIONS, ws);
    for (const sess of await fs.readdir(wsDir).catch(() => [])) {
      const f = path.join(wsDir, sess, 'session.v4.jsonl.zstd');
      const st = await fs.stat(f).catch(() => null);
      if (st) out.push({ workspaceDir: ws, sessionId: sess, file: f, size: st.size, mtime: st.mtime });
    }
  }
  return out;
}

function fmtTime(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function clip(text, max) {
  const t = String(text ?? '');
  return t.length > max ? t.slice(0, max) + '\n…（截断，共 ' + t.length + ' 字符）' : t;
}

function fence(text) {
  const t = String(text ?? '');
  // 防止内容里的反引号破坏代码围栏
  const maxRun = (t.match(/`+/g) ?? []).reduce((m, s) => Math.max(m, s.length), 0);
  return '\`\`\`' + '`'.repeat(Math.max(0, maxRun)) + '\n' + t + '\n' + '`'.repeat(Math.max(0, maxRun)) + '\`\`\`';
}

const META_TYPES = new Set(['turn/start', 'turn/end', 'step/start', 'step/end', 'request/header', 'request/context', 'session/title-llm-request']);

function renderSession(header, events) {
  const L = [];
  const cwd = header?.cwd ?? '(未知工作区)';
  const modelEv = events.find(e => e.type === 'model/selection');
  L.push('# DSH 会话导出：' + path.basename(cwd));
  L.push('');
  L.push('| 项目 | 值 |');
  L.push('| --- | --- |');
  L.push('| 会话 id | `' + (header?.id ?? '?') + '` |');
  L.push('| 工作区 | `' + cwd + '` |');
  L.push('| 创建时间 | ' + fmtTime(header?.createdAt) + ' |');
  if (modelEv) L.push('| 模型 | ' + (modelEv.data?.provider ?? '?') + ' / ' + (modelEv.data?.model ?? '?') + ' |');
  const preset = events.filter(e => e.type === 'permission/preset').at(-1);
  if (preset) L.push('| 权限策略 | ' + (preset.data?.preset ?? '?') + ' |');
  const title = events.find(e => e.type === 'session/title');
  if (title?.data?.title) L.push('| 标题 | ' + title.data.title + ' |');
  L.push('| 导出时间 | ' + fmtTime(Date.now()) + ' |');
  L.push('');
  L.push('> 由 `scripts/export-dsh-session.mjs` 生成。截断处标注了原始长度；reasoning 折叠显示。');
  L.push('');

  // 工具调用按 callId 配对结果
  const results = new Map();
  for (const e of events) if (e.type === 'tool/result') results.set(e.data?.message?.toolCallId, e);

  let lastTurn = null;
  for (const e of events) {
    const turn = e.data?.turn;
    if (typeof turn === 'number' && turn !== lastTurn) {
      lastTurn = turn;
      L.push('---');
      L.push('');
    }
    const t = fmtTime(e.time);
    switch (e.type) {
      case 'user/message': {
        const kind = e.data?.source?.kind;
        const label = kind && kind !== 'user' ? '用户（' + kind + '）' : '用户';
        L.push('## 🧑 ' + label + '　<sub>' + t + '</sub>');
        L.push('');
        for (const b of e.data?.content ?? []) {
          if (b.type === 'text') { L.push(b.text); L.push(''); }
          else L.push('> （' + b.type + ' 块）');
        }
        break;
      }
      case 'assistant/message': {
        L.push('## 🤖 助手　<sub>' + t + '</sub>');
        L.push('');
        for (const b of e.data?.message?.content ?? []) {
          if (b.type === 'text') { L.push(b.text); L.push(''); }
          else if (b.type === 'reasoning') {
            L.push('<details><summary>💭 思考过程</summary>');
            L.push('');
            L.push(clip(b.thinking ?? b.text ?? '', 4000));
            L.push('');
            L.push('</details>');
            L.push('');
          } else if (b.type === 'tool-call') {
            L.push('🔧 调用工具 `' + (b.name ?? b.toolName ?? '?') + '`（见下方工具节）');
            L.push('');
          } else L.push('> （' + b.type + ' 块）');
        }
        break;
      }
      case 'tool/call': {
        L.push('### 🔧 `' + (e.data?.name ?? '?') + '`　<sub>' + t + '</sub>');
        L.push('');
        let args = e.data?.arguments ?? '';
        try { args = JSON.stringify(JSON.parse(args), null, 1); } catch {}
        L.push(fence(clip(args, MAX_ARG)));
        L.push('');
        const r = results.get(e.data?.callId);
        if (r) {
          const texts = (r.data?.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
          L.push('**结果：**');
          L.push('');
          L.push(fence(clip(texts, MAX_RESULT)));
          L.push('');
        }
        break;
      }
      case 'tool/result': break; // 已在上面配对输出
      case 'system/message': {
        L.push('> ⚙️ 系统消息（' + t + '）：' + clip(JSON.stringify(e.data), 300));
        L.push('');
        break;
      }
      case 'approval/policy':
      case 'permission/preset':
      case 'sandbox/mode':
      case 'model/selection':
      case 'session/title': {
        L.push('> ⚙️ `' + e.type + '`（' + t + '）：`' + clip(JSON.stringify(e.data), 200) + '`');
        L.push('');
        break;
      }
      case 'agent/inbox/spliced': {
        L.push('> 📥 收件箱注入（' + t + '）：' + clip(JSON.stringify(e.data), 500));
        L.push('');
        break;
      }
      case 'command/run': {
        L.push('> ⌨️ 命令 `' + (e.data?.name ?? '?') + '`（' + t + '）');
        L.push('');
        break;
      }
      default:
        if (!META_TYPES.has(e.type)) {
          L.push('> ⚙️ ' + e.type + '（' + t + '）');
          L.push('');
        }
    }
  }
  return L.join('\n');
}

function outName(info, header) {
  const wsName = path.basename(header?.cwd ?? info.workspaceDir).replace(/[\\/:*?"<>|]/g, '_');
  const shortId = (info.sessionId ?? '').replace(/^session-/, '').slice(0, 8);
  return wsName + '-' + shortId + '.md';
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const idIdx = args.indexOf('--id');
  const wantId = idIdx !== -1 ? args[idIdx + 1] : null;

  const sessions = await listSessions();
  if (!sessions.length) { console.log('未找到任何会话记录（' + DSH_SESSIONS + '）'); return; }

  if (!all && !wantId) {
    console.log('设备上共 ' + sessions.length + ' 个会话：');
    for (const s of sessions.sort((a, b) => b.mtime - a.mtime)) {
      const { header, events } = await loadSession(s.file);
      const title = events.find(e => e.type === 'session/title')?.data?.title ?? '(无标题)';
      console.log('  ' + (header?.id ?? '?') + '  ' + (header?.cwd ?? '?') + '  事件 ' + events.length + ' 条  ' + title);
    }
    console.log('\n用 --all 导出全部，或 --id <会话id> 导出指定会话。');
    return;
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  for (const s of sessions) {
    const { header, events } = await loadSession(s.file);
    if (wantId && !(header?.id ?? '').startsWith(wantId)) continue;
    const md = renderSession(header, events);
    const out = path.join(OUT_DIR, outName(s, header));
    await fs.writeFile(out, md, 'utf8');
    console.log('已导出 ' + events.length + ' 个事件 → ' + out);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
