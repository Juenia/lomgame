package main

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

// bridgeAPIStub 起一个「像 bridge-api 那样应答 GET /api/v1」的假服务端。
func bridgeAPIStub(t *testing.T) (port int, closeFn func()) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte("{\"ok\":true," +
			"\"service\":\"lord-of-mysteries bridge-api（无适配器 / 纯 API 版）\"," +
			"\"endpoints\":[\"POST /api/v1/inbound          上游送一条玩家消息进来\"," +
			"\"GET  /api/v1/outbound?cursor=&wait=&platform=   取回执（长轮询）\"]}"))
	}))
	port = server.Listener.Addr().(*net.TCPAddr).Port
	return port, server.Close
}

func TestLooksLikeBridgeAPI(t *testing.T) {
	cases := []struct {
		name string
		body string
		want bool
	}{
		{
			name: "真的自述",
			body: "{\"ok\":true,\"service\":\"… bridge-api …\",\"endpoints\":[\"POST /api/v1/inbound\"]}",
			want: true,
		},
		{
			name: "端点列表里没有 inbound（不是这一版）",
			body: "{\"ok\":true,\"service\":\"something\",\"endpoints\":[\"GET /other\"]}",
			want: false,
		},
		{
			name: "ok 为 false",
			body: "{\"ok\":false,\"endpoints\":[\"POST /api/v1/inbound\"]}",
			want: false,
		},
		{
			name: "不是 JSON（比如某个网页服务占了端口）",
			body: "<html><body>hello</body></html>",
			want: false,
		},
		{name: "空响应", body: "", want: false},
		{
			// 端点列表是协议的一部分，service 文案是给人看的、随时可能改，
			// 所以列表缺失时退回看名字 —— 这条守的是「文案改了也不会认错」
			name: "只有 service 名字（端点列表将来可能不再列）",
			body: "{\"ok\":true,\"service\":\"lord-of-mysteries bridge-api\"}",
			want: true,
		},
		{
			name: "别的服务恰好也叫 ok",
			body: "{\"ok\":true,\"service\":\"unrelated\"}",
			want: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := looksLikeBridgeAPI([]byte(tc.body)); got != tc.want {
				t.Fatalf("looksLikeBridgeAPI = %v, want %v（body=%s）", got, tc.want, tc.body)
			}
		})
	}
}

func TestParsePortRange(t *testing.T) {
	cases := []struct {
		name    string
		spec    string
		want    []int
		wantErr bool
	}{
		{name: "区间", spec: "10-13", want: []int{10, 11, 12, 13}},
		{name: "单个", spec: "3200", want: []int{3200}},
		{name: "逗号分隔", spec: "3200,8080", want: []int{3200, 8080}},
		{name: "混合并排序去重", spec: "8000-8001,3200,3200", want: []int{3200, 8000, 8001}},
		{name: "反向区间也认", spec: "13-10", want: []int{10, 11, 12, 13}},
		{name: "空 = 默认区间", spec: "   ", want: nil},
		{name: "非法输入要报错", spec: "abc", wantErr: true},
		{name: "半个区间要报错", spec: "1000-x", wantErr: true},
		{name: "超范围端口被丢掉", spec: "70000", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parsePortRange(tc.spec)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("parsePortRange(%q) 应该报错，得到 %v", tc.spec, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("parsePortRange(%q): %v", tc.spec, err)
			}
			if tc.want == nil {
				if len(got) <= 1 {
					t.Fatalf("空 spec 应展开成默认区间，得到 %v", got)
				}
				return
			}
			if len(got) != len(tc.want) {
				t.Fatalf("parsePortRange(%q) = %v, want %v", tc.spec, got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("parsePortRange(%q) = %v, want %v", tc.spec, got, tc.want)
				}
			}
		})
	}
}

func TestDiscoverFindsBridgeAPI(t *testing.T) {
	port, closeFn := bridgeAPIStub(t)
	defer closeFn()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	result, err := discoverBridgeAPI(ctx, strconv.Itoa(port), probeTimeout)
	if err != nil {
		t.Fatalf("应该找到，却报错: %v", err)
	}
	if result.Port != port {
		t.Fatalf("找到的端口 = %d, want %d", result.Port, port)
	}
	if result.BaseURL != "http://127.0.0.1:"+strconv.Itoa(port) {
		t.Fatalf("地址 = %q", result.BaseURL)
	}
}

// 两个都像 bridge-api 时，必须稳定地选端口小的那个。
//
// 反例是「谁先返回用谁」：同一台机器上重复探测会给出不同答案，
// 表现为「有时候正常、有时候不回话」—— 那种问题最难查。
func TestDiscoverPicksSmallestPortWhenSeveralMatch(t *testing.T) {
	portA, closeA := bridgeAPIStub(t)
	defer closeA()
	portB, closeB := bridgeAPIStub(t)
	defer closeB()
	low, high := portA, portB
	if low > high {
		low, high = high, low
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	result, err := discoverBridgeAPI(ctx, strconv.Itoa(low)+","+strconv.Itoa(high), probeTimeout)
	if err != nil {
		t.Fatalf("应该找到: %v", err)
	}
	if result.Port != low {
		t.Fatalf("找到端口 %d，应稳定选较小的 %d", result.Port, low)
	}
}

func TestDiscoverReportsNothingFound(t *testing.T) {
	// 端口 1 上不会有服务在听（就算有也要管理员权限），本机连它立刻被拒
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := discoverBridgeAPI(ctx, "1-2", 200*time.Millisecond)
	if err == nil {
		t.Fatal("没有 bridge-api 时必须报错，否则插件会安静地连一个不存在的地址")
	}
	// 错误信息要能直接指导下一步：说清探了哪儿、以及该怎么办
	if !strings.Contains(err.Error(), "1-2") || !strings.Contains(err.Error(), "api") {
		t.Fatalf("错误信息应该指路，得到 %v", err)
	}
}

func TestDiscoverIgnoresNonBridgeService(t *testing.T) {
	// 一个「响应 200 但不是 bridge-api」的服务：比如别的开发服务器占了 3200
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("<html>完全是别的东西</html>"))
	}))
	defer server.Close()
	port := server.Listener.Addr().(*net.TCPAddr).Port

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result, err := discoverBridgeAPI(ctx, strconv.Itoa(port), probeTimeout)
	if err == nil {
		t.Fatal("响应 200 但不是 bridge-api 的端口不该被认成服务端")
	}
	// 光说「没找到」不够：那个端口上**有**东西，这件事必须被报出来
	if len(result.NotBridge) != 1 || result.NotBridge[0] != port {
		t.Fatalf("应该报出「有服务但不是 bridge-api」的端口，得到 %v", result.NotBridge)
	}
}

// 这条守的是现场最常见的一种情况：机器上跑着**另一个版本**的游戏服务
// （仓库根目录的 src/main.ts，只走 OneBot），它有 /health 但没有 /api/v1。
//
// 只回一句「没找到」的话，人会去查网络、查防火墙、查端口区间，
// 而真正的原因是：他要对接的 bridge-api 根本没起。
func TestDiscoverReportsPortsThatAreNotBridgeAPI(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 像旧版本那样：任何路径都是 404 JSON
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("{\"ok\":false,\"error\":\"not found\"}"))
	}))
	defer server.Close()
	port := server.Listener.Addr().(*net.TCPAddr).Port

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result, err := discoverBridgeAPI(ctx, strconv.Itoa(port), probeTimeout)
	if err == nil {
		t.Fatal("那不是 bridge-api，必须报错")
	}
	if len(result.NotBridge) != 1 || result.NotBridge[0] != port {
		t.Fatalf("应该把这个「有服务但不是它」的端口报出来，得到 %v", result.NotBridge)
	}
	// 单有结构体字段没用 —— 用户看的是错误信息，它必须点名那个端口
	if !strings.Contains(err.Error(), strconv.Itoa(port)) {
		t.Fatalf("错误信息里应该点名这个端口：%v", err)
	}
	if !strings.Contains(err.Error(), "bridge-api") {
		t.Fatalf("错误信息里应该说清要找的是什么：%v", err)
	}
}
