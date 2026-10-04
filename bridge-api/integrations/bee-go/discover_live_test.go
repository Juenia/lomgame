//go:build live

package main

// 真机验收：把**真的**消息送进**真的** bridge-api，再把回执取回来。
//
// 为什么值得单独留一组用例：bridge-api 的入参是 zod 的 strictObject ——
// **字段名拼错一个当场 400**，一个都不许少。单元测试里的假服务端不会校验这个，
// 只有真服务端能证明「我们发出去的字段名它真的认」。
//
//   node bridge-api/src/main.ts
//   go test -tags live -run TestLiveInbound -v .
//
// ⚠️ 它会用一个新的 userId 在游戏库里建一个角色（.帮助 这条指令只查状态，代价很小），
// 所以只在测试库上跑。

import (
	"context"
	"fmt"
	"testing"
	"time"
)

func TestLiveInboundRoundTrip(t *testing.T) {
	const platform = "bee-livetest"
	client := newBridgeClient(Config{API: "http://127.0.0.1:3200", Platform: platform})
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// 1. 声明能力：images=false / buttons=false，判定层据此走文本降级。
	//    真实服务端会用自己的 schema 校验这份请求体。
	if err := client.declareCapabilities(ctx, false, false, false); err != nil {
		t.Fatalf("声明通道能力失败（字段名与 schema 对不上？）: %v", err)
	}

	// 2. 送一条玩家消息进去。字段名有一个错，这里就会拿到 400 与原话。
	stamp := time.Now().UnixNano()
	userID := fmt.Sprintf("99%09d", stamp%1000000000)
	messageID := fmt.Sprintf("bee-live-%d", stamp)
	if err := client.inbound(ctx, inboundPayload{
		Scene:     sceneGroup,
		SceneID:   "10001",
		UserID:    userID,
		Nickname:  "联调探针",
		Text:      ".帮助",
		MessageID: messageID,
	}); err != nil {
		t.Fatalf("入站被服务端拒绝: %v", err)
	}
	t.Logf("已送进判定层：user=%s text=.帮助", userID)

	// 3. 把回执取回来
	cursor := int64(0)
	deadline := time.Now().Add(40 * time.Second)
	for time.Now().Before(deadline) {
		response, err := client.outbound(ctx, cursor, 5, 20)
		if err != nil {
			t.Fatalf("取回执失败: %v", err)
		}
		cursor = response.Cursor
		for _, item := range response.Items {
			if item.Platform != platform {
				continue // 别人的回执（另一个上游，或主动推送）
			}
			t.Logf("收到回执 seq=%d kind=%s scene=%s target=%s", item.Seq, item.Kind, item.Scene, item.TargetID)
			t.Logf("正文渲染：\n%s", renderOutboundText(item))
			if item.TargetID != "10001" {
				t.Fatalf("回执目标 = %q，应该是群号 10001", item.TargetID)
			}
			if item.Kind != "text" {
				// 声明了 buttons=false / images=false，判定层就不该发 interactive / image
				t.Fatalf("声明了不摆按钮、不发图，回执 kind 却是 %q —— 能力协商没生效", item.Kind)
			}
			if renderOutboundText(item) == "" {
				t.Fatal("回执正文是空的")
			}
			return
		}
	}
	t.Fatalf("等不到回执（游标到 %d）", cursor)
}

// 下面两条守的是**端口识别**：同机两个版本一起跑时不能认错。
//
// 认错的表现是插件对着 OneBot 版本发请求，然后一直 404 —— 而设置窗口里
// 只显示「取回执失败」，没人会想到是端口认错了。
//
// 用法（两个版本都起起来，看它能不能分清）：
//
//   node src/main.ts                 :: 仓库根目录那个 OneBot 版本（默认 3100）
//   node bridge-api/src/main.ts      :: 本插件对接的 bridge-api（默认 3200）
//   go test -tags live -run TestLiveDiscovery -v .
//
// 第二条还守着一个更容易踩的坑：探测失败时**必须说得出「谁在那儿但不是它」**。

func TestLiveDiscoveryFindsRealBridgeAPI(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	result, err := discoverBridgeAPI(ctx, "3000-3300", probeTimeout)
	if err != nil {
		t.Fatalf("没找到 bridge-api（它起了吗？node bridge-api/src/main.ts）: %v", err)
	}
	t.Logf("找到 %s（端口 %d）", result.BaseURL, result.Port)
	if list := result.notBridgeText(); list != "" {
		t.Logf("另有端口有 HTTP 服务但不是 bridge-api：%s", list)
	}
	if result.Port != 3200 {
		t.Fatalf("找到的是 %d 端口；期望 3200 —— 3100 上那个是另一个版本，不该被认成 bridge-api", result.Port)
	}
}

func TestLiveDiscoveryRejectsOtherService(t *testing.T) {
	// 只探 3100：那是仓库根目录那个 OneBot 版本。它 /health 是 200，
	// 但没有 /api/v1 —— 判据是那份自述，不是「端口开着」。
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	result, err := discoverBridgeAPI(ctx, "3100", probeTimeout)
	if err == nil {
		t.Fatalf("3100 上的服务被认成了 bridge-api（%s，端口 %d）—— 判据太松了", result.BaseURL, result.Port)
	}
	if len(result.NotBridge) == 0 {
		t.Log("3100 上这次没有 HTTP 服务在听（旧版本没起），所以 NotBridge 为空")
	} else {
		t.Logf("正确地拒绝了 3100，并指出它上面有服务：%v", result.NotBridge)
	}
	t.Logf("错误信息：%v", err)
}
