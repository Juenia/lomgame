//go:build live

package main

// 验证「本机没有 Node 时，插件能自己装一个」。
//
// 它会把 PATH 清空，逼 ensureNode 走下载那条路 —— 也就是目标机器上
// 什么都没装的场景。会真的下载约 34 MB：
//
//   set LOM_TEST_NODE_INSTALL=1
//   go test -tags live -run TestLiveNodeAutoInstall -v .
//
// 这条用例守的是「安装即用」的最后一步。它失败通常只有两种原因，
// 而两种都不该被用户遇到：下载地址够不着，或者解压/校验写错了。

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLiveNodeAutoInstall(t *testing.T) {
	if os.Getenv("LOM_TEST_NODE_INSTALL") == "" {
		t.Skip("没有设置 LOM_TEST_NODE_INSTALL —— 见这个文件开头的用法")
	}
	// 清空 PATH：findNode 就找不到系统里那个 Node，只能自己去下
	t.Setenv("PATH", "")

	dataDir := t.TempDir()
	paths := corePathsFor(dataDir)
	rt := newBridgeRuntime()
	rt.prepare(dataDir)
	cfg := rt.configSnapshot()
	if !cfg.AutoInstallNode {
		t.Fatal("默认配置里自动安装应当是开着的")
	}
	t.Logf("下载地址: %s", cfg.NodeDownloadURL)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	start := time.Now()
	nodePath, err := rt.ensureNode(ctx, paths, cfg)
	if err != nil {
		t.Fatalf("自动安装 Node 失败: %v", err)
	}
	t.Logf("安装完成，用时 %s，位置 %s", time.Since(start).Round(time.Second), nodePath)

	// 装出来的东西必须真的能跑 —— 只检查文件存在是不够的，
	// 一个被截断的 node.exe 也是"存在"的
	version := nodeVersionOf(nodePath)
	if version == "" {
		t.Fatalf("装出来的 Node 跑不起来：%s", nodePath)
	}
	t.Logf("版本: %s", version)
	if major, minor, ok := parseNodeVersion(version); ok {
		if major < 22 || (major == 22 && minor < 18) {
			t.Fatalf("自动装的 Node 版本太低（%s），内核跑不动", version)
		}
	}

	// 状态栏要能说出这件事 —— 用户打开设置窗口就该看到"我自己装了一个"
	status := rt.state.snapshot().nodeStatus
	if status == "" {
		t.Fatal("nodeStatus 是空的，设置窗口会显示「尚未检测」")
	}
	t.Logf("设置窗口显示: Node：%s", status)

	// 再跑一次不该重下：文件已经在插件目录里了
	second := time.Now()
	again, err := rt.ensureNode(ctx, paths, cfg)
	if err != nil {
		t.Fatalf("第二次 ensureNode 失败: %v", err)
	}
	if elapsed := time.Since(second); elapsed > 3*time.Second {
		t.Fatalf("第二次花了 %s —— 说明它又下载了一遍，没有复用已装好的", elapsed)
	}
	if again != nodePath {
		t.Fatalf("第二次给出的路径不一样: %s vs %s", again, nodePath)
	}
	if _, err := os.Stat(filepath.Join(paths.root, managedNodeDirName, bundledNodeName())); err != nil {
		t.Fatalf("Node 没有落在插件目录里: %v", err)
	}
}
