package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// joinLines 让期望值保持"一行一个字面量"的形状 ——
// 这些断言的价值就在排版上，藏在转义符里就没法读了。
func joinLines(lines ...string) string { return strings.Join(lines, "\n") }

func TestRenderOutboundText(t *testing.T) {
	// 这一组用例守的是「与判定层逐字一致」：
	// 期望值就是 src/adapter/interactive.ts 的 renderInteractiveText 的输出，
	// 以及 Koishi 侧 client.ts 的 renderOutbound 为 interactive 追加的那两行。
	// 排版差一个空格，玩家看到的就是另一个菜单。
	disabled := true
	reason := "HP 不足"
	preview := "危险"
	empty := ""

	cases := []struct {
		name string
		item outboundItem
		want string
	}{
		{
			name: "text 原样返回",
			item: outboundItem{Kind: "text", Text: "你向前走了一步。"},
			want: "你向前走了一步。",
		},
		{
			name: "image 的正文也原样返回（图另发一条）",
			item: outboundItem{Kind: "image", Text: "", Image: &outboundImage{MediaType: "image/png"}},
			want: "",
		},
		{
			name: "interactive 完整排版",
			item: outboundItem{
				Kind: "interactive",
				Text: "【下一步 · 廷根市】",
				Options: []outboundOption{
					{ID: "1", Label: "前进", Preview: &preview},
					{ID: "2", Label: "休息", Disabled: &disabled, DisabledReason: &reason},
				},
			},
			want: joinLines(
				"【下一步 · 廷根市】",
				"",
				"1. 前进（危险）",
				"2. 休息　〔不可选：HP 不足〕",
				"0. 自己写一个行为",
				"",
				"回复数字。",
			),
		},
		{
			name: "freeformLabel 缺失 = 用默认文案",
			item: outboundItem{Kind: "interactive", Text: "T"},
			want: joinLines("T", "", "0. 自己写一个行为", "", "回复数字。"),
		},
		{
			name: "freeformLabel 为 null = 不要那一行",
			item: outboundItem{Kind: "interactive", Text: "T", FreeformLabel: json.RawMessage("null")},
			want: joinLines("T", "", "", "回复数字。"),
		},
		{
			name: "freeformLabel 是空串：与 JS 的 ?? 语义一致，得到「0. 」而不是默认文案",
			item: outboundItem{Kind: "interactive", Text: "T", FreeformLabel: json.RawMessage("\"\"")},
			want: joinLines("T", "", "0. ", "", "回复数字。"),
		},
		{
			name: "freeformLabel 自定义文案",
			item: outboundItem{Kind: "interactive", Text: "T", FreeformLabel: json.RawMessage("\"说句话\"")},
			want: joinLines("T", "", "0. 说句话", "", "回复数字。"),
		},
		{
			name: "preview 是空串时不显示括号（判定层判的是 truthy）",
			item: outboundItem{
				Kind:    "interactive",
				Text:    "T",
				Options: []outboundOption{{ID: "1", Label: "走", Preview: &empty}},
			},
			want: joinLines("T", "", "1. 走", "0. 自己写一个行为", "", "回复数字。"),
		},
		{
			name: "disabledReason 显式空串时不退回默认文案",
			item: outboundItem{
				Kind:    "interactive",
				Text:    "T",
				Options: []outboundOption{{ID: "1", Label: "走", Disabled: &disabled, DisabledReason: &empty}},
			},
			want: joinLines("T", "", "1. 走　〔不可选：〕", "0. 自己写一个行为", "", "回复数字。"),
		},
		{
			name: "disabled 为 false 不画不可选标记",
			item: outboundItem{
				Kind:    "interactive",
				Text:    "T",
				Options: []outboundOption{{ID: "1", Label: "走", Disabled: boolPtr(false)}},
			},
			want: joinLines("T", "", "1. 走", "0. 自己写一个行为", "", "回复数字。"),
		},
		{
			name: "快捷指令按钮落在最后一行",
			item: outboundItem{
				Kind:         "interactive",
				Text:         "T",
				Options:      []outboundOption{{ID: "1", Label: "走"}},
				QuickButtons: []outboundButton{{Label: "状态", Command: ".状态"}, {Label: "帮助", Command: "帮助"}},
			},
			want: joinLines("T", "", "1. 走", "0. 自己写一个行为", "", "回复数字。", "快捷指令：.状态　.帮助"),
		},
		{
			name: "kind=text 带 quickButtons 也不追加（与 Koishi 保持一致）",
			item: outboundItem{Kind: "text", Text: "T", QuickButtons: []outboundButton{{Command: ".状态"}}},
			want: "T",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := renderOutboundText(tc.item); got != tc.want {
				t.Fatalf("渲染不一致\n--- got ---\n%s\n--- want ---\n%s", got, tc.want)
			}
		})
	}
}

func boolPtr(v bool) *bool { return &v }

func TestFreeformLineShapes(t *testing.T) {
	cases := []struct {
		name      string
		raw       string
		wantLabel string
		wantShow  bool
	}{
		{name: "缺失", raw: "", wantLabel: freeformDefault, wantShow: true},
		{name: "null", raw: "null", wantShow: false},
		{name: "字符串", raw: "\"自定义\"", wantLabel: "自定义", wantShow: true},
		// 形状认不出来时保留那一行：少说一句比吃掉一句安全
		{name: "数字（协议里不该出现）", raw: "123", wantLabel: freeformDefault, wantShow: true},
		{name: "带空格包裹的 null", raw: "  null  ", wantShow: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			label, show := freeformLine(json.RawMessage(tc.raw))
			if show != tc.wantShow || label != tc.wantLabel {
				t.Fatalf("freeformLine(%q) = (%q, %v), want (%q, %v)", tc.raw, label, show, tc.wantLabel, tc.wantShow)
			}
		})
	}
}

// resolveImage 要认两种图片形态。
//
// 默认的 BRIDGE_IMAGE_MODE 是 base64 —— 也就是说，如果只认 URL，
// 那么**默认配置下永远发不出图**，玩家看到的角色卡永远是一大段文字。
// 这条用例守的就是那条默认路径。
func TestResolveImageHandlesBothShapes(t *testing.T) {
	rt := newBridgeRuntime()
	rt.prepare(t.TempDir())

	withURL := outboundItem{Seq: 1, Image: &outboundImage{
		MediaType: "image/png", URL: "https://example.test/a.png", Base64: "AAAA",
	}}
	if got, cleanup := rt.resolveImage(withURL, Config{Images: true}); got != "https://example.test/a.png" || cleanup != nil {
		t.Fatalf("有 URL 时应直接用 URL（省一次落盘），得到 %q", got)
	}

	payload := base64.StdEncoding.EncodeToString([]byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a})
	onlyBase64 := outboundItem{Seq: 2, Image: &outboundImage{MediaType: "image/png", Base64: payload}}
	path, cleanup := rt.resolveImage(onlyBase64, Config{Images: true})
	if path == "" || cleanup == nil {
		t.Fatalf("只有 base64 时应落盘，得到 %q", path)
	}
	if filepath.Ext(path) != ".png" {
		t.Fatalf("后缀要是 .png —— 框架靠它认这是不是图片，得到 %q", path)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("文件没写出来: %v", err)
	}
	cleanup()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("cleanup 应该把临时文件删掉 —— 不删的话每张卡都留一个文件")
	}

	if got, _ := rt.resolveImage(withURL, Config{Images: false}); got != "" {
		t.Fatalf("images=false 时一律不给图，得到 %q", got)
	}

	broken := outboundItem{Seq: 3, Image: &outboundImage{MediaType: "image/png", Base64: "!!!not base64!!!"}}
	if got, _ := rt.resolveImage(broken, Config{Images: true}); got != "" {
		t.Fatalf("坏 base64 该被吞掉（这一条只发文字），得到 %q", got)
	}

	if got := extensionForMediaType("image/jpeg"); got != ".jpg" {
		t.Fatalf("jpeg 的后缀 = %q", got)
	}
}
