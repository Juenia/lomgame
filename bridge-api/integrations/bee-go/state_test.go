package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCursorPersistsAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	first := newRuntimeState()
	first.bindDataDir(dir)
	if first.cursorValue() != 0 {
		t.Fatalf("首次运行游标应为 0，得到 %d", first.cursorValue())
	}
	first.setCursor(42)
	first.setCursor(42) // 同一个值重复设置：不该写两次文件，也不该出错

	// 模拟 worker 进程被销毁重建
	second := newRuntimeState()
	second.bindDataDir(dir)
	if second.cursorValue() != 42 {
		t.Fatalf("重启后游标应为 42，得到 %d", second.cursorValue())
	}
}

func TestBrokenCursorFallsBackToZero(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, cursorFileName), []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	state := newRuntimeState()
	state.bindDataDir(dir)
	// 从 0 开始 = 宁可重发也不漏发；同时要留下一条能看见的错误
	if state.cursorValue() != 0 {
		t.Fatalf("损坏的游标应回落到 0，得到 %d", state.cursorValue())
	}
	if state.snapshot().lastError == "" {
		t.Fatal("游标损坏必须记一条错误，否则没人知道历史回执会被重发")
	}
}

func TestCursorFileIsReadableJSON(t *testing.T) {
	dir := t.TempDir()
	state := newRuntimeState()
	state.bindDataDir(dir)
	state.setCursor(7)
	data, err := os.ReadFile(filepath.Join(dir, cursorFileName))
	if err != nil {
		t.Fatal(err)
	}
	// 断言解析结果而不是字节：游标文件是给人看、给机器读的，
	// 卡在空格上只会让这条用例在换个编码器时白白变红
	var parsed cursorFile
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("游标文件应是合法 JSON: %v (%s)", err, data)
	}
	if parsed.Cursor != 7 {
		t.Fatalf("游标 = %d, want 7", parsed.Cursor)
	}
}

func TestGapIsRecorded(t *testing.T) {
	state := newRuntimeState()
	earliest := int64(40)
	state.noteGap(&earliest)
	snap := state.snapshot()
	if snap.gaps != 1 {
		t.Fatalf("丢档次数 = %d, want 1", snap.gaps)
	}
	if !strings.Contains(snap.lastError, "40") {
		t.Fatalf("错误里应带上队列里最早的 seq，得到 %q", snap.lastError)
	}
}

func TestStatusTextShowsKeyFacts(t *testing.T) {
	dir := t.TempDir()
	state := newRuntimeState()
	state.bindDataDir(dir)
	state.begin(time.Now())
	state.setCursor(128)
	state.noteInbound(true)
	state.noteDelivered(true)

	cfg := Config{API: "http://127.0.0.1:3200", Platform: "bee", Token: "secret-value"}
	text := state.statusText(cfg)
	for _, want := range []string{"http://127.0.0.1:3200", "bee", "128", "已设置", "最近错误：无"} {
		if !strings.Contains(text, want) {
			t.Fatalf("状态文本里缺少 %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "secret-value") {
		t.Fatalf("状态文本不该回显口令:\n%s", text)
	}
	// 窗口正文区约 230px（14px 字体约 12 行），行数超了就会被裁掉 —— 那是真的看不见
	if lines := strings.Count(text, "\n") + 1; lines > 8 {
		t.Fatalf("状态文本 %d 行，设置窗口放不下:\n%s", lines, text)
	}
}

// 「还没检索过」和「正在检索」混成一句话的时候，用户会一直等一个不会开始的动作：
// 插件没启用时后台根本没跑过，那句话永远不会变。
func TestStatusTextDistinguishesNotScannedFromScanning(t *testing.T) {
	state := newRuntimeState()
	cfg := Config{Platform: "bee"}

	text := state.statusText(cfg)
	if !strings.Contains(text, "尚未检索") {
		t.Fatalf("从没检索过时应说「尚未检索」，得到：\n%s", text)
	}

	state.setDiscovery("正在自动检索本机的 bridge-api（端口 3100-3300）…")
	text = state.statusText(cfg)
	if strings.Contains(text, "尚未检索") {
		t.Fatalf("检索已经开始了，不该还说「尚未检索」：\n%s", text)
	}
	if !strings.Contains(text, "自动检索") {
		t.Fatalf("检索中应显示「自动检索」，得到：\n%s", text)
	}

	// 找到之后：地址那行直接给地址，检索说明另起一行
	state.setDiscovery("已自动找到 http://127.0.0.1:3200（端口 3200）")
	cfg.API = "http://127.0.0.1:3200"
	text = state.statusText(cfg)
	if !strings.Contains(text, "服务端：http://127.0.0.1:3200") {
		t.Fatalf("找到地址后应直接显示它：\n%s", text)
	}
	if !strings.Contains(text, "已自动找到") {
		t.Fatalf("应保留「是自动找到的」这个信息：\n%s", text)
	}
}

func TestProbeOnceNeedsPreparedState(t *testing.T) {
	// 还没 prepare（没读到配置、没有数据目录）时不该动 —— 那时候连日志都没地方写
	rt := newBridgeRuntime()
	rt.probeOnce()
	rt.mu.Lock()
	probing := rt.probing
	rt.mu.Unlock()
	if probing {
		t.Fatal("未 prepare 时 probeOnce 不该启动任何探测")
	}
}

func TestHealthLevel(t *testing.T) {
	state := newRuntimeState()
	if got := state.healthLevel(); got != "warn" {
		t.Fatalf("还没取到过回执时应为 warn，得到 %q", got)
	}
	state.markPoll()
	if got := state.healthLevel(); got != "ok" {
		t.Fatalf("取到过回执后应为 ok，得到 %q", got)
	}
	state.setError("出事了", nil)
	if got := state.healthLevel(); got != "error" {
		t.Fatalf("有近期错误时应为 error，得到 %q", got)
	}
}
