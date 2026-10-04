import { createHarness, DEFAULT_USER } from '../test/helpers/app.ts';
const h = createHarness();
await h.createCharacter(DEFAULT_USER, '克莱恩');
for (const cmd of ['.状态', '.世界', '.探索 老码头']) {
  const sent = await h.send({ rawText: cmd, scene: 'group' });
  console.log('\n############ ' + cmd + ' ############');
  for (const m of sent) {
    console.log('[' + m.scene + ']');
    console.log(JSON.stringify(m.text).slice(1, -1).replace(/\\n/g, '\n'));
    console.log('···长度 ' + String(m.text).length + ' 字，' + String(m.text).split('\n').length + ' 行');
  }
}
h.app.close();
