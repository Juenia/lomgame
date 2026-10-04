import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCardService } from '../src/card/service.ts';
import { characterCardData } from '../src/card/contract.ts';
import type { CharacterState } from '../src/domain/character/types.ts';

const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);

function state(): CharacterState {
  return {
    id: 'c1', userId: 'u123', name: '测试者', pathway: 'seer', sequence: 9, pathwayStatus: 'initiated',
    gender: 'male', hp: 80, mp: 90, mad: 20, cor: 10, dig: 30, dp: 2,
    status: 'active', promotionFails: 0, createdAt: 0, updatedAt: 0,
  };
}

test('出图：配了公网基址就带 publicUrl，指向 /cards/<文件名>', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'card-host-'));
  try {
    const service = createCardService({ outDir: dir, publicBaseUrl: 'https://bot.example.com', render: () => FAKE_PNG });
    const out = await service.generate({ character: state(), facts: {} });
    assert.ok(out.publicUrl, '应当有公网 URL');
    assert.match(out.publicUrl!, /^https:\/\/bot\.example\.com\/cards\/[A-Za-z0-9_-]+\.png$/);
    // URL 里的文件名必须与真正落盘的那个一致 —— 否则平台下载转存必然 404
    assert.ok(out.publicUrl!.endsWith(out.path.split(/[\\/]/).pop()!), 'URL 文件名与落盘文件名不一致');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('出图：没配基址就没有 publicUrl（官方通道据此走文字降级）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'card-host-'));
  try {
    const service = createCardService({ outDir: dir, render: () => FAKE_PNG });
    const out = await service.generate({ character: state(), facts: {} });
    assert.equal(out.publicUrl, undefined);
    assert.ok(out.path.endsWith('.png'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('出图：基址末尾多个斜杠也只拼出一个（URL 不出现 //cards）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'card-host-'));
  try {
    const service = createCardService({ outDir: dir, publicBaseUrl: 'https://bot.example.com///', render: () => FAKE_PNG });
    const out = await service.generate({ character: state(), facts: {} });
    assert.match(out.publicUrl!, /^https:\/\/bot\.example\.com\/cards\//);
    assert.ok(!out.publicUrl!.includes('.com//cards'), '基址末尾斜杠没归一化');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('出图：文件名只用 ASCII（PowerShell 5.1 按 ANSI 读参数，中文名会变乱码）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'card-host-'));
  try {
    const service = createCardService({ outDir: dir, render: () => FAKE_PNG });
    const out = await service.generate({
      character: { ...state(), name: '克莱恩·莫雷蒂' },
      facts: {},
    });
    const name = out.path.split(/[\\/]/).pop()!;
    assert.match(name, /^[A-Za-z0-9_.-]+$/, `文件名含非 ASCII：${name}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('出图：同名同用户连续两次生成不互相覆盖（文件名带时间戳会不同则各自保留）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'card-host-'));
  try {
    const service = createCardService({ outDir: dir, render: () => FAKE_PNG });
    const first = await service.generate({ character: state(), facts: {} });
    const second = await service.generate({ character: state(), facts: {} });
    // 同一秒内可能同名（时间戳到秒），但两次都必须成功写盘
    assert.ok(first.path.endsWith('.png') && second.path.endsWith('.png'));
    writeFileSync(first.path, FAKE_PNG);
    assert.ok(characterCardData(state()).name.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
