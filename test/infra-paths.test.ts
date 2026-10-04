/**
 * 运行期数据的根目录（src/infra/paths.ts）。
 *
 * 判据只有两条，但它们守着一次真机事故：
 * **Koishi 部署下，内核绝不能把缓存写进插件安装目录**。
 *
 * 从前这些目录写死 `join(process.cwd(), 'data', …)`，而内核的 cwd 就是
 * 插件包里的 `core/` —— 更新时目录里还有文件在写、内核的 cwd 也在里头，
 * 现场表现就是「**插件不停止，Koishi 的更新就装不上**」。
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { dataPath, dataRoot } from '../src/infra/paths.ts';

/** 临时换一个 LOM_DATA_DIR，跑完还原（别的用例不该被影响） */
function withEnv<T>(value: string | undefined, run: () => T): T {
  const saved = process.env['LOM_DATA_DIR'];
  if (value === undefined) delete process.env['LOM_DATA_DIR'];
  else process.env['LOM_DATA_DIR'] = value;
  try {
    return run();
  } finally {
    if (saved === undefined) delete process.env['LOM_DATA_DIR'];
    else process.env['LOM_DATA_DIR'] = saved;
  }
}

test('没配 LOM_DATA_DIR 时，还是老的 <cwd>/data（仓库开发与 BEE 部署行为不变）', () => {
  withEnv(undefined, () => {
    assert.equal(dataRoot(), join(process.cwd(), 'data'));
    assert.equal(dataPath('cards'), join(process.cwd(), 'data', 'cards'));
    assert.equal(dataPath('cards', 'menu'), join(process.cwd(), 'data', 'cards', 'menu'));
  });
});

test('配了 LOM_DATA_DIR 就整个搬过去 —— Koishi 靠这条把数据从 node_modules 里挪出来', () => {
  const target = join('/', 'srv', 'lom-data');
  withEnv(target, () => {
    assert.equal(dataRoot(), target);
    assert.equal(dataPath('avatars'), join(target, 'avatars'));
    assert.equal(dataPath('cards', 'header'), join(target, 'cards', 'header'));
  });
});

test('空白串当成没配（配置文件里留一行空的，不该把数据甩到盘符根上）', () => {
  withEnv('   ', () => {
    assert.equal(dataRoot(), join(process.cwd(), 'data'));
  });
});
