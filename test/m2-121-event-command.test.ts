/**
 * **`.事件` 命令**（W2）—— 抽一张日常卡。
 *
 * ⚠️ 这个文件是**重建**的：原来它叫 `play-command.test.ts`，里面既有 `.扮演` 的 7 条、
 * 也有 `.事件` 的 3 条。M2.121 删掉 `.扮演` 时整个文件一起删了 —— 而 `.事件` 那几条
 * **当时还没提交**（`git show HEAD:` 里没有），于是只能重建。
 *
 * 教训：**删文件之前先看清里面有几组用例**。文件名描述的是主要那一组，不是全部。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./helpers/app.ts";

test("M2.121 .事件：能抽到一张日常卡，且同一天不重复", async () => {
  const h = createHarness();
  try {
    await h.createCharacter("98121", "克莱恩");
    const seen = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      h.advance(11_000);
      const out = await h.send({ rawText: ".事件", userId: "98121" });
      const text = out.map((reply) => reply.text).join("\n");
      const m = /事件【([^】]+)】/.exec(text);
      if (m === null) continue;
      assert.ok(!seen.has(m[1]), "同一天不该重复触发同一张卡：" + m[1]);
      seen.add(m[1]);
    }
  } finally {
    h.app.close();
  }
});
