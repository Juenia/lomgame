package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// newTestBridge 起一个假服务端，把收到的请求交给 handler，并返回记录下来的请求体。
func newTestBridge(t *testing.T, handler http.HandlerFunc) (*bridgeClient, *[]recordedRequest) {
	t.Helper()
	recorded := &[]recordedRequest{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		*recorded = append(*recorded, recordedRequest{
			method: r.Method,
			path:   r.URL.Path,
			query:  r.URL.RawQuery,
			header: r.Header,
			body:   string(body),
		})
		handler(w, r)
	}))
	t.Cleanup(server.Close)
	return newBridgeClient(Config{API: server.URL, Platform: "bee"}), recorded
}

type recordedRequest struct {
	method string
	path   string
	query  string
	header http.Header
	body   string
}

func TestInboundSendsProtocolFields(t *testing.T) {
	client, recorded := newTestBridge(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("{\"ok\":true,\"accepted\":true}"))
	})
	err := client.inbound(context.Background(), inboundPayload{
		Scene: sceneGroup, SceneID: "123456", UserID: "20001",
		Nickname: "克莱恩", Text: ".状态", MessageID: "m-1",
	})
	if err != nil {
		t.Fatalf("inbound: %v", err)
	}
	req := (*recorded)[0]
	if req.method != http.MethodPost || req.path != "/api/v1/inbound" {
		t.Fatalf("请求不对: %s %s", req.method, req.path)
	}
	var sent map[string]any
	if err := json.Unmarshal([]byte(req.body), &sent); err != nil {
		t.Fatalf("请求体不是 JSON: %v (%s)", err, req.body)
	}
	// platform 由客户端补上，调用方不用管
	if sent["platform"] != "bee" {
		t.Fatalf("platform = %v, want bee", sent["platform"])
	}
	for key, want := range map[string]string{
		"scene": "group", "sceneId": "123456", "userId": "20001",
		"nickname": "克莱恩", "text": ".状态", "messageId": "m-1",
	} {
		if sent[key] != want {
			t.Fatalf("%s = %v, want %q", key, sent[key], want)
		}
	}
	// sync 绝不能出现：本插件只用长轮询一条路，混用会丢消息（见 client.inbound 的注释）
	if _, exists := sent["sync"]; exists {
		t.Fatal("请求体里不应出现 sync")
	}
	if !strings.HasPrefix(req.header.Get("Content-Type"), "application/json") {
		t.Fatalf("Content-Type = %q", req.header.Get("Content-Type"))
	}
	if req.header.Get("Authorization") != "" {
		t.Fatal("口令为空时不应带 Authorization")
	}
}

func TestInboundRejectsNotAccepted(t *testing.T) {
	client, _ := newTestBridge(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("{\"ok\":true,\"accepted\":false}"))
	})
	err := client.inbound(context.Background(), inboundPayload{Scene: sceneGroup, SceneID: "1", UserID: "2", Text: "x"})
	if err == nil {
		t.Fatal("accepted=false 时必须报错，否则上游会以为消息已经进了判定层")
	}
	if !strings.Contains(err.Error(), "accepted") {
		t.Fatalf("错误信息应说明原因，得到 %v", err)
	}
}

func TestOutboundBuildsQueryAndParsesResponse(t *testing.T) {
	client, recorded := newTestBridge(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("{\"ok\":true,\"items\":[" +
			"{\"seq\":12,\"kind\":\"text\",\"scene\":\"group\",\"targetId\":\"123\",\"text\":\"你好\",\"createdAt\":1}," +
			"{\"seq\":13,\"kind\":\"interactive\",\"scene\":\"private\",\"targetId\":\"20001\",\"text\":\"菜单\",\"createdAt\":2}" +
			"],\"cursor\":13,\"gap\":true,\"earliest\":40}"))
	})
	response, err := client.outbound(context.Background(), 10, 25, 20)
	if err != nil {
		t.Fatalf("outbound: %v", err)
	}
	query := (*recorded)[0].query
	for _, want := range []string{"cursor=10", "limit=20", "platform=bee", "wait=25"} {
		if !strings.Contains(query, want) {
			t.Fatalf("query %q 里缺少 %s", query, want)
		}
	}
	if len(response.Items) != 2 || response.Cursor != 13 {
		t.Fatalf("解析结果不对: %+v", response)
	}
	if !response.Gap || response.Earliest == nil || *response.Earliest != 40 {
		t.Fatalf("gap/earliest 没解析出来: %+v", response)
	}
	if response.Items[0].Scene != sceneGroup || response.Items[1].TargetID != "20001" {
		t.Fatalf("items 字段错位: %+v", response.Items)
	}
}

func TestOutboundOmitsWaitWhenZero(t *testing.T) {
	client, recorded := newTestBridge(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("{\"ok\":true,\"items\":[],\"cursor\":10}"))
	})
	if _, err := client.outbound(context.Background(), 10, 0, 20); err != nil {
		t.Fatalf("outbound: %v", err)
	}
	if strings.Contains((*recorded)[0].query, "wait=") {
		t.Fatalf("wait=0 时不该带这个参数: %q", (*recorded)[0].query)
	}
}

func TestErrorCarriesServerMessage(t *testing.T) {
	client, _ := newTestBridge(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte("{\"ok\":false,\"error\":\"unauthorized\"}"))
	})
	_, err := client.outbound(context.Background(), 0, 0, 20)
	if err == nil {
		t.Fatal("401 必须报错")
	}
	// 401 与 400 的修法完全不同，所以服务端那句话必须带出来
	if !strings.Contains(err.Error(), "401") || !strings.Contains(err.Error(), "unauthorized") {
		t.Fatalf("错误信息应带上状态码与服务端原话，得到 %v", err)
	}
}

func TestCapabilitiesSendExplicitFalse(t *testing.T) {
	client, recorded := newTestBridge(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("{\"ok\":true}"))
	})
	if err := client.declareCapabilities(context.Background(), false, false, false); err != nil {
		t.Fatalf("declareCapabilities: %v", err)
	}
	body := (*recorded)[0].body
	// 必须**显式**发 false：服务端对 images 的缺省是 true（它假设上游都能发图），
	// 不声明等于声明能发图 —— 那时玩家会收到一条永远看不到的图片消息。
	if !strings.Contains(body, "\"images\":false") || !strings.Contains(body, "\"buttons\":false") {
		t.Fatalf("能力声明必须显式为 false，实际请求体: %s", body)
	}
}

func TestBearerTokenIsSentWhenConfigured(t *testing.T) {
	recorded := &[]recordedRequest{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*recorded = append(*recorded, recordedRequest{header: r.Header})
		_, _ = w.Write([]byte("{\"ok\":true,\"items\":[],\"cursor\":0}"))
	}))
	defer server.Close()
	client := newBridgeClient(Config{API: server.URL, Platform: "bee", Token: "s3cret"})
	if _, err := client.outbound(context.Background(), 0, 0, 20); err != nil {
		t.Fatalf("outbound: %v", err)
	}
	if got := (*recorded)[0].header.Get("Authorization"); got != "Bearer s3cret" {
		t.Fatalf("Authorization = %q, want Bearer s3cret", got)
	}
}
