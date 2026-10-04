package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// recordingTransport 冒充 C 壳：把 worker 发来的 API 命令记下来，返回空结果。
//
// 有了它，编排逻辑（什么时候发、发给谁、正文长什么样）就能在没有 BEE 的机器上验。
type recordingTransport struct {
	mu       sync.Mutex
	commands []string
}

func (t *recordingTransport) Call(command []byte) ([]byte, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.commands = append(t.commands, string(command))
	return []byte(""), nil
}

func (t *recordingTransport) snapshot() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]string(nil), t.commands...)
}

// newBridgeHarness 起一套「假服务端 + 假 C 壳 + 真编排」的台子。
func newBridgeHarness(t *testing.T, reply string) (*bridgeRuntime, *recordingTransport) {
	t.Helper()
	var mu sync.Mutex
	served := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/inbound":
			_, _ = w.Write([]byte("{\"ok\":true,\"accepted\":true}"))
		case "/api/v1/outbound":
			mu.Lock()
			first := !served
			served = true
			mu.Unlock()
			if first {
				// 第一轮先给空的：模拟「回执还没产生」，让编排真的走一遍等待
				_, _ = w.Write([]byte("{\"ok\":true,\"items\":[],\"cursor\":0}"))
				return
			}
			_, _ = w.Write([]byte("{\"ok\":true,\"items\":[{\"seq\":1,\"kind\":\"text\",\"scene\":\"group\"," +
				"\"targetId\":\"123456\",\"text\":\"" + reply + "\",\"createdAt\":1}],\"cursor\":1}"))
		case "/api/v1/capabilities":
			_, _ = w.Write([]byte("{\"ok\":true}"))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)

	transport := &recordingTransport{}
	setCurrentAPITransport(transport)
	t.Cleanup(func() { setCurrentAPITransport(nil) })

	rt := newBridgeRuntime()
	rt.prepare(t.TempDir())
	rt.mu.Lock()
	rt.cfg = Config{API: server.URL, Platform: "bee", LongPollSec: 25, WaitMs: 3000, FetchNickname: false}
	rt.client = newBridgeClient(rt.cfg)
	rt.mu.Unlock()
	return rt, transport
}

// robotJSON 里的 robot_id 是自身消息过滤的依据。
const testRobotJSON = `{"api":"12345","plugin_id":"p1","msg_id":"m-1","event_id":"e-1","robot_id":"999"}`

// 这条用例守的是整个插件最微妙的一处：**发送必须发生在回调窗口里**。
// 编排对不对看不出错，只会表现为「消息发不出去」或「发给了错的群」。
func TestHandleInboundSendsReplyWithinCallback(t *testing.T) {
	rt, transport := newBridgeHarness(t, "你看到了廷根市的雨。")
	rt.start(testRobotJSON)
	defer rt.stop()

	rt.handleInbound(testRobotJSON, sceneGroup, "123456", "123456", "20001", ".帮助", "m-1")

	commands := transport.snapshot()
	if len(commands) == 0 {
		t.Fatal("回调里没有发出任何 Bee API 命令 —— 回执被留在了队列里，玩家收不到")
	}
	// 34 = 发送群消息；命令用 %@#bee#@% 分隔，格式见 bee_sdk.go 的 RobotContext.command
	var found bool
	for _, command := range commands {
		if !strings.HasPrefix(command, "34"+BeeSeparator) {
			continue
		}
		parts := strings.Split(command, BeeSeparator)
		if len(parts) < 4 {
			t.Fatalf("命令字段太少: %q", command)
		}
		if parts[2] != "123456" {
			t.Fatalf("发给了 %q，应该发给群 123456", parts[2])
		}
		if parts[3] != "你看到了廷根市的雨。" {
			t.Fatalf("正文 = %q", parts[3])
		}
		// 同一会话的回执要走**被动回复**（借用当前这条消息的 msg_id），
		// 它不受主动消息的频率与次数限制 —— 这条丢了的话玩家的回复会被平台限流
		if len(parts) < 8 || parts[6] != "m-1" {
			t.Fatalf("应保留当前 msg_id 走被动回复，实际命令: %q", command)
		}
		found = true
	}
	if !found {
		t.Fatalf("没有发出群消息命令，实际命令: %#v", commands)
	}
}

func TestInboundIsNotSentForRobotOwnMessages(t *testing.T) {
	rt, _ := newBridgeHarness(t, "x")
	rt.start(testRobotJSON)
	defer rt.stop()

	// userID 取 robotJSON 里的 robot_id（999）= 框架把机器人自己发的消息也上报了。
	// 不过滤的话就是死循环：回执 -> 回调 -> 再送进判定层 -> 又产生回执。
	before := rt.state.snapshot().inboundSent
	rt.handleInbound(testRobotJSON, sceneGroup, "123456", "123456", "999", "我发出去的回执", "m-2")
	time.Sleep(200 * time.Millisecond)
	after := rt.state.snapshot().inboundSent
	if after != before {
		t.Fatalf("机器人自己的消息被送进了判定层（inbound %d -> %d）", before, after)
	}
}

func TestInboundIsNotSentForEmptyText(t *testing.T) {
	rt, _ := newBridgeHarness(t, "x")
	rt.start(testRobotJSON)
	defer rt.stop()

	before := rt.state.snapshot().inboundSent
	rt.handleInbound(testRobotJSON, sceneGroup, "123456", "123456", "20001", "   ", "m-3")
	time.Sleep(200 * time.Millisecond)
	if got := rt.state.snapshot().inboundSent; got != before {
		t.Fatalf("空消息（图片/表情）不该送进判定层，inbound %d -> %d", before, got)
	}
}

// 玩家消息还是要真的送进去的 —— 上面两条是「不该送」，这条是「该送」。
func TestPlayerMessageReachesServer(t *testing.T) {
	rt, _ := newBridgeHarness(t, "x")
	rt.start(testRobotJSON)
	defer rt.stop()

	rt.handleInbound(testRobotJSON, sceneGroup, "123456", "123456", "20001", ".状态", "m-4")
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if rt.state.snapshot().inboundSent > 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("玩家消息没有送进服务端")
}

// 世界播报（targetId 不是当前会话）必须走主动消息而不是被动回复：
// 借用另一个群的 msg_id 去发，框架那边会直接失败。
func TestForeignTargetUsesActiveMessage(t *testing.T) {
	rt, transport := newBridgeHarness(t, "世界播报")
	rt.start(testRobotJSON)
	defer rt.stop()

	// 直接往待发队列里塞一条「发给别的群」的回执，再走一次回调窗口
	rt.pending.push(outboundItem{Seq: 7, Kind: "text", Scene: sceneGroup, TargetID: "888888", Text: "世界播报"})
	rt.handleInbound(testRobotJSON, sceneGroup, "123456", "123456", "20001", "   ", "m-5")

	var found bool
	for _, command := range transport.snapshot() {
		if !strings.HasPrefix(command, "34"+BeeSeparator) {
			continue
		}
		parts := strings.Split(command, BeeSeparator)
		if len(parts) < 8 || parts[2] != "888888" {
			continue
		}
		// 主动消息的 msg_id / event_id 必须是空的（API 参考：主动消息清空这两个字段）。
		// 拿另一个群的 msg_id 去发给这个群，框架那边会直接失败。
		if parts[6] != "" || parts[7] != "" {
			t.Fatalf("主动消息应清空 msg_id/event_id，实际 msg_id=%q event_id=%q", parts[6], parts[7])
		}
		found = true
	}
	if !found {
		t.Fatalf("没有向别的群发出主动消息，实际命令: %#v", transport.snapshot())
	}
}

func TestTelemetryCountsDeliveries(t *testing.T) {
	rt, _ := newBridgeHarness(t, "回执")
	rt.start(testRobotJSON)
	defer rt.stop()

	rt.handleInbound(testRobotJSON, sceneGroup, "123456", "123456", "20001", ".帮助", "m-6")
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if rt.state.snapshot().delivered > 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("投递计数没有增长，设置窗口会一直显示 0：%+v", rt.state.snapshot())
}

// 合并要守住的三件事：同一回复并成一条、不同目标不串台、重复回执只算一次。
//
// 这些值都不是拍脑袋定的 —— 前两条来自用户的原始要求「要合并成一条消息」，
// 第三条是真被一个 bug 咬过：服务端重复投递同一批时，正文变成了同一句话 ×150。
func TestMergeOutbound(t *testing.T) {
	option := func(id string) outboundOption {
		return outboundOption{ID: id, Label: "选项" + id}
	}
	items := []outboundItem{
		{Seq: 1, Kind: "text", Scene: sceneGroup, TargetID: "100", Text: "正文"},
		{Seq: 2, Kind: "image", Scene: sceneGroup, TargetID: "100", Image: &outboundImage{MediaType: "image/png"}},
		{Seq: 3, Kind: "interactive", Scene: sceneGroup, TargetID: "100", Text: "菜单", Options: []outboundOption{option("1"), option("2")}},
		{Seq: 2, Kind: "image", Scene: sceneGroup, TargetID: "100", Image: &outboundImage{MediaType: "image/png"}},
		{Seq: 9, Kind: "text", Scene: sceneGroup, TargetID: "200", Text: "别的群"},
	}
	merged := mergeOutbound(items)
	if len(merged) != 2 {
		t.Fatalf("应该并成 2 条（群 100 一条、群 200 一条），实际 %d 条", len(merged))
	}
	first := merged[0]
	if first.Scene != sceneGroup || first.TargetID != "100" {
		t.Fatalf("第一条应属于群 100，实际 %s/%s", first.Scene, first.TargetID)
	}
	if first.Text != "正文\n菜单" {
		t.Fatalf("正文应拼成「正文\\n菜单」，实际 %q", first.Text)
	}
	if first.Image == nil {
		t.Fatal("图片应保留 —— 丢了的话角色卡就没了")
	}
	if len(first.Options) != 2 {
		t.Fatalf("选项应合并成 2 个，实际 %d 个", len(first.Options))
	}
	if merged[1].TargetID != "200" || merged[1].Text != "别的群" {
		t.Fatalf("不同目标不该串台，实际 %+v", merged[1])
	}
	if got := mergeOutbound([]outboundItem{{Seq: 1, Text: "a"}}); len(got) != 1 || got[0].Text != "a" {
		t.Fatal("单条不该被动过")
	}
}
