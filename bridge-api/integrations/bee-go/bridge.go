package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// maxResponseBytes 是单个响应的读取上限。
//
// 有它是因为一个坏掉的服务端（或中间设备）可以一直吐字节，
// 而 worker 是 32 位进程 —— 读光内存的表现是插件崩掉，不是一条错误日志。
// 16MB 足够装下 base64 图片（BRIDGE_IMAGE_MODE=base64 时用得到）。
const maxResponseBytes = 16 << 20

// inboundResponse 对应协议里的 POST /api/v1/inbound 响应。
//
// 本插件**不用** sync 模式（见 README「为什么只用长轮询」），
// 所以这里只关心 accepted —— 它是唯一能区分
// 「服务端还没装上消息处理器」与「处理了但没回执」的字段。
type inboundResponse struct {
	OK       bool "json:\"ok\""
	Accepted bool "json:\"accepted\""
}

type outboundResponse struct {
	OK     bool           "json:\"ok\""
	Items  []outboundItem "json:\"items\""
	Cursor int64          "json:\"cursor\""
	// Gap = 游标太旧，中间那段已被队列裁剪掉。它是**要被人看见**的事件，不是小事。
	Gap      bool   "json:\"gap\""
	Earliest *int64 "json:\"earliest\""
}

type inboundPayload struct {
	Platform  string "json:\"platform\""
	Scene     string "json:\"scene\""
	SceneID   string "json:\"sceneId\""
	UserID    string "json:\"userId\""
	Nickname  string "json:\"nickname,omitempty\""
	Text      string "json:\"text\""
	MessageID string "json:\"messageId,omitempty\""
	// 刻意不填 timestamp：服务端有自己的时钟，上游传一个错的反而会把事件排到过去
}

type capabilitiesPayload struct {
	Platform string "json:\"platform\""
	// 用指针是为了能显式发 false —— 服务端对 images 的缺省是 true，
	// 「不声明」等于「声明能发图」，那会让玩家收到一条永远看不到的图片消息。
	Buttons *bool "json:\"buttons,omitempty\""
	Images  *bool "json:\"images,omitempty\""
	// RichText 决定判定层生不生成彩色与粗体标记。
	//
	// **不声明等于声明 false**（服务端缺省），而内核那边是按 cfg.RichText 决定要不要
	// 生成标记的 —— 两边必须说同一句话。漏声明过一次，后果是：上游说「我不懂富文本」，
	// 下游却照样发来 $\textcolor{…}$ 和 ** 加粗，于是玩家看到的是源码。
	RichText *bool "json:\"richText,omitempty\""
	// InlineImages 表示这条通道能不能直接吃 base64 内联图。
	//
	// 保持 false：内联图对上游意味着「图在你手上，你自己想办法」，
	// 而 base64 是**一定能落地**的那一种（上游落盘再交给平台）。
	InlineImages *bool "json:\"inlineImages,omitempty\""
}

type bridgeClient struct {
	base     string
	token    string
	platform string
	http     *http.Client
}

func newBridgeClient(cfg Config) *bridgeClient {
	return &bridgeClient{
		base:     cfg.API,
		token:    cfg.Token,
		platform: cfg.Platform,
		// 不设 http.Client.Timeout：超时全部由 context 控制，因为长轮询的
		// 合法耗时（最长 25 秒）远大于其它请求 —— 一个全局超时会把长轮询砍掉。
		http: &http.Client{},
	}
}

// do 发一个请求并返回状态码与响应体。
//
// 非 2xx 时把**服务端说的那句话**原样带进 error：这一层最常见的失败是 401（口令不对）
// 与 400（字段名拼错），两者的修法完全不同，而只报一个状态码是分不出来的。
func (c *bridgeClient) do(ctx context.Context, method, path string, body any) (int, []byte, error) {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return 0, nil, fmt.Errorf("编码请求体: %w", err)
		}
		reader = bytes.NewReader(payload)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.base+path, reader)
	if err != nil {
		return 0, nil, fmt.Errorf("构造请求: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json; charset=utf-8")
	}
	if c.token != "" {
		request.Header.Set("Authorization", "Bearer "+c.token)
	}
	response, err := c.http.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes))
	if err != nil {
		return response.StatusCode, nil, fmt.Errorf("读取响应: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.StatusCode == http.StatusUnauthorized {
			// 401 只有一种成因，而且插件这侧能把它说清楚，就不该只留一个状态码：
			// 游戏机那边只接受本机请求（没设 BRIDGE_TOKEN 时非本机一律 401，
			// 这是有意的默认值，不是漏配）。
			return response.StatusCode, data, fmt.Errorf(
				"%d %s（游戏机那边只接受本机请求；跨机部署要把 bridge-config.json 的 token 填成它的 BRIDGE_TOKEN）",
				response.StatusCode, snippet(data))
		}
		return response.StatusCode, data, fmt.Errorf("%d %s", response.StatusCode, snippet(data))
	}
	return response.StatusCode, data, nil
}

func snippet(data []byte) string {
	text := strings.TrimSpace(string(data))
	if len(text) > 300 {
		text = text[:300]
	}
	if text == "" {
		return "(空响应体)"
	}
	return text
}

// inbound 把一条玩家消息送进判定层。
//
// 不带 sync：回执统一走长轮询那一条路。
// 同时用两条路会**丢消息**（sync 返回的 cursor 只是「这批回执的最大 seq」，
// 拿它去推轮询游标会把中间那些主动推送跳过去），协议文档里明确警告过。
func (c *bridgeClient) inbound(ctx context.Context, payload inboundPayload) error {
	payload.Platform = c.platform
	_, data, err := c.do(ctx, http.MethodPost, "/api/v1/inbound", payload)
	if err != nil {
		return err
	}
	var parsed inboundResponse
	if err := json.Unmarshal(data, &parsed); err != nil {
		return fmt.Errorf("解析入站响应: %w", err)
	}
	if !parsed.Accepted {
		// accepted=false 只有一种情况：服务端还没装上消息处理器（启动中断/正在关闭）
		return fmt.Errorf("服务端未接收（accepted=false）：判定层可能还没就绪")
	}
	return nil
}

// outbound 取一批回执。waitSec > 0 时是长轮询（没数据就挂着，来数据立刻返回）。
func (c *bridgeClient) outbound(ctx context.Context, cursor int64, waitSec, limit int) (outboundResponse, error) {
	query := url.Values{}
	query.Set("cursor", strconv.FormatInt(cursor, 10))
	query.Set("limit", strconv.Itoa(limit))
	// platform 决定「这条回执是不是给我的」：定向回执（由入站消息触发）只发给来源上游，
	// 没有 platform 的主动推送（世界播报）所有上游都会拿到。
	query.Set("platform", c.platform)
	if waitSec > 0 {
		query.Set("wait", strconv.Itoa(waitSec))
	}
	_, data, err := c.do(ctx, http.MethodGet, "/api/v1/outbound?"+query.Encode(), nil)
	if err != nil {
		return outboundResponse{}, err
	}
	var parsed outboundResponse
	if err := json.Unmarshal(data, &parsed); err != nil {
		return outboundResponse{}, fmt.Errorf("解析出站响应: %w", err)
	}
	return parsed, nil
}

// declareCapabilities 声明这条通道能做什么。
//
// 必须显式声明 images=false：服务端对 images 的缺省是 true（它假设上游框架基本都能发图），
// 而本插件在 BRIDGE_IMAGE_MODE=base64 时发不出图 —— 那时候玩家会收到一条
// 他永远看不到的消息，且**没有任何报错**。
func (c *bridgeClient) declareCapabilities(ctx context.Context, images, buttons, richText bool) error {
	// 四个字段都要显式发：服务端对 images 的缺省是 true，对 richText / inlineImages
	// 的缺省是 false —— 「不声明」本身就是一句声明，而且是错的那句。
	inlineImages := false
	payload := capabilitiesPayload{
		Platform:     c.platform,
		Images:       &images,
		Buttons:      &buttons,
		RichText:     &richText,
		InlineImages: &inlineImages,
	}
	_, _, err := c.do(ctx, http.MethodPost, "/api/v1/capabilities", payload)
	return err
}

// adminsPayload 是上报管理员名单的报文（M2.172）。
type adminsPayload struct {
	Platform string   `json:"platform"`
	AdminIDs []string `json:"adminIds"`
}

// reportAdmins 把这条通道上的管理员名单报给内核。
//
// 幂等：同一个 platform 再报一次就是**覆盖**，不会累积 —— 启动时报一次即可。
// 失败不致命：内核自己那份（.env 的 ADMIN_IDS）不受影响。
func (c *bridgeClient) reportAdmins(ctx context.Context, adminIDs []string) error {
	if len(adminIDs) == 0 {
		return nil
	}
	payload := adminsPayload{Platform: c.platform, AdminIDs: adminIDs}
	_, _, err := c.do(ctx, http.MethodPost, "/api/v1/admins", payload)
	return err
}

// timeoutContext 给一次请求套上超时。
//
// 长轮询要留出 wait + 余量，普通请求给 15 秒 —— 判定层跑一条指令通常几十毫秒，
// 15 秒还没回来说明对面已经不是「慢」，而是出事了。
func timeoutContext(parent context.Context, waitSec int) (context.Context, context.CancelFunc) {
	if waitSec > 0 {
		return context.WithTimeout(parent, time.Duration(waitSec)*time.Second+20*time.Second)
	}
	return context.WithTimeout(parent, 15*time.Second)
}
