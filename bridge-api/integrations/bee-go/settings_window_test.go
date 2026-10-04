//go:build windows && windowtest

package main

// 设置窗口的真机行为测试。默认不跑（要真实桌面会话 + 会短暂弹出窗口）：
//
//   go test -tags windowtest -run TestSettingsWindow -v .
//
// 它守的是两件在真机上才会暴露、而编译期完全看不出来的事：
//   1. 最小化之后还能不能恢复（用户报的「最小化再点开窗口就没了」）；
//   2. 关掉之后再打开还能不能建出窗口（RegisterClassExW 因类名残留而失败）。

import (
	"testing"
	"time"
	"unsafe"
)

const swMinimize = 6

func settingsHandle() uintptr {
	settingsNative.Lock()
	defer settingsNative.Unlock()
	return settingsNative.hwnd
}

func waitUntil(t *testing.T, what string, condition func() bool, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("等不到：%s（超时 %s）", what, timeout)
}

func windowVisible(hwnd uintptr) bool {
	if hwnd == 0 {
		return false
	}
	visible, _, _ := procIsWindowVisible.Call(hwnd)
	return visible != 0
}

func windowIconic(hwnd uintptr) bool {
	if hwnd == 0 {
		return false
	}
	iconic, _, _ := procIsIconic.Call(hwnd)
	return iconic != 0
}

func TestSettingsWindowOpenAndClose(t *testing.T) {
	showSettingsWindow()
	waitUntil(t, "窗口被创建", func() bool { return settingsHandle() != 0 }, 5*time.Second)
	hwnd := settingsHandle()
	if !windowVisible(hwnd) {
		t.Fatal("窗口创建后应该可见")
	}
	closeSettingsWindow()
	waitUntil(t, "窗口句柄被清空（线程退出）", func() bool { return settingsHandle() == 0 }, 5*time.Second)

	// 再开一次：这一步会重新 RegisterClassExW。
	// 如果上一次的类没注销干净，这一步会拿不到 atom 而静默返回 —— 表现就是「窗口再也打不开」。
	showSettingsWindow()
	waitUntil(t, "窗口被重新创建", func() bool { return settingsHandle() != 0 }, 5*time.Second)
	if !windowVisible(settingsHandle()) {
		t.Fatal("第二次打开的窗口应该可见")
	}
	closeSettingsWindow()
}

// 每次开窗都换一个窗口类名。
//
// 原因是 RegisterClassExW 对**同名类**第二次调用会直接失败（返回 0），而那时窗口
// 根本建不出来、也没有提示 —— 表现是「设置窗口再也打不开」。
// 只要有一次 UnregisterClassW 没成功，那个类名就被永久占住。
func TestSettingsWindowUsesFreshClassName(t *testing.T) {
	settingsNative.Lock()
	before := settingsNative.classSeq
	settingsNative.Unlock()

	showSettingsWindow()
	waitUntil(t, "窗口被创建", func() bool { return settingsHandle() != 0 }, 5*time.Second)
	closeSettingsWindow()

	settingsNative.Lock()
	after := settingsNative.classSeq
	settingsNative.Unlock()
	if after <= before {
		t.Fatalf("窗口类序号没有推进（%d -> %d）—— 复用类名迟早会撞上「类已存在」", before, after)
	}

	// 连续开关三次，任何一次建不出窗口都说明类名或注销有问题
	for i := 0; i < 3; i++ {
		showSettingsWindow()
		waitUntil(t, "第 N 次重新打开窗口", func() bool { return settingsHandle() != 0 }, 5*time.Second)
		if !windowVisible(settingsHandle()) {
			t.Fatalf("第 %d 次打开的窗口不可见", i+1)
		}
		closeSettingsWindow()
	}
}

func clientSize(hwnd uintptr) (int, int) {
	var area rect
	procGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&area)))
	return int(area.Right - area.Left), int(area.Bottom - area.Top)
}

// 最小化再恢复之后，窗口**尺寸必须没变**。
//
// 这条断言是被用户的一张截图逼出来的：他最小化再打开，窗口缩成了一条 230x37。
// 之前这里只检查"可见"和"不再最小化"，两个都通过 —— 而实际现象是窗口还在、
// 只是小得只剩个标题栏。
//
// 根因在 WM_GETMINMAXINFO：那里拿 GetWindowPlacement 的 NormalPosition 当尺寸，
// 而窗口最小化时它返回的是**最小化之后**的小尺寸。
func TestSettingsWindowRestoreFromMinimize(t *testing.T) {
	showSettingsWindow()
	waitUntil(t, "窗口被创建", func() bool { return settingsHandle() != 0 }, 5*time.Second)
	hwnd := settingsHandle()
	waitUntil(t, "窗口画出第一帧", func() bool {
		w, h := clientSize(hwnd)
		return w > 0 && h > 0
	}, 3*time.Second)
	beforeWidth, beforeHeight := clientSize(hwnd)
	t.Logf("最小化前客户区 %dx%d", beforeWidth, beforeHeight)

	// 模拟用户点标题栏上的最小化按钮
	procShowWindow.Call(hwnd, swMinimize)
	waitUntil(t, "窗口进入最小化", func() bool { return windowIconic(hwnd) }, 3*time.Second)

	// 用户再点一次「设置」
	showSettingsWindow()
	waitUntil(t, "窗口从最小化恢复", func() bool { return !windowIconic(hwnd) }, 3*time.Second)

	if !windowVisible(hwnd) {
		t.Fatal("最小化后恢复：窗口不可见 —— 这就是用户报的那个问题")
	}
	afterWidth, afterHeight := clientSize(hwnd)
	t.Logf("恢复后客户区 %dx%d", afterWidth, afterHeight)
	if afterWidth != beforeWidth || afterHeight != beforeHeight {
		t.Fatalf("恢复后尺寸变了：%dx%d -> %dx%d。窗口还在，但缩成了一条 —— "+
			"检查 WM_GETMINMAXINFO 里是不是拿了 GetWindowPlacement 的结果当尺寸",
			beforeWidth, beforeHeight, afterWidth, afterHeight)
	}
	closeSettingsWindow()
}
