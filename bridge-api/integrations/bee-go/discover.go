package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 自动检索 bridge-api 的端口。
//
// 为什么需要它：BRIDGE_PORT 在 .env 里可改（默认 3200），而插件这边写死端口的话，
// 改了端口的人只会看到「机器人不回话」—— 没有任何一条报错指向端口。
// 同机部署时端口是能自己找出来的，所以 api 字段留空就走这条路。
//
// 判据用的是 GET /api/v1（端点自述），选它有两个理由：
//
//	· 它是 bridge-api **独有**的端点 —— 仓库根目录那个 OneBot 版本没有它，
//	  同一台机器上两个版本一起跑时不会认错；
//	· 它**不需要口令** —— 检索发生在配口令之前，先用免口令端点确认「这个端口是不是它」。
const (
	// defaultScanRange 是默认候选端口区间。
	// 3200 = bridge-api 的默认（.env.example 里的 BRIDGE_PORT）；
	// 3100 = 仓库根目录那个版本的默认端口 —— 顺手一起试，成本只是一次连接。
	defaultScanRange = "3100-3300"
	// probeTimeout 是单个端口的探测超时。
	probeTimeout = 400 * time.Millisecond
	// probeConcurrency 是第二轮并发扫描的并发度。
	probeConcurrency = 32
	// maxProbePorts 是候选端口数量上限，防止有人把 scanRange 写成 "1-65535"
	// 把一个本该几百毫秒的操作变成一次端口风暴。
	maxProbePorts = 2048
)

// preferredProbePorts 是第一轮串行试的端口：绝大多数部署在这两个里就结束了，
// 命中耗时是毫秒级，不必走并发那一套。
var preferredProbePorts = []int{3200, 3100}

// probeHTTPClient 是探测专用客户端。
//
// 与业务客户端分开是因为它有两处不同：不带口令（探测用的是免口令端点），
// 以及**不跟重定向** —— 一个 302 到别处的端口不该被当成 bridge-api。
var probeHTTPClient = &http.Client{
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

func baseURLForPort(port int) string { return "http://127.0.0.1:" + strconv.Itoa(port) }

// looksLikeBridgeAPI 判断 GET /api/v1 的响应体是不是 bridge-api 的自述。
//
// 判据是**端点列表里有没有 /api/v1/inbound**，而不是比对 service 那串文案：
// 文案是给人看的、随时可能改，端点列表是协议的一部分。
// service 只作为第二道判据（万一将来自述里不再列端点）。
func looksLikeBridgeAPI(body []byte) bool {
	var parsed struct {
		OK        bool     "json:\"ok\""
		Service   string   "json:\"service\""
		Endpoints []string "json:\"endpoints\""
	}
	if err := json.Unmarshal(body, &parsed); err != nil || !parsed.OK {
		return false
	}
	for _, endpoint := range parsed.Endpoints {
		if strings.Contains(endpoint, "/api/v1/inbound") {
			return true
		}
	}
	return strings.Contains(parsed.Service, "bridge-api")
}

// parsePortRange 解析候选端口写法：支持 "3100-3300"、"3200"、"3200,8080"、"3200,8000-8010"。
//
// 解析失败要**报错**而不是静默回落默认值：写错端口范围的人，
// 最需要知道的恰恰是「你写的那个范围我没读懂」。
func parsePortRange(spec string) ([]int, error) {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		spec = defaultScanRange
	}
	seen := map[int]bool{}
	var ports []int
	addOne := func(port int) {
		if port <= 0 || port > 65535 || seen[port] {
			return
		}
		seen[port] = true
		ports = append(ports, port)
	}
	for _, piece := range strings.Split(spec, ",") {
		text := strings.TrimSpace(piece)
		if text == "" {
			continue
		}
		if dash := strings.Index(text, "-"); dash > 0 {
			low, errLow := strconv.Atoi(strings.TrimSpace(text[:dash]))
			high, errHigh := strconv.Atoi(strings.TrimSpace(text[dash+1:]))
			if errLow != nil || errHigh != nil {
				return nil, fmt.Errorf("端口范围 %q 不是数字", text)
			}
			if low > high {
				low, high = high, low
			}
			for port := low; port <= high && len(ports) < maxProbePorts; port++ {
				addOne(port)
			}
			continue
		}
		port, err := strconv.Atoi(text)
		if err != nil {
			return nil, fmt.Errorf("端口 %q 不是数字", text)
		}
		addOne(port)
	}
	if len(ports) == 0 {
		return nil, fmt.Errorf("没有可探测的端口：%q", spec)
	}
	sort.Ints(ports)
	return ports, nil
}

// probeOutcome 是一次探测的三种结果。
//
// 「连不上」与「连上了但不是它」必须分开记：前者什么都不用说，
// 后者是**最有用的一句诊断** —— 探测失败时，人最需要知道的恰恰是
// 「3100 上确实有东西，但它不是 bridge-api」。
type probeOutcome int

const (
	// probeDead：连不上、超时、或者响应不是 200 —— 这个端口上没人在听 HTTP
	probeDead probeOutcome = iota
	// probeOther：是个 HTTP 服务，但 GET /api/v1 不是 bridge-api 的自述
	probeOther
	// probeBridge：确认是 bridge-api
	probeBridge
)

// String 让 probeOutcome 在日志和错误信息里是能读的词，而不是一个数字。
//
// waitCoreReady 超时的时候会把最后一次探测结果写进错误里 ——
// 「最后一次探测：连不上」和「最后一次探测：2」在排障时是两种东西。
func (outcome probeOutcome) String() string {
	switch outcome {
	case probeBridge:
		return "是 bridge-api"
	case probeOther:
		return "有 HTTP 服务但不是 bridge-api"
	default:
		return "连不上"
	}
}

// probeEndpoint 探一个地址，判断它是不是 bridge-api。
func probeEndpoint(ctx context.Context, baseURL string, timeout time.Duration) probeOutcome {
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(callCtx, http.MethodGet, baseURL+"/api/v1", nil)
	if err != nil {
		return probeDead
	}
	response, err := probeHTTPClient.Do(request)
	if err != nil {
		return probeDead
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 64<<10))
	if err != nil {
		return probeDead
	}
	if response.StatusCode != http.StatusOK {
		// 有响应但不是 200：那上面**有**服务（比如回 404 的旧版本），
		// 只是没有 /api/v1 这个端点 —— 对排障来说这条比「连不上」值钱得多
		return probeOther
	}
	if looksLikeBridgeAPI(body) {
		return probeBridge
	}
	return probeOther
}

// discoveryResult 是一次端口检索的结果。
type discoveryResult struct {
	BaseURL string
	Port    int
	// NotBridge 是「有 HTTP 服务、但不是 bridge-api」的端口（升序）。
	//
	// 这是整次检索里最有诊断价值的一项：失败时它直接指出「你起的是别的东西」，
	// 成功时它也说明旁边还跑着什么。没有它的话，失败信息只剩一句
	// 「没找到」—— 而用户真正需要知道的是「3100 上确实有服务，只是它不是我要的那个」。
	NotBridge []int
	// Probed 是这次一共探了多少个端口。
	Probed int
}

// notBridgeText 把 NotBridge 拼成一句话里的清单，太长就截断。
func (result discoveryResult) notBridgeText() string {
	if len(result.NotBridge) == 0 {
		return ""
	}
	const maxList = 8
	shown, suffix := result.NotBridge, ""
	if len(shown) > maxList {
		shown, suffix = shown[:maxList], " 等"
	}
	parts := make([]string, 0, len(shown))
	for _, port := range shown {
		parts = append(parts, strconv.Itoa(port))
	}
	return strings.Join(parts, "、") + suffix
}

// discoverBridgeAPI 按候选端口找出 bridge-api。
//
// 两轮：先串行试已知默认端口（快），没中再并发扫其余。
//
// 第二轮收集**全部**命中后取端口最小的那个，而不是「谁先返回用谁」：
// 同一台机器上重复探测必须给出同一个答案，否则今天连这个端口、明天连那个，
// 表现为「有时候机器人正常、有时候不回话」—— 那种问题最难查。
func discoverBridgeAPI(ctx context.Context, spec string, timeout time.Duration) (discoveryResult, error) {
	ports, err := parsePortRange(spec)
	if err != nil {
		return discoveryResult{}, err
	}
	if timeout <= 0 {
		timeout = probeTimeout
	}
	inRange := make(map[int]bool, len(ports))
	for _, port := range ports {
		inRange[port] = true
	}
	result := discoveryResult{Probed: len(ports)}

	// 第一轮：已知默认端口，串行（这一段不需要锁）
	for _, port := range preferredProbePorts {
		if !inRange[port] {
			continue
		}
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		switch probeEndpoint(ctx, baseURLForPort(port), timeout) {
		case probeBridge:
			result.BaseURL, result.Port = baseURLForPort(port), port
			return result, nil
		case probeOther:
			result.NotBridge = append(result.NotBridge, port)
		}
	}

	// 第二轮：并发扫其余
	rest := make([]int, 0, len(ports))
	for _, port := range ports {
		if port != 3200 && port != 3100 {
			rest = append(rest, port)
		}
	}
	var (
		mu     sync.Mutex
		found  []int
		others []int
		wg     sync.WaitGroup
	)
	portCh := make(chan int)
	workers := probeConcurrency
	if len(rest) < workers {
		workers = len(rest)
	}
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for port := range portCh {
				switch probeEndpoint(ctx, baseURLForPort(port), timeout) {
				case probeBridge:
					mu.Lock()
					found = append(found, port)
					mu.Unlock()
				case probeOther:
					mu.Lock()
					others = append(others, port)
					mu.Unlock()
				}
			}
		}()
	}
	for _, port := range rest {
		if ctx.Err() != nil {
			break
		}
		portCh <- port
	}
	close(portCh)
	wg.Wait()

	result.NotBridge = append(result.NotBridge, others...)
	sort.Ints(result.NotBridge)

	if len(found) == 0 {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		message := fmt.Sprintf("在 %s 上没有找到 bridge-api（探测了 %d 个端口）", spec, result.Probed)
		if list := result.notBridgeText(); list != "" {
			message += fmt.Sprintf("；这些端口上有 HTTP 服务但不是它：%s", list)
		}
		// 这句里点名「另一个版本」不是多嘴：那是这台机器上最常见的情况 ——
		// 仓库根目录的 src/main.ts 只提供 OneBot 通道，没有 /api/v1，
		// 跑着它的时候，插件看到的正是「3100 有服务但不是 bridge-api」。
		message += fmt.Sprintf("。本插件对接的是 bridge-api（node bridge-api/src/main.ts），"+
			"不是根目录那个只走 OneBot 的版本；也可以把 api 直接填成完整地址（例 %s）", defaultAPIBase)
		return result, errors.New(message)
	}
	sort.Ints(found)
	port := found[0]
	result.BaseURL, result.Port = baseURLForPort(port), port
	return result, nil
}
