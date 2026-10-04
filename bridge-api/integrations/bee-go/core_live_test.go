//go:build live

package main

// 端到端验证「打包进插件的内核真的跑得起来」。
//
// 它模拟 C 壳 → worker 的那条路，只把第一步换成从指定路径拷贝：
//
//   C 壳释放 core.zip  →  worker 解压  →  启动 node  →  等 /api/v1 就绪  →  对话
//
// 用法：
//
//   go run ./other/packcore ..\..\.. %TEMP%\lom-core\core.zip other\seed\bridge.db
//   set LOM_CORE_ZIP=%TEMP%\lom-core\core.zip
//   go test -tags live -run TestLiveCore -v .
//
// 它守的是这一版最要紧的那个假设：**内核不依赖仓库目录，解开就能跑**。
// 假设错了的话，玩家装完 DLL 会看到「内核起来了但一直不就绪」，
// 而那时候他手上没有任何线索。

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func copyFileTo(src, dst string) error {
	source, err := os.Open(src)
	if err != nil {
		return err
	}
	defer source.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	target, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(target, source); err != nil {
		target.Close()
		return err
	}
	return target.Close()
}

func TestLiveCoreRunsFromBundle(t *testing.T) {
	bundle := os.Getenv("LOM_CORE_ZIP")
	if bundle == "" {
		t.Skip("没有设置 LOM_CORE_ZIP —— 见这个文件开头的用法")
	}

	dataDir := t.TempDir()
	paths := corePathsFor(dataDir)
	// 模拟 C 壳那一步：把资源写到 plugin_data/<插件名>/core.zip
	if err := copyFileTo(bundle, paths.zip); err != nil {
		t.Fatalf("放置内核包失败: %v", err)
	}

	rt := newBridgeRuntime()
	rt.prepare(dataDir)
	t.Cleanup(rt.stopCore)

	// 1. 解压
	start := time.Now()
	if err := rt.ensureCoreExtracted(paths); err != nil {
		t.Fatalf("解压内核失败: %v", err)
	}
	t.Logf("解压用了 %s", time.Since(start).Round(time.Millisecond))

	// 解压出来的东西必须齐 —— 少一个，内核起来时会报一句很难懂的话
	for _, rel := range []string{
		"package.json",
		"src/app.ts",
		"src/data",
		"bridge-api/src/main.ts",
		"node_modules/zod/package.json",
		"node_modules/yaml/package.json",
		"data/bridge.db",
	} {
		if _, err := os.Stat(filepath.Join(paths.root, filepath.FromSlash(rel))); err != nil {
			t.Fatalf("解压后缺少 %s: %v", rel, err)
		}
	}

	// 重复解压不该重来一遍（版本戳生效）
	again := time.Now()
	if err := rt.ensureCoreExtracted(paths); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(again); elapsed > time.Second {
		t.Fatalf("第二次解压花了 %s —— 版本戳没起作用，每次启用都要重写上千个文件", elapsed)
	}

	// 2. 启动内核并等它就绪
	ctx, cancel := context.WithTimeout(context.Background(), coreReadyTimeout)
	defer cancel()
	cfg := rt.configSnapshot()
	cfg.CorePort = 3311 // 避开真机上可能在跑的 3200/3100
	port, err := rt.startCore(ctx, paths, cfg)
	if err != nil {
		t.Fatalf("启动内核失败: %v", err)
	}
	t.Logf("内核进程已启动，端口 %d", port)

	if err := waitCoreReady(ctx, port, coreReadyTimeout); err != nil {
		t.Fatalf("内核没就绪: %v\n内核日志：\n%s", err, readCoreLogTail(dataDir, 20))
	}
	t.Logf("内核已就绪（从解压算起 %s）", time.Since(start).Round(time.Second))

	// 3. 真的能对话吗 —— 这才是「跑起来了」的定义
	client := newBridgeClient(Config{API: baseURLForPort(port), Platform: "bee-coretest"})
	if err := client.declareCapabilities(ctx, false, false, false); err != nil {
		t.Fatalf("向随身内核声明能力失败: %v", err)
	}
	stamp := time.Now().UnixNano()
	if err := client.inbound(ctx, inboundPayload{
		Scene:     sceneGroup,
		SceneID:   "10086",
		UserID:    fmt.Sprintf("98%09d", stamp%1000000000),
		Nickname:  "内核自检",
		Text:      ".帮助",
		MessageID: fmt.Sprintf("core-live-%d", stamp),
	}); err != nil {
		t.Fatalf("随身内核拒绝了入站消息: %v", err)
	}

	cursor := int64(0)
	deadline := time.Now().Add(40 * time.Second)
	for time.Now().Before(deadline) {
		response, err := client.outbound(ctx, cursor, 5, 20)
		if err != nil {
			t.Fatalf("取回执失败: %v", err)
		}
		cursor = response.Cursor
		for _, item := range response.Items {
			if item.Platform != "bee-coretest" {
				continue
			}
			text := renderOutboundText(item)
			if text == "" {
				t.Fatal("回执正文是空的")
			}
			t.Logf("随身内核回了 %d 个字符：%s…", len([]rune(text)), string([]rune(text)[:min(40, len([]rune(text)))]))
			return
		}
	}
	t.Fatalf("等不到随身内核的回执（游标 %d）", cursor)
}
