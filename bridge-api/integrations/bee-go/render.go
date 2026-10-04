package main

import (
	"bytes"
	"encoding/json"
	"strings"
)

// 这三个常量与判定层同源，改任何一个都要同时改那边：
//
//	freeformKey     <- src/domain/menu/types.ts 的 FREEFORM_KEY
//	menuReplyHint   <- src/adapter/interactive.ts 的 MENU_REPLY_HINT
//	freeformDefault <- src/adapter/interactive.ts 的 renderInteractiveText 里的缺省文案
const (
	freeformKey     = "0"
	menuReplyHint   = "回复数字。"
	freeformDefault = "自己写一个行为"
	// 全角空格：选项行里「〔不可选〕」前面那个空位（U+3000）
	fullWidthSpace = "\u3000"
)

// outboundItem 是 /api/v1/outbound 里的一条回执。
//
// 字段名与 bridge-api/src/protocol.ts 的 OutboundItem 逐字对应 —— 拼错一个键
// **不会报错**，只会安静地少一个字段（比如选项行全没了）。
type outboundItem struct {
	Seq      int64  "json:\"seq\""
	Kind     string "json:\"kind\""
	Scene    string "json:\"scene\""
	TargetID string "json:\"targetId\""
	Text     string "json:\"text\""
	// Platform 为空 = 主动推送（世界播报），所有上游都会拿到
	Platform string          "json:\"platform\""
	Header   *outboundHeader "json:\"header\""
	// Buttons 是主动推送底部的原始按钮（点了等于手打 command）。
	// 本通道画不出按钮，保留字段只为不丢信息（见 renderOutboundText 的说明）。
	Buttons      []outboundButton "json:\"buttons\""
	Options      []outboundOption "json:\"options\""
	QuickButtons []outboundButton "json:\"quickButtons\""
	// FreeformLabel 必须用 RawMessage：协议里 undefined 与 null 是**两件事**
	//   undefined -> 末尾用默认文案「0. 自己写一个行为」
	//   null      -> 末尾**不要**这一行（业务层显式关掉）
	// 用 *string 接会把两者都变成 nil，于是「关掉那一行」的菜单会凭空多出一行。
	FreeformLabel json.RawMessage "json:\"freeformLabel\""
	Image         *outboundImage  "json:\"image\""
	CreatedAt     int64           "json:\"createdAt\""
}

type outboundHeader struct {
	Nickname     string "json:\"nickname\""
	GenderTag    string "json:\"genderTag\""
	PathwayLine  string "json:\"pathwayLine\""
	LocationName string "json:\"locationName\""
	AvatarURL    string "json:\"avatarUrl\""
}

type outboundButton struct {
	Label   string "json:\"label\""
	Command string "json:\"command\""
}

type outboundOption struct {
	ID    string "json:\"id\""
	Label string "json:\"label\""
	// Command 是完整指令原文，诊断用；按钮本身不传它
	Command string "json:\"command\""
	// Preview / Disabled / DisabledReason 用指针是为了区分「字段缺失」与「显式空值」，
	// 与判定层的渲染逐字对齐（见 downStreamPreview 的注释）
	Preview        *string "json:\"preview\""
	Disabled       *bool   "json:\"disabled\""
	DisabledReason *string "json:\"disabledReason\""
}

type outboundImage struct {
	MediaType string "json:\"mediaType\""
	Base64    string "json:\"base64\""
	URL       string "json:\"url\""
	Alt       string "json:\"alt\""
}

// renderOutboundText 把一条回执渲染成要发出去的正文。
//
// 这是 Koishi 侧 bridge-api/integrations/koishi/src/client.ts 的 renderOutbound
// 的逐字复刻 —— 包括 interactive 那一段与 src/adapter/interactive.ts 的
// renderInteractiveText 完全相同。两个上游渲染不一致的代价是：
// 同一个菜单在 BEE 与 Koishi 上长得不一样，而玩家会以为是游戏变了。
//
// 有一处**有意保留**的差异，写在这里免得后人当成 bug：
//
//	kind=text 的回执即使带 quickButtons 也不追加「快捷指令：」那一行。
//	Koishi 那边同样只对 interactive 追加。保持两边一致优先于「多显示一点」。
func renderOutboundText(item outboundItem) string {
	if item.Kind != "interactive" {
		// text 与 image 的正文都是原样
		return item.Text
	}
	lines := []string{item.Text, ""}
	for _, option := range item.Options {
		preview := ""
		if option.Preview != nil && *option.Preview != "" {
			preview = "（" + *option.Preview + "）"
		}
		disabled := ""
		if option.Disabled != nil && *option.Disabled {
			reason := "暂不可选"
			if option.DisabledReason != nil {
				// 注意：显式空串要原样用（与 JS 的 ?? 语义一致），不能退回默认文案
				reason = *option.DisabledReason
			}
			disabled = fullWidthSpace + "〔不可选：" + reason + "〕"
		}
		lines = append(lines, option.ID+". "+option.Label+preview+disabled)
	}
	if label, show := freeformLine(item.FreeformLabel); show {
		lines = append(lines, freeformKey+". "+label)
	}
	lines = append(lines, "", menuReplyHint)
	if len(item.QuickButtons) > 0 {
		parts := make([]string, 0, len(item.QuickButtons))
		for _, button := range item.QuickButtons {
			parts = append(parts, "."+strings.TrimPrefix(button.Command, "."))
		}
		lines = append(lines, "快捷指令："+strings.Join(parts, fullWidthSpace))
	}
	return strings.Join(lines, "\n")
}

// freeformLine 决定末尾那一行「0. 自己写一个行为」怎么出。
//
// 形状认不出来时**保留那一行**：少说一句比吃掉一句安全。
func freeformLine(raw json.RawMessage) (string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return freeformDefault, true
	}
	if bytes.Equal(trimmed, []byte("null")) {
		return "", false
	}
	var label string
	if err := json.Unmarshal(trimmed, &label); err != nil {
		return freeformDefault, true
	}
	return label, true
}
