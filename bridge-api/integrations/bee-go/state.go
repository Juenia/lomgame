package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// runtimeState 汇总「现在是什么情况」。
//
// 它有两个用途，都是刚需：
//  1. 设置窗口只读显示（运营点一下就知道连没连上、卡在哪）；
//  2. 出站游标持久化 —— worker 进程会随插件禁用/启用被销毁重建，
//     游标不落盘的话每次重启都会从 0 开始，把队列里的历史回执**重发一遍**。
type runtimeState struct {
	mu      sync.Mutex
	dataDir string

	cursor int64
	// nodeStatus 是环境检测的结果：用的是哪个 Node、来自哪儿、什么版本。
	//
	// 它和 discovery 一样，属于「用户打开窗口第一眼要看的东西」——
	// 「机器人不回话」的原因里，Node 缺失和地址不对是并列的两大项。
	nodeStatus string
	// discovery 是「地址是怎么定下来的」：用配置里的、还是自动检索到的、还是没找到。
	// 它是给设置窗口看的 —— 「机器人不回话」的第一个问题永远是「它连的是哪个地址」。
	discovery string

	lastError   string
	lastErrorAt time.Time
	lastPollAt  time.Time
	startedAt   time.Time

	inboundSent   int64
	inboundFailed int64
	delivered     int64
	deliverFailed int64
	gaps          int64
}

type cursorFile struct {
	Cursor int64 "json:\"cursor\""
}

func newRuntimeState() *runtimeState {
	return &runtimeState{}
}

// bindDataDir 绑定数据目录，并把上次的游标读回来。
//
// 它在插件初始化时调用一次；dataDir 依赖 Bee 框架给的应用目录，
// 在那之前状态对象只是占位，不写任何文件。
func (s *runtimeState) bindDataDir(dir string) {
	s.mu.Lock()
	s.dataDir = dir
	s.mu.Unlock()
	s.loadCursor()
}

func cursorPath(dir string) string { return filepath.Join(dir, cursorFileName) }

// loadCursor 读回上次的游标。
//
// 读不出来就从 0 开始：**宁可重发也不要漏发**。代价是插件数据目录被清空后，
// 队列里还留着的那些回执会被重发一遍（队列默认最多 500 条）。
func (s *runtimeState) loadCursor() {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := os.ReadFile(cursorPath(s.dataDir))
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			s.setErrorLocked("读取游标失败，从 0 开始", err)
		}
		return
	}
	var parsed cursorFile
	if err := json.Unmarshal(data, &parsed); err != nil {
		s.setErrorLocked("游标文件损坏，从 0 开始", err)
		return
	}
	if parsed.Cursor < 0 {
		parsed.Cursor = 0
	}
	s.cursor = parsed.Cursor
}

// setCursor 推进游标并在变化时落盘。
//
// 只有真的变了才写：长轮询没数据时每次都会返回同一个 cursor，
// 每次都写等于每 25 秒写一次磁盘，没有意义。
func (s *runtimeState) setCursor(value int64) {
	s.mu.Lock()
	changed := value != s.cursor
	if changed {
		s.cursor = value
	}
	dir := s.dataDir
	s.mu.Unlock()
	if !changed {
		return
	}
	data, err := json.Marshal(cursorFile{Cursor: value})
	if err != nil {
		return
	}
	if err := writeFileAtomic(cursorPath(dir), append(data, '\n')); err != nil {
		s.setError("写入游标失败（重启后可能重发历史回执）", err)
	}
}

// resetCursor 把出站游标清零。
//
// ## 什么时候必须清零：**自己拉起内核之后**
//
// 出站队列在服务端是**内存里的**，内核一重启就从 seq=1 重新开始；
// 而游标是落盘的。两个一叠加就是死锁：
//
//	插件带着旧游标（比如 6）去轮询一个最大只有 4 的队列 →
//	服务端认为"你要的东西比我这儿最新的还新" → 返回空 →
//	插件以为没数据 → 永远等下去。
//
// 而且**服务端不会报 gap**：它只在「游标太旧、中间那段被裁掉」时报，
// 不管「游标比队尾还新」—— 所以这条死锁在两边都没有任何错误。
//
// 现象就是现场那一版：内核正常处理每条消息、回执确实进了队列、
// 插件侧一行错误都没有，而玩家一条都收不到。
func (s *runtimeState) resetCursor() {
	s.mu.Lock()
	s.cursor = 0
	dir := s.dataDir
	s.mu.Unlock()
	if dir == "" {
		return
	}
	_ = writeFileAtomic(cursorPath(dir), []byte("{\"cursor\": 0}\n"))
}

func (s *runtimeState) cursorValue() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cursor
}

func (s *runtimeState) begin(startedAt time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.startedAt = startedAt
}

// setNodeStatus 记下环境检测的结果（用的是哪个 Node）。
func (s *runtimeState) setNodeStatus(text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nodeStatus = text
}

// setDiscovery 记下「地址是怎么定下来的」。
//
// 它**不算错误**：自动检索中、检索成功都是正常状态，
// 记成 error 会让设置窗口的状态点无故变红 —— 一个动不动就变红的指示灯等于没有指示灯。
func (s *runtimeState) setDiscovery(text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.discovery = text
}

func (s *runtimeState) setError(what string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.setErrorLocked(what, err)
}

func (s *runtimeState) setErrorLocked(what string, err error) {
	if err == nil {
		s.lastError = what
	} else {
		s.lastError = what + ": " + err.Error()
	}
	s.lastErrorAt = time.Now()
}

func (s *runtimeState) clearError() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastError = ""
}

func (s *runtimeState) noteInbound(ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ok {
		s.inboundSent++
		return
	}
	s.inboundFailed++
}

func (s *runtimeState) noteDelivered(ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ok {
		s.delivered++
		return
	}
	s.deliverFailed++
}

func (s *runtimeState) markPoll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastPollAt = time.Now()
}

func (s *runtimeState) noteGap(earliest *int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gaps++
	if earliest != nil {
		s.lastError = fmt.Sprintf("回执队列中间被裁剪过（有消息永久丢失）；队列里最早还留着 seq=%d", *earliest)
	} else {
		s.lastError = "回执队列中间被裁剪过（有消息永久丢失）"
	}
	s.lastErrorAt = time.Now()
}

type stateSnapshot struct {
	cursor        int64
	nodeStatus    string
	discovery     string
	lastError     string
	lastErrorAt   time.Time
	lastPollAt    time.Time
	startedAt     time.Time
	inboundSent   int64
	inboundFailed int64
	delivered     int64
	deliverFailed int64
	gaps          int64
}

func (s *runtimeState) snapshot() stateSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return stateSnapshot{
		cursor:        s.cursor,
		nodeStatus:    s.nodeStatus,
		discovery:     s.discovery,
		lastError:     s.lastError,
		lastErrorAt:   s.lastErrorAt,
		lastPollAt:    s.lastPollAt,
		startedAt:     s.startedAt,
		inboundSent:   s.inboundSent,
		inboundFailed: s.inboundFailed,
		delivered:     s.delivered,
		deliverFailed: s.deliverFailed,
		gaps:          s.gaps,
	}
}

// healthLevel 给设置窗口决定状态圆点的颜色：ok / warn / error。
//
// 判据刻意选得「迟钝」一点：最近一次取回执成功过就算 ok。
// 一个动不动就变红的指示灯等于没有指示灯 —— 人会学会忽略它。
func (s *runtimeState) healthLevel() string {
	snap := s.snapshot()
	if snap.lastError != "" && time.Since(snap.lastErrorAt) < 2*time.Minute {
		return "error"
	}
	if snap.lastPollAt.IsZero() || time.Since(snap.lastPollAt) > 2*time.Minute {
		return "warn"
	}
	return "ok"
}

// statusLine 是设置窗口里那行大字。
func (s *runtimeState) statusLine() string {
	switch s.healthLevel() {
	case "ok":
		return "运行中 · 与 bridge-api 通信正常"
	case "warn":
		return "等待中 · 还没有取到过回执"
	default:
		return "异常 · 看下面的最近错误"
	}
}

// statusText 是设置窗口里的正文，也用于 /health 之外的自查。
func (s *runtimeState) statusText(cfg Config) string {
	snap := s.snapshot()
	// 行数是省着用的：窗口只有 640x420，正文区约 230px（14px 字体约 12 行），
	// 而「最近错误」那一行展开后可能占两三行。
	// 「还没检索过」与「正在检索」必须分得开。
	// 前者是插件还没启用 —— 检索根本不会开始，等下去也没有结果；
	// 后者才值得等。混成一句「自动检索中…」的时候，用户会一直等一个不会发生的动作。
	var server string
	switch {
	case cfg.API != "":
		server = cfg.API
	case snap.discovery == "":
		server = "尚未检索（启用插件后自动进行）"
	default:
		server = "自动检索"
	}
	lines := []string{
		"服务端：" + server,
		"Node：" + pickText(snap.nodeStatus, "尚未检测"),
		"口令：" + cfg.tokenState() + "　上游名：" + cfg.Platform,
		fmt.Sprintf("入站 %d · 失败 %d　投递 %d · 失败 %d · 丢档 %d",
			snap.inboundSent, snap.inboundFailed, snap.delivered, snap.deliverFailed, snap.gaps),
		fmt.Sprintf("游标 %d　运行 %s", snap.cursor, uptimeText(snap.startedAt)),
	}
	if snap.discovery != "" {
		lines = append(lines, snap.discovery)
	}
	if snap.lastError == "" {
		lines = append(lines, "最近错误：无")
	} else {
		lines = append(lines, "最近错误（"+humanAgo(snap.lastErrorAt)+"）："+snap.lastError)
	}
	lines = append(lines, "配置见同目录 bridge-config.json，改动在下次启用插件时生效。")
	return strings.Join(lines, "\n")
}

// uptimeText 处理「还没启用」的情况。
//
// 不处理的话 time.Since(零值) 是两千多年，设置窗口会显示一个荒谬的运行时长 ——
// 而那个数字看起来像是程序坏了。
func uptimeText(startedAt time.Time) string {
	if startedAt.IsZero() {
		return "未启用"
	}
	return humanDuration(time.Since(startedAt))
}

// pickText 给一个"没值时的替代文案"。
func pickText(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func humanDuration(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	d = d.Round(time.Second)
	hours := int(d.Hours())
	minutes := int(d.Minutes()) % 60
	seconds := int(d.Seconds()) % 60
	if hours > 0 {
		return fmt.Sprintf("%d 小时 %d 分", hours, minutes)
	}
	if minutes > 0 {
		return fmt.Sprintf("%d 分 %d 秒", minutes, seconds)
	}
	return fmt.Sprintf("%d 秒", seconds)
}

func humanAgo(t time.Time) string {
	if t.IsZero() {
		return "刚刚"
	}
	return humanDuration(time.Since(t)) + "前"
}
