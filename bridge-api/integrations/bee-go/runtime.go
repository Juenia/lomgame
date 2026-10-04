package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// 场景取值与 bridge-api/src/protocol.ts 的 BRIDGE_SCENES 逐字相同。
// 不在这里另起一套名字（比如 dm / guild）：漂移的代价是
// 「玩家在群里说话，机器人私聊回他」—— 一句错话要查半天。
const (
	scenePrivate = "private"
	sceneGroup   = "group"
	sceneChannel = "channel"
)

const (
	// inboundQueueSize 是等待送进游戏的玩家消息上限。
	inboundQueueSize = 256
	// pendingLimit 是本地待发回执上限。超出会丢最旧的 —— 它对应的场景是
	// 「群里很久没人说话」，那时候留最新的比留最旧的更有用。
	pendingLimit = 512
	// longPollLimit 是一次最多取几条回执。
	longPollLimit = 20
	// pollRetryDelay 是取回执失败后的退避。
	pollRetryDelay = 3 * time.Second
	// idlePollDelay 是关掉长轮询时的退让间隔。
	//
	// 它不是可选优化：wait=0 时服务端会**立刻**返回空，
	// 没有这个退让就是一个打满 CPU、每秒几千次请求的死循环 —— 而配置里写个 0 很容易。
	idlePollDelay = time.Second
	// replyPollInterval 是等回执时的检查粒度。
	replyPollInterval = 20 * time.Millisecond
	// recentSentLimit 是「防自己喂自己」的内容指纹条数。
	recentSentLimit = 32
	// nicknameCacheLimit 是昵称缓存的用户数上限（超出整体清空，避免无界增长）。
	nicknameCacheLimit = 512
	// discoveryBudget 是自动检索的总预算。
	// 按默认范围（201 个端口、并发 32、单个 400ms）最坏约 2.5 秒；
	// 留 10 秒是因为被防火墙 DROP 的端口不会立刻拒绝，而是一直等到超时。
	discoveryBudget = 10 * time.Second
)

// inboundJob 是一条等着送进判定层的玩家消息。
//
// done 用来告诉回调「这条消息的 HTTP 请求有结果了」——
// 失败时回调就没必要再等回执（等下去也等不到，只会白卡 BEE）。
type inboundJob struct {
	scene     string
	sceneID   string
	userID    string
	nickname  string
	text      string
	messageID string
	done      chan error
}

// pendingQueue 是「已经取回来、但还没发出去」的回执。
type pendingQueue struct {
	mu    sync.Mutex
	items []outboundItem
}

func (q *pendingQueue) push(items ...outboundItem) int {
	if len(items) == 0 {
		return 0
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	q.items = append(q.items, items...)
	if len(q.items) <= pendingLimit {
		return 0
	}
	dropped := len(q.items) - pendingLimit
	q.items = q.items[dropped:]
	return dropped
}

func (q *pendingQueue) requeue(items []outboundItem) {
	if len(items) == 0 {
		return
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	merged := make([]outboundItem, 0, len(items)+len(q.items))
	merged = append(merged, items...)
	merged = append(merged, q.items...)
	if len(merged) > pendingLimit {
		merged = merged[len(merged)-pendingLimit:]
	}
	q.items = merged
}

func (q *pendingQueue) len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.items)
}

func (q *pendingQueue) drain() []outboundItem {
	q.mu.Lock()
	defer q.mu.Unlock()
	items := q.items
	q.items = nil
	return items
}

// bridgeRuntime 是插件的运行期状态与后台任务的宿主。
//
// 一条铁律贯穿这个文件：**Bee API 只能在消息回调线程里调用**。
// C 壳只在 send_event 期间读 worker 的命令（见 other/bee_bridge.c 的 service_api_call），
// 所以后台 goroutine 里发的命令会一直躺在管道里没人处理；
// 更糟的是 worker 的主循环与 IPC 客户端共用同一个 bufio.Scanner，
// 后台调用会和主循环抢同一个 reader。
// 因此后台只做 HTTP 与排队，**发送一律安排在回调窗口里**。
type bridgeRuntime struct {
	mu         sync.Mutex
	prepared   bool
	dataDir    string
	cfg        Config
	cfgErr     error
	client     *bridgeClient
	state      *runtimeState
	robotJSON  string
	robotID    string
	nicknames  map[string]string
	recentSent []string

	started bool
	// probing 表示「点设置顺手触发的检索」正在跑，避免连点设置起一堆探测
	probing bool
	// core 是插件自己拉起来的随身内核（没自己拉过就是 nil）
	core *coreRunner
	// appID 缓存 QQ 官方机器人的 AppID —— 构造按钮键盘要用它（BuildKeyboard 的第一个参数）。
	appID string
	// privateAPIMode 记住哪种私聊 API 是通的：0=还没定，1=自适应私信，2=好友消息。
	//
	// 记住它是因为**试错有代价**：失败的调用会让 BEE 弹一个「发送失败」的框，
	// 玩家看得见。所以只在第一次两条都试，之后直接用对的那条。
	privateAPIMode int
	cancel         context.CancelFunc
	wg             sync.WaitGroup
	jobs           chan inboundJob

	pending *pendingQueue
}

func newBridgeRuntime() *bridgeRuntime {
	return &bridgeRuntime{
		cfg:       defaultConfig(),
		state:     newRuntimeState(),
		nicknames: map[string]string{},
		pending:   &pendingQueue{},
	}
}

// prepare 读配置、绑定数据目录。幂等：initialize 与 enable 都会调它。
func (rt *bridgeRuntime) prepare(dataDir string) {
	if dataDir == "" {
		return
	}
	rt.mu.Lock()
	if rt.prepared {
		rt.mu.Unlock()
		return
	}
	rt.prepared = true
	rt.dataDir = dataDir
	rt.mu.Unlock()

	cfg, err := loadConfig(dataDir)
	rt.state.bindDataDir(dataDir)

	rt.mu.Lock()
	rt.cfg = cfg
	rt.cfgErr = err
	// 客户端**不在这里**建：cfg.API 可能是空的（自动检索），
	// 那时候建出来的客户端连地址都没有。由 resolveClient 定下地址后再建。
	rt.mu.Unlock()

	if err != nil {
		rt.state.setError("配置有问题（已按默认值运行）", err)
	}
}

func (rt *bridgeRuntime) configSnapshot() Config {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	return rt.cfg
}

func (rt *bridgeRuntime) clientRef() *bridgeClient {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	return rt.client
}

// start 启动后台任务。重复调用（框架连发两次启用）不会起第二组 goroutine。
func (rt *bridgeRuntime) start(robotJSON string) {
	rt.mu.Lock()
	if rt.started {
		if robotJSON != "" {
			rt.robotJSON = robotJSON
		}
		rt.mu.Unlock()
		return
	}
	rt.started = true
	if robotJSON != "" {
		rt.robotJSON = robotJSON
	}
	jobs := make(chan inboundJob, inboundQueueSize)
	rt.jobs = jobs
	ctx, cancel := context.WithCancel(context.Background())
	rt.cancel = cancel
	rt.mu.Unlock()

	rt.state.begin(time.Now())
	rt.state.clearError()
	rt.diagLog("插件：后台已启动（数据目录 %s）", rt.dataDir)

	rt.wg.Add(1)
	go func() { defer rt.wg.Done(); rt.serve(ctx, jobs) }()
}

// serve 是后台的总入口：先决定连哪个地址，再把三条循环跑起来。
//
// 「先解析地址」这一步就是自动检索落地的地方。它要发 HTTP（最坏几秒），
// 所以必须在后台做 —— 卡在 onEnable 里就是卡住 BEE 的回调线程。
func (rt *bridgeRuntime) serve(ctx context.Context, jobs chan inboundJob) {
	client, err := rt.resolveClient(ctx)
	if err != nil {
		rt.state.setDiscovery("未找到 bridge-api")
		rt.state.setError("没有找到 bridge-api，本插件不会收发任何消息", err)
		return
	}

	var inner sync.WaitGroup
	inner.Add(3)
	go func() { defer inner.Done(); rt.inboundLoop(ctx, jobs, client) }()
	go func() { defer inner.Done(); rt.pollLoop(ctx, client) }()
	go func() { defer inner.Done(); rt.declareCapabilitiesLoop(ctx, client) }()
	inner.Wait()
}

// resolveClient 决定连哪个地址，并建好客户端。
//
// 配置里填了就用填的（跨机部署必须填）；留空则自动检索本机端口。
// 检索结果会写回运行期配置，这样设置窗口显示的是**实际连上的那个**地址。
func (rt *bridgeRuntime) resolveClient(ctx context.Context) (*bridgeClient, error) {
	cfg := rt.configSnapshot()
	if cfg.API != "" {
		rt.state.setDiscovery("使用配置里的地址 " + cfg.API)
		rt.diagLog("地址：使用配置里的 %s", cfg.API)
		requestSettingsRepaint()

		// 顺手验一次指纹。**不改行为** —— 用户填什么就连什么，这是他的选择；
		// 但「填了一个不是 bridge-api 的地址」属于那种什么都不报错、
		// 只是永远不回话的坑，值得在状态和日志里留一句。
		probeCtx, probeCancel := context.WithTimeout(ctx, 2*time.Second)
		outcome := probeEndpoint(probeCtx, cfg.API, 2*time.Second)
		probeCancel()
		switch outcome {
		case probeBridge:
			rt.diagLog("地址：配置的 %s 已确认是 bridge-api", cfg.API)
		case probeOther:
			rt.state.setDiscovery("使用配置里的地址 " + cfg.API + "（但它不提供 /api/v1，可能不是 bridge-api）")
			rt.diagLog("地址：配置的 %s 上有 HTTP 服务，但它不是 bridge-api（GET /api/v1 没有自述）", cfg.API)
		default:
			rt.state.setDiscovery("使用配置里的地址 " + cfg.API + "（暂时连不上）")
			rt.diagLog("地址：配置的 %s 暂时连不上", cfg.API)
		}
		requestSettingsRepaint()

		client := newBridgeClient(cfg)
		rt.setClient(client)
		return client, nil
	}

	// 1) 先看本机是不是已经有 bridge-api 在跑。
	//
	// 手动起的、上一次没退干净的，都直接复用 —— 抢端口和「同一个世界跑出两份进度」
	// 都是这么避免的。这也让「先手动把核心调通，再交给插件」这条路依然走得通。
	rt.state.setDiscovery("正在查找本机的 bridge-api…")
	requestSettingsRepaint()
	scanCtx, scanCancel := context.WithTimeout(ctx, discoveryBudget)
	existing, scanErr := discoverBridgeAPI(scanCtx, cfg.ScanRange, probeTimeout)
	scanCancel()
	if scanErr == nil {
		rt.diagLog("地址：本机已有 bridge-api，直接复用 %s（端口 %d）", existing.BaseURL, existing.Port)
		if list := existing.notBridgeText(); list != "" {
			rt.diagLog("地址：另有端口有 HTTP 服务但不是 bridge-api：%s", list)
		}
		return rt.adopt(existing.BaseURL, existing.Port), nil
	}
	if list := existing.notBridgeText(); list != "" {
		rt.diagLog("地址：扫描时发现这些端口有 HTTP 服务但不是它：%s", list)
	}

	// 2) 本机没有，就把随身内核拉起来
	if !cfg.ManageCore {
		return nil, errors.New("本机没找到 bridge-api，而配置里 manageCore=false（插件不会自己启动内核）。" +
			"要么把它打开，要么自己起：node bridge-api/src/main.ts")
	}
	paths := corePathsFor(rt.dataDirectory())
	rt.state.setDiscovery("本机没有 bridge-api，正在启动随身内核…")
	rt.diagLog("内核：本机没有现成的 bridge-api，开始自备（%s）", paths.root)
	requestSettingsRepaint()

	port, err := rt.startCore(ctx, paths, cfg)
	if err != nil {
		return nil, err
	}
	// 关键：**自己拉起的内核，出站队列是从 seq=1 重新开始的**（它是内存里的），
	// 所以落盘的游标必须跟着归零 —— 否则就是那个"两边都不报错"的死锁：
	// 旧游标比队尾还新，轮询永远返回空，玩家一条回执都收不到。
	//
	// 复用外部内核那条路**不重置**：内核还活着，队列就还在，游标是有效的。
	rt.state.resetCursor()
	rt.diagLog("内核：出站队列随重启归零，游标已重置为 0")
	rt.state.setDiscovery(fmt.Sprintf("内核已启动（端口 %d），正在等它就绪…", port))
	requestSettingsRepaint()

	readyCtx, readyCancel := context.WithTimeout(ctx, coreReadyTimeout)
	readyErr := waitCoreReady(readyCtx, port, coreReadyTimeout)
	readyCancel()
	if readyErr != nil {
		// 内核起不来时它自己会把原因写进 core.log（端口被占、依赖缺失、语法错误），
		// 把最后几行带出去 —— 只说一句「连不上」的话，人得自己翻日志才知道发生了什么
		if tail := readCoreLogTail(rt.dataDirectory(), 12); tail != "" {
			return nil, fmt.Errorf("%w。内核日志（core.log）最后几行：\n%s", readyErr, tail)
		}
		return nil, readyErr
	}
	rt.diagLog("内核：已就绪（端口 %d）", port)
	return rt.adopt(baseURLForPort(port), port), nil
}

// adopt 认下这个地址：建客户端、写回运行期配置、更新状态。
//
// 抽出来是因为有两条路都会走到这里 —— 复用本机已有的、和启动自己的内核 ——
// 而它们后续要做的事一模一样。
func (rt *bridgeRuntime) adopt(baseURL string, port int) *bridgeClient {
	rt.mu.Lock()
	rt.cfg.API = baseURL
	client := newBridgeClient(rt.cfg)
	rt.client = client
	rt.mu.Unlock()
	rt.state.setDiscovery(fmt.Sprintf("已自动找到 %s（端口 %d）", baseURL, port))
	rt.diagLog("地址：采用 %s（端口 %d）", baseURL, port)
	requestSettingsRepaint()
	return client
}

// dataDirectory 返回插件的数据目录（可能为空 —— 初始化没跑成的时候）。
func (rt *bridgeRuntime) dataDirectory() string {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	return rt.dataDir
}

func (rt *bridgeRuntime) setClient(client *bridgeClient) {
	rt.mu.Lock()
	rt.client = client
	rt.mu.Unlock()
}

// stop 取消后台任务并等它们真正退出。
//
// 长轮询正挂在服务端上时，context 取消会让它立刻返回，所以这里不会等满 wait 秒。
func (rt *bridgeRuntime) stop() {
	rt.mu.Lock()
	if !rt.started {
		rt.mu.Unlock()
		return
	}
	rt.started = false
	cancel := rt.cancel
	rt.cancel = nil
	rt.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	rt.wg.Wait()
	// 后台都停了再收内核：pollLoop 可能正挂在它身上做长轮询
	rt.stopCore()
}

// declareCapabilitiesLoop 声明这条通道的能力，失败重试两次。
//
// 失败**不是**致命的（服务端会用缺省档），但值得记一笔：缺省档以为上游能发图，
// 而本插件在 base64 图片模式下发不出图 —— 玩家会收到一条他永远看不到的消息。
func (rt *bridgeRuntime) declareCapabilitiesLoop(ctx context.Context, client *bridgeClient) {
	cfg := rt.configSnapshot()
	for attempt := 0; attempt < 3; attempt++ {
		callCtx, cancel := timeoutContext(ctx, 0)
		err := client.declareCapabilities(callCtx, cfg.Images, cfg.Buttons, cfg.RichText)
		cancel()
		if err == nil {
			return
		}
		if ctx.Err() != nil {
			return
		}
		rt.state.setError("声明通道能力失败（判定层会用缺省档：能发图、不摆按钮）", err)
		if !sleepCtx(ctx, time.Second) {
			return
		}
	}
}

func (rt *bridgeRuntime) inboundLoop(ctx context.Context, jobs chan inboundJob, client *bridgeClient) {
	for {
		select {
		case <-ctx.Done():
			return
		case job := <-jobs:
			err := rt.sendInbound(ctx, client, job)
			rt.state.noteInbound(err == nil)
			if err != nil && ctx.Err() == nil {
				rt.state.setError("消息没能送进游戏", err)
			}
			if job.done != nil {
				select {
				case job.done <- err:
				default:
				}
			}
		}
	}
}

func (rt *bridgeRuntime) sendInbound(ctx context.Context, client *bridgeClient, job inboundJob) error {
	if client == nil {
		return errors.New("插件尚未初始化（没有解析出服务端地址）")
	}
	callCtx, cancel := timeoutContext(ctx, 0)
	defer cancel()
	return client.inbound(callCtx, inboundPayload{
		Scene:     job.scene,
		SceneID:   job.sceneID,
		UserID:    job.userID,
		Nickname:  job.nickname,
		Text:      job.text,
		MessageID: job.messageID,
	})
}

// pollLoop 持续取回执，取到就放进待发队列，等下一个回调窗口发出去。
//
// 用长轮询而不是定时短轮询：世界播报这类主动推送要尽可能及时，
// 而长轮询在有数据时会被服务端立刻唤醒，没数据时不占带宽。
func (rt *bridgeRuntime) pollLoop(ctx context.Context, client *bridgeClient) {
	cursor := rt.state.cursorValue()
	for {
		if ctx.Err() != nil {
			return
		}
		waitSec := rt.configSnapshot().LongPollSec
		callCtx, cancel := timeoutContext(ctx, waitSec)
		response, err := client.outbound(callCtx, cursor, waitSec, longPollLimit)
		cancel()
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			rt.state.setError("取回执失败，稍后重试", err)
			if !sleepCtx(ctx, pollRetryDelay) {
				return
			}
			continue
		}
		rt.state.markPoll()
		if response.Gap {
			rt.state.noteGap(response.Earliest)
		}
		if response.Cursor != cursor {
			cursor = response.Cursor
			rt.state.setCursor(cursor)
		}
		if dropped := rt.pending.push(response.Items...); dropped > 0 {
			// 本地队列溢出 = 很久没有回调窗口（群里一直没人说话）。
			// 这不常见，但发生了要能看见 —— 丢的是回执，不是日志。
			rt.state.setError(fmt.Sprintf("本地待发队列已满，丢弃了 %d 条最旧的回执", dropped), nil)
		}
		if waitSec <= 0 && len(response.Items) == 0 {
			if !sleepCtx(ctx, idlePollDelay) {
				return
			}
		}
	}
}

// handleInbound 处理一条消息回调。
//
// 它必须在**回调线程**里同步跑完：C 壳在等 event_result，其间才读得到我们发的 API 命令。
func (rt *bridgeRuntime) handleInbound(robotJSON, scene, sceneID, targetID, userID, message, messageID string) {
	rt.setRobotJSON(robotJSON)
	cfg := rt.configSnapshot()
	// 每次回调都留一行。这一行是**唯一**能区分「回调没进来」和
	//「进来了但卡在后面」的东西 —— 排一次「消息没有回执」的故障时，
	// 没有它就只能靠猜。
	rt.diagLog("回调：%s %s（%d 字）", scene, userID, len([]rune(message)))
	if cfg.DebugRawCallbacks {
		rt.debugLog(robotJSON, scene, sceneID, userID, message, messageID)
	}

	// 空消息（图片/表情）与机器人自己发的消息都不是玩家输入，
	// 但它们**仍然是回调窗口** —— 顺手把积压的回执发掉，别浪费一次调用 Bee API 的机会。
	if strings.TrimSpace(message) == "" || rt.isSelfMessage(robotJSON, userID, message) {
		rt.flush(robotJSON, scene, targetID)
		return
	}

	job := inboundJob{
		scene:     scene,
		sceneID:   sceneID,
		userID:    userID,
		nickname:  rt.nicknameFor(robotJSON, userID),
		text:      message,
		messageID: messageID,
		done:      make(chan error, 1),
	}

	// 先发掉之前积压的回执，再送这条消息。
	rt.flush(robotJSON, scene, targetID)

	rt.mu.Lock()
	jobs := rt.jobs
	rt.mu.Unlock()
	if jobs == nil {
		return
	}
	select {
	case jobs <- job:
	default:
		// 队列满 = 服务端已经跟不上，或者有人在刷屏。
		// 丢这一条并记日志：**阻塞回调**比丢一条消息严重得多，它会把 BEE 框架一起拖住。
		rt.state.setError("入站队列已满，丢弃了一条玩家消息", nil)
		return
	}

	rt.awaitReplies(job)
	rt.flush(robotJSON, scene, targetID)
}

// awaitReplies 给这条消息的回执留一点时间，让它赶上这个回调窗口。
//
// 为什么值得等：BEE 这类框架里，插件**只有在回调期间**才发得出消息
// （见 bridgeRuntime 的说明）。不等的话，玩家的回执要等到群里下一个人说话
// 才会被发出去 —— 那是一条永远迟到的回复。
//
// 为什么必须有上限：这个等待直接等于「BEE 处理一条群消息时被卡住多久」。
// 超时就放行，回执留在队列里等下一个窗口。
func (rt *bridgeRuntime) awaitReplies(job inboundJob) {
	budget := time.Duration(rt.configSnapshot().WaitMs) * time.Millisecond
	if budget <= 0 {
		return
	}
	deadline := time.Now().Add(budget)
	select {
	case err := <-job.done:
		if err != nil {
			// 消息根本没送进去，等下去也不会有回执
			return
		}
	case <-time.After(time.Until(deadline)):
		return
	}
	for time.Now().Before(deadline) {
		if rt.pending.len() > 0 {
			return
		}
		time.Sleep(replyPollInterval)
	}
}

// flush 把待发队列里的回执发出去。只能在回调线程里调用。
// mergeOutbound 把同一批回执并成**一条**消息。
//
// 判定层的一次回复天然分成几块：信息头 + 正文、一张角色卡图、一组选项。
// 它们是**同一次回复**的三个部分，玩家那边应该是**一条消息** ——
// 分开发的样子是「图一条、字一条」，玩家得往下翻才看得到正文，
// 而正文里的数字菜单又和图片隔了一屏。
//
// 合并规则刻意保守（宁可少合，也不要把两条不相干的回复揉在一起）：
//
//	· 只有**同一场景、同一目标**的才合 —— 世界播报和某个群的回执不会串台；
//	· 信息头取第一条（一条回复只有一个说话人）；
//	· 正文按原顺序拼接，用的是**原始文本**而不是渲染结果 ——
//	  渲染会把信息头和选项加进去，拿渲染结果去拼会重复一遍；
//	· 图片取**第一张** —— QQ 一条消息只显示一张，多出来的只能丢；
//	· 选项按 id 去重后合并。
func mergeOutbound(items []outboundItem) []outboundItem {
	if len(items) < 2 {
		return items
	}
	merged := make([]outboundItem, 0, len(items))
	at := map[string]int{}
	seenSeq := map[int64]bool{}
	for _, item := range items {
		// 同一条回执被重复投递时只算一次。
		//
		// 服务端在游标没推进时会重复给同一批（发送失败后的重试积压、
		// 或者上游没来得及推进游标），不去重的话合并会把同一段正文拼很多遍 ——
		// 这个 bug 是被 runtime_test 里那条「服务端固定返回 seq=1」的用例抓到的：
		// 正文变成了同一句话 ×150。
		if item.Seq > 0 {
			if seenSeq[item.Seq] {
				continue
			}
			seenSeq[item.Seq] = true
		}
		key := item.Scene + "\x00" + item.TargetID
		index, ok := at[key]
		if !ok {
			merged = append(merged, item)
			at[key] = len(merged) - 1
			continue
		}
		target := &merged[index]
		if text := strings.TrimSpace(item.Text); text != "" {
			if strings.TrimSpace(target.Text) == "" {
				target.Text = item.Text
			} else {
				target.Text = strings.TrimRight(target.Text, "\n") + "\n" + item.Text
			}
		}
		if target.Image == nil && item.Image != nil {
			target.Image = item.Image
		}
		if target.Header == nil {
			target.Header = item.Header
		}
		if len(item.Options) > 0 {
			seen := map[string]bool{}
			for _, existing := range target.Options {
				seen[existing.ID] = true
			}
			for _, option := range item.Options {
				if seen[option.ID] {
					continue
				}
				target.Options = append(target.Options, option)
				seen[option.ID] = true
			}
			if target.Kind == "text" && item.Kind != "" {
				target.Kind = item.Kind
			}
		}
		if len(item.QuickButtons) > 0 {
			target.QuickButtons = append(target.QuickButtons, item.QuickButtons...)
		}
		// 序号保留**最后一条**：合并后的这一条要按序号"记住已发"，
		// 而记忆是按序号去重的，留最新的那条才不会让后续批次重复发。
		target.Seq = item.Seq
	}
	return merged
}

func (rt *bridgeRuntime) flush(robotJSON, currentScene, currentTarget string) {
	items := rt.pending.drain()
	if len(items) == 0 {
		return
	}
	// 判定层的一次回复在这里是好几条回执（信息头/正文、角色卡图、选项），
	// 而玩家那边看到的应该是**一条消息** —— 分开发就成了"图一条、字一条"。
	items = mergeOutbound(items)
	api, err := NewBeeAPI(robotJSON)
	if err != nil {
		rt.pending.requeue(items)
		rt.state.setError("创建 BeeAPI 失败，回执留到下次回调再发", err)
		return
	}
	cfg := rt.configSnapshot()
	for _, item := range items {
		if err := rt.deliver(api, cfg, item, currentScene, currentTarget); err != nil {
			rt.state.noteDelivered(false)
			// 单条发不出去不打断整批：后面还有别的群要发，一条失败不该连坐
			rt.state.setError(fmt.Sprintf("发送回执失败（seq=%d 到 %s）", item.Seq, item.TargetID), err)
			continue
		}
		rt.state.noteDelivered(true)
		rt.rememberSent(item)
		withImage := ""
		if item.Image != nil && cfg.Images {
			withImage = "（带图）"
		}
		rt.diagLog("已投递：seq=%d → %s/%s%s", item.Seq, item.Scene, item.TargetID, withImage)
	}
}

func (rt *bridgeRuntime) deliver(api *BeeAPI, cfg Config, item outboundItem, currentScene, currentTarget string) error {
	text := renderOutboundText(item)
	// 信息头拼在正文最前面。判定层用 Header == nil 表示「这条不要信息头」（角色卡）。
	if block := renderHeaderBlock(item); block != "" {
		if strings.TrimSpace(text) == "" {
			text = block
		} else {
			text = block + "\n\n" + text
		}
	}
	image, cleanup := rt.resolveImage(item, cfg)
	if cleanup != nil {
		defer cleanup()
	}
	if image == "" && text == "" && item.Image != nil {
		// 图发不出去、正文又是空的：至少把链接给玩家，否则他什么都看不到
		text = strings.TrimSpace(item.Image.URL)
	}
	if text == "" && image == "" {
		return nil
	}

	// 被动回复优先：它借用当前这条消息的 msg_id，不吃主动消息的频率与次数限制。
	// 只有目标与当前会话不一致时（世界播报、或上一个群积压的回执）才用主动消息。
	passive := item.Scene == currentScene && item.TargetID == currentTarget

	send := func(withImage string) error {
		switch item.Scene {
		case sceneGroup:
			_, err := api.ctx.SendGroupMessage(item.TargetID, text, withImage, false, !passive)
			return err
		case scenePrivate:
			return rt.sendPrivate(api, item.TargetID, text, withImage, !passive)
		case sceneChannel:
			_, err := api.ctx.SendChannelMessage(item.TargetID, text, withImage, false, !passive)
			return err
		default:
			return fmt.Errorf("未知场景 %q（协议里只有 private/group/channel）", item.Scene)
		}
	}

	// ⚠️ 这里**故意不再把图上传图床、写成 markdown 图片**。
	//
	// 试过了，真机上是**破图框** —— 和 src/adapter/qq-official/index.ts:1299 记的
	// 那次一模一样（「图确实画了、url 也拿到了、markdown 也发出去了 200，
	// 但 QQ 客户端里是一个破图框」）。那行注释就是结论：外链在真机上不可靠。
	//
	// 所以图片走**附件**那条路（本地文件直接交给 BEE，平台自己转存，显示正常），
	// 正文 + 按钮走 markdown —— **两条消息**。QQ 官方通道里没有
	// 「图 + markdown 正文 + keyboard」同一条的形态：
	//   · msg_type:7 有图、正文是纯文本、也没有 keyboard；
	//   · msg_type:2 有正文和 keyboard、没有图片字段。
	//
	// 先把图单独发出去，再把正文清空 —— 否则下面那两步会把同一段正文发两遍。
	if image != "" && text != "" {
		withText := text
		text = ""
		err := send(image)
		text = withText
		if err != nil {
			return err // 图发不出去不要吞掉，让调用方按失败处理
		}
		image = ""
	}

	// 只在配置明确要求（richText: true）时才用 markdown 发。
	//
	// 默认是关的：能不能渲染 markdown 取决于平台侧有没有给这个机器人开通
	// 「原生 Markdown」，而那是**本地问不出来**的 —— 没开通时，官方会把
	// markdown.content 当纯文本原样显示，玩家看到的就是 $\textcolor{…}$ 源码。
	//
	// 图片与 markdown 互斥（官方的 markdown 消息里图片是一行，而 BEE 的
	// 图片参数走的是另一条路），所以有图时直接走普通消息。
	if cfg.RichText && image == "" {
		if err := rt.sendAsMarkdown(api, item, text, !passive); err == nil {
			return nil
		} else {
			rt.diagLog("markdown 发送失败（%v），改用普通文本（seq=%d）", err, item.Seq)
		}
	}

	err := send(image)
	if err == nil || image == "" {
		return err
	}
	// 带图失败就退化成纯文字重发一次。
	//
	// 这一步不是可有可无的：发图失败的原因五花八门（路径不被接受、图片太大、
	// 框架的图片通道没开），而玩家那边看到的是**什么都没有** ——
	// 一条角色卡直接消失，比一张没出来的图难查得多。
	rt.diagLog("图片发送失败（%v），退化成纯文字重发（seq=%d）", err, item.Seq)
	return send("")
}

// renderHeaderBlock 把信息头渲染成 markdown 的一小段。
//
// ## 真正的信息头是一张图，这里为什么退回文字
//
// 判定层给的是三个字段（昵称 / 途径 / 地点 + 头像直链），而**通道要画的**是
// src/card/header.ts 那张自绘 PNG（620x116：圆形头像 + 昵称 + 性别符号 + 地点）。
// 那张图要嵌进 markdown 就得先上传拿公网直链 —— 于是卡在同一个地方：
//
//	· Go 侧没有 HTML 渲染，画不出那张图；
//	· 就算画得出，BEE 的上传走的是公共图床，直链在真机上**会破图**
//	  （docs/M2.47、docs/M2.86 都记了这件事，本插件也实测撞过一次）。
//	  官方适配器用的是 #uploadMedia（平台自己的富媒体上传），URL 天然在白名单里，
//	  BEE 没有等价接口。
//
// 所以走**文字头** —— 这不是我发明的降级，而是官方适配器自己的那一条：
// src/adapter/qq-official/index.ts:1537 写着「任一环节失败都只是退回文字头 ——
// 信息条是增强，不是正文」。
//
// 角色卡不带信息头（判定层用 noHeader 标出来），这条判断交给 Header == nil。
func renderHeaderBlock(item outboundItem) string {
	if item.Header == nil {
		return ""
	}
	header := item.Header
	name := strings.TrimSpace(header.Nickname)
	if name == "" {
		return ""
	}
	line := name
	if tag := strings.TrimSpace(header.GenderTag); tag != "" {
		line += " " + tag
	}
	if pathway := strings.TrimSpace(header.PathwayLine); pathway != "" {
		line += " · " + pathway
	}
	// 头像用通道自己的直链模板（q.qlogo.cn 是 QQ 官方域名，不是第三方图床）。
	// 拿不到就只出文字 —— 少一个头像，比一个破图框好。
	avatar := strings.TrimSpace(header.AvatarURL)
	if avatar != "" {
		line = "![](" + avatar + ") " + line
	}
	if location := strings.TrimSpace(header.LocationName); location != "" {
		line += "\n◆ " + location
	}
	return line
}

// markdownImageURL 把一个本地图片变成能嵌进 markdown 的公网直链。
//
// ## 为什么非要这一步
//
// QQ 官方那边「图片」和「markdown 正文」是**互斥**的两条路：
//
//	· msg_type:7（富媒体）能带图，但正文是纯文本 —— 于是卡面上去了，
//	  正文里的 ** 星号和 $\textcolor{}$ 全变成源码（就是「图 + 富文本源码」那个现象）；
//	· msg_type:2（markdown）能渲染正文和按钮，但没有图片字段。
//
// 唯一能同时拿到的是**把图写成 markdown 图片**——markdown 里图片本来就是一行。
// 而它要求一个公网直链，所以先把本地文件交给 BEE 的上传接口（op 45 取某人头像之外，
// 这一条是「上传图片到图床」），拿回直链再拼进正文。
//
// ## 失败怎么办
//
// 上传失败就返回空串，调用方退回「图 + 纯文本」那条老路 —— 至少图还在，
// 正文可读，只是没有彩色。不会出现「图没了、正文还是源码」这种最差组合。
func (rt *bridgeRuntime) markdownImageURL(api *BeeAPI, image string) string {
	if strings.HasPrefix(image, "http://") || strings.HasPrefix(image, "https://") {
		return image // 已经是直链（游戏机上 BRIDGE_IMAGE_MODE=url 的情况）
	}
	url, err := api.ctx.UploadImage(image)
	if err != nil {
		rt.diagLog("图片：上传图床失败（%v），退回「图 + 纯文本」", err)
		return ""
	}
	url = strings.TrimSpace(url)
	if url == "" {
		rt.diagLog("图片：上传返回空，退回「图 + 纯文本」")
		return ""
	}
	rt.diagLog("图片：已上传，嵌进 markdown 正文")
	return url
}

// sendAsMarkdown 用 markdown 消息类型发一条。
//
// BEE 就是 QQ 官方机器人框架 —— 而 QQ 官方**只有 markdown 消息**里的
// LaTeX 彩色与粗体才会被渲染。内核生成的正文本来就带这些标记
// （见 src/adapter/highlight.ts），走普通文本字段发等于把源码丢给玩家看。
//
// MarkdownMessage.Native 是"原生 markdown 内容"那一栏，模板那几个字段留空 ——
// 内核出的是自由 markdown，不是官方的模板消息。
func (rt *bridgeRuntime) sendAsMarkdown(api *BeeAPI, item outboundItem, text string, active bool) error {
	// markdown 与按钮是**同一条消息**的两半：KeyboardJSON 就在 MarkdownMessage 上
	//（见 bee_sdk.go 的 markdownArgs）—— 所以"精美 MD + 按钮"不需要发两条。
	message := MarkdownMessage{Native: text, KeyboardJSON: rt.keyboardFor(api, item)}
	switch item.Scene {
	case sceneGroup:
		_, err := api.ctx.SendGroupMarkdown(item.TargetID, message, active)
		return err
	case scenePrivate:
		_, err := api.ctx.SendFriendMarkdown(item.TargetID, message, active, false)
		return err
	case sceneChannel:
		_, err := api.ctx.SendChannelMarkdown(item.TargetID, message, active)
		return err
	default:
		return fmt.Errorf("未知场景 %q", item.Scene)
	}
}

// avatarTemplate 拼出这个通道的头像直链模板。
//
// 形状来自 src/adapter/qq-official/index.ts:1331（那行注释记的是用户核对过的
// API 形状）：https://q.qlogo.cn/qqapp/<appid>/<openid>/<size>
//
// 为什么必须由上游给：判定层只产出 avatarUserId（就是 openid），
// 而「这个人在你这条通道上长什么样」只有上游知道 —— 服务端拿 {userId} 往模板里填。
// 不填这个模板，服务端拼不出头像，判定层就不画信息头（card.ts 会附一行
// 「没拿到你的 QQ 头像，卡面用的是名字首字纹章」）。
func (rt *bridgeRuntime) avatarTemplate() string {
	appID := rt.botAppIDValue()
	if appID == "" {
		return ""
	}
	return "https://q.qlogo.cn/qqapp/" + appID + "/{userId}/{size}"
}

// setBotAppID 在启用时取一次 AppID 并记下来（取不到就留空，各处功能自己降级）。
func (rt *bridgeRuntime) setBotAppID(api *BeeAPI) {
	value, err := api.ctx.GetRobotAppID()
	if err != nil {
		rt.diagLog("AppID：取不到（%v）—— 头像与按钮都会降级", err)
		return
	}
	value = strings.TrimSpace(value)
	if value == "" {
		rt.diagLog("AppID：框架返回空 —— 头像与按钮都会降级")
		return
	}
	rt.mu.Lock()
	rt.appID = value
	rt.mu.Unlock()
	rt.diagLog("AppID：%s（头像模板与按钮键盘都用它）", value)
}

// botAppIDValue 读缓存的 AppID。
func (rt *bridgeRuntime) botAppIDValue() string {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	return rt.appID
}

// botAppID 懒加载并缓存 QQ 官方机器人的 AppID。
//
// 只有构造按钮键盘时才需要它（BuildKeyboard 的第一个参数）。
// 缓存在这里、而不是插件启用时去取，有两个原因：
//
//	· 那一次调用如果失败，不该影响插件启用；
//	· 绝大多数消息根本没有按钮，没必要为它付一次 IPC。
func (rt *bridgeRuntime) botAppID(api *BeeAPI) string {
	rt.mu.Lock()
	cached := rt.appID
	rt.mu.Unlock()
	if cached != "" {
		return cached
	}
	value, err := api.ctx.GetRobotAppID()
	if err != nil {
		return ""
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	rt.mu.Lock()
	rt.appID = value
	rt.mu.Unlock()
	rt.diagLog("按钮：拿到 AppID=%s", value)
	return value
}

// buttonsPerRow 是每行摆几个按钮。
//
// 平台的硬限制是 1—5 个，但排满 5 个时文字会被截成「休…」——真机截图里
// 五个选项挤成一排、每个只剩七十来像素。项目那边同样收窄到 3
// （src/adapter/official.ts 的 BUTTON.maxPerRow），照它来。
const buttonsPerRow = 3

// clipButtonLabel 按平台的按钮宽度限制截断文字。
//
// render_data.label 的上限是 10 个字符，而一行 3 个时实际放得下 8 个汉字左右。
// 不截断的话平台自己会截（真机上显示成「看…」「休…」），玩家看不出那是什么选项 ——
// 与其让它截在随机位置，不如我这边先截好、带上省略号。
func clipButtonLabel(text string) string {
	const limit = 8
	runes := []rune(strings.TrimSpace(text))
	if len(runes) <= limit {
		return string(runes)
	}
	return string(runes[:limit-1]) + "…"
}

// keyboardFor 把回执里的选项变成 BEE 的键盘 JSON。
//
// 按钮点击后走的是**玩家发了一条消息**那条路（Type=0，data 就是选项 id），
// 所以判定层的数字回复逻辑原封不动就能用 —— 按钮和手打数字是同一个入口，
// 不会出现"按钮一套语义、数字一套语义"。
//
// 拿不到 AppID、选项为空、或者构造失败，都返回空串：那一条就只发文字，
// 判定层在 buttons=false 时本来也会把选项拼进正文。
func (rt *bridgeRuntime) keyboardFor(api *BeeAPI, item outboundItem) string {
	cfg := rt.configSnapshot()
	if !cfg.Buttons || len(item.Options) == 0 {
		return ""
	}
	appID := rt.botAppID(api)
	if appID == "" {
		return ""
	}
	row := make([]Button, 0, len(item.Options))
	for _, option := range item.Options {
		if option.Disabled != nil && *option.Disabled {
			continue // 不可选的选项不摆按钮，但正文里还留着（玩家看得到"为什么不能点"）
		}
		label := clipButtonLabel(option.Label)
		row = append(row, Button{
			Label:        label,
			VisitedLabel: label,
			Style:        1, // 1 = 蓝线框
			// Type=2 是**指令按钮**：点击后把 data 插进输入框（Enter=true 时直接发）。
			// 不是 0（跳转）——那会渲染成一个带链接图标的按钮，点了打开网页；
			// 也不是 1（回调按钮）——那要求平台推 INTERACTION_CREATE 且后台必须回应，
			// 否则客户端一直转圈（见 docs/M2.44-QQ能力扩展.md）。
			Type: 2,
			// Permission=2 是**所有人**。字段表：0 指定用户 / 1 管理员 / 2 所有人；
			// 填 0 又不给 user_ids，结果是按钮摆出来了但谁点都提示"无权限操作"。
			Permission: 2,
			Data:       option.ID,
			// Enter=true：点了直接发出去，玩家不用再按一次发送
			Enter: true,
			// 官方不支持"点了没反应"，必须给一句为什么
			UnsupportTips: "这个按钮暂时不可用",
		})
	}
	if len(row) == 0 {
		return ""
	}
	// 一行 3 个。平台的硬限制是每行 1—5 个、最多 5 行，但排满 5 个在手机上
	// 每个按钮只剩七十来像素，文字会被截成「休…」—— 项目那边也是收到 3
	//（见 src/adapter/official.ts 的 BUTTON.maxPerRow）。
	rows := make([][]Button, 0, 1)
	for len(row) > 0 && len(rows) < 5 {
		take := len(row)
		if take > buttonsPerRow {
			take = buttonsPerRow
		}
		rows = append(rows, row[:take])
		row = row[take:]
	}
	built, err := BuildKeyboard(appID, rows)
	if err != nil {
		rt.diagLog("按钮：构造键盘失败（%v），这一条只有文字", err)
		return ""
	}
	return built
}

// resolveImage 把回执里的图变成 BEE 发得出去的东西。
//
// 两种形态都要认：
//
//	· URL —— 直接用（游戏机上 BRIDGE_IMAGE_MODE=url 或 both 时才有）
//	· base64 —— 落到临时文件、用本地路径发（**这是默认模式**，所以这条路必须通）
//
// 返回的 cleanup 在发送之后删掉临时文件：它们躺在 plugin_data 里，
// 不删的话每出一张角色卡就多一个文件，几个月后就是几十万张小图。
func (rt *bridgeRuntime) resolveImage(item outboundItem, cfg Config) (string, func()) {
	if !cfg.Images || item.Image == nil {
		return "", nil
	}
	if url := strings.TrimSpace(item.Image.URL); url != "" {
		return url, nil
	}
	encoded := strings.TrimSpace(item.Image.Base64)
	if encoded == "" {
		return "", nil
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		rt.diagLog("图片：base64 解不开（%v），这一条只发文字", err)
		return "", nil
	}
	dir := filepath.Join(rt.dataDirectory(), "images")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		rt.diagLog("图片：建目录失败（%v），这一条只发文字", err)
		return "", nil
	}
	path := filepath.Join(dir, fmt.Sprintf("%d%s", item.Seq, extensionForMediaType(item.Image.MediaType)))
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		rt.diagLog("图片：落盘失败（%v），这一条只发文字", err)
		return "", nil
	}
	return path, func() { _ = os.Remove(path) }
}

// extensionForMediaType 给临时文件起个带后缀的名字。
//
// 后缀不是摆设：框架要靠它判断这是不是图片，写 .bin 它多半不认识。
func extensionForMediaType(mediaType string) string {
	switch strings.ToLower(strings.TrimSpace(mediaType)) {
	case "image/jpeg", "image/jpg":
		return ".jpg"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	default:
		return ".png"
	}
}

// diagLog 把一条诊断写进 bridge-debug.log。
//
// 它和 debugLog（回调的原始参数）共用同一个文件，但**不受 debugRawCallbacks 开关控制**：
// 写在这里的都是「出问题时非看不可」的事件 —— 地址是自动检索来的还是配的、
// 检索停在哪一步、设置窗口有没有建出来。
// 这一类恰好都是「不会报错、只会表现成别的东西」的，所以不能等用户先打开开关。
func (rt *bridgeRuntime) diagLog(format string, args ...any) {
	rt.mu.Lock()
	dir := rt.dataDir
	rt.mu.Unlock()
	if dir == "" {
		return
	}
	line := time.Now().Format("2006-01-02 15:04:05") + "\t" + fmt.Sprintf(format, args...) + "\n"
	file, err := os.OpenFile(filepath.Join(dir, debugFileName), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer file.Close()
	_, _ = file.WriteString(line)
}

// probeOnce 保证「地址解析」至少跑过一次，并把结果写进状态。
//
// 为什么点设置也要触发它：用户打开窗口想知道的头一件事就是「它连的是哪个地址」。
// 而插件**没启用**时后台根本没跑过，窗口只能显示「尚未检索」—— 那看着像插件坏了。
// 所以点设置就顺手探一次（只探地址，不启动收发循环）。
func (rt *bridgeRuntime) probeOnce() {
	rt.mu.Lock()
	if !rt.prepared || rt.probing || rt.client != nil || rt.started {
		rt.mu.Unlock()
		return
	}
	rt.probing = true
	rt.mu.Unlock()

	go func() {
		defer func() {
			rt.mu.Lock()
			rt.probing = false
			rt.mu.Unlock()
		}()
		ctx, cancel := context.WithTimeout(context.Background(), discoveryBudget)
		defer cancel()
		if _, err := rt.resolveClient(ctx); err != nil {
			rt.state.setDiscovery("未找到 bridge-api")
			rt.state.setError("打开设置时顺手检索了一次，没找到 bridge-api", err)
			requestSettingsRepaint()
		}
	}()
}

// sendPrivate 发一条私聊。
//
// 私聊在 QQ 上有好几种形态：真正的好友、群临时会话、频道私信 ——
// 而 BEE 的「发送好友消息」只覆盖第一种。用群临时会话进来的人走它会直接失败，
// 框架弹一句「好友消息发送失败」，插件这侧只拿到一个错误码 ——
// 两种原因（发不出去 / 内容不对）长得一模一样，很难分。
//
// 所以两条路都留着，并且**记住哪条通**。试错是有代价的（失败会让框架弹框），
// 不能每条消息都试一遍。
func (rt *bridgeRuntime) sendPrivate(api *BeeAPI, target, text, image string, active bool) error {
	rt.mu.Lock()
	mode := rt.privateAPIMode
	rt.mu.Unlock()

	tryAdaptive := func() error {
		_, err := api.ctx.SendAdaptivePrivateMessage(target, text, image, false, active)
		return err
	}
	tryFriend := func() error {
		_, err := api.ctx.SendFriendMessage(target, text, image, false, active, false)
		return err
	}

	// 已经知道哪条通了，就先走它
	switch mode {
	case privateAPISelfAdaptive:
		if err := tryAdaptive(); err == nil {
			return nil
		}
	case privateAPIFriend:
		if err := tryFriend(); err == nil {
			return nil
		}
	}

	// 还没定下来（或上次通的那条这次不通了）：两条都试
	errAdaptive := tryAdaptive()
	if errAdaptive == nil {
		rt.rememberPrivateAPI(privateAPISelfAdaptive, mode)
		return nil
	}
	errFriend := tryFriend()
	if errFriend == nil {
		rt.rememberPrivateAPI(privateAPIFriend, mode)
		return nil
	}
	rt.mu.Lock()
	rt.privateAPIMode = 0
	rt.mu.Unlock()
	return fmt.Errorf("两种私聊 API 都失败：自适应私信=%v；好友消息=%v", errAdaptive, errFriend)
}

const (
	privateAPISelfAdaptive = 1
	privateAPIFriend       = 2
)

func (rt *bridgeRuntime) rememberPrivateAPI(mode, previous int) {
	rt.mu.Lock()
	rt.privateAPIMode = mode
	rt.mu.Unlock()
	if previous != mode {
		name := "好友消息"
		if mode == privateAPISelfAdaptive {
			name = "自适应私信"
		}
		rt.diagLog("私聊：改用「%s」发送（另一种在这个框架上不通）", name)
	}
}

func (rt *bridgeRuntime) setRobotJSON(value string) {
	if value == "" {
		return
	}
	rt.mu.Lock()
	rt.robotJSON = value
	rt.mu.Unlock()
}

// robotIDFor 取机器人自己的 QQ 号，取不到就返回空串。
//
// 先看机器人上下文里的 robot_id（零成本），再退回 31 号 API，结果缓存。
func (rt *bridgeRuntime) robotIDFor(robotJSON string) string {
	rt.mu.Lock()
	cached := rt.robotID
	rt.mu.Unlock()
	if cached != "" {
		return cached
	}
	if ctx, err := ParseRobotContext(robotJSON); err == nil && ctx.RobotID != "" {
		rt.mu.Lock()
		rt.robotID = ctx.RobotID
		rt.mu.Unlock()
		return ctx.RobotID
	}
	if api, err := NewBeeAPI(robotJSON); err == nil {
		if id, err := api.ctx.GetRobotID(); err == nil {
			if id = strings.TrimSpace(id); id != "" {
				rt.mu.Lock()
				rt.robotID = id
				rt.mu.Unlock()
				return id
			}
		}
	}
	return ""
}

// isSelfMessage 判断这条消息是不是机器人自己刚发出去的。
//
// 这道防线不是可选的：机器人发出的每条回执都会被框架再上报一次回调，
// 不过滤就会「回执 -> 回调 -> 送进判定层 -> 又产生回执」地一直转下去。
//
// 主判据是 robotID。它拿不到时退回**内容指纹**（只认与最近发出的正文完全相同的消息）——
// 那是一个很窄的判据，误伤概率低，但它挡的是死循环，值得留着。
func (rt *bridgeRuntime) isSelfMessage(robotJSON, userID, message string) bool {
	if userID != "" {
		if id := rt.robotIDFor(robotJSON); id != "" {
			return userID == id
		}
	}
	return rt.sentRecently(message)
}

func (rt *bridgeRuntime) sentRecently(text string) bool {
	if text == "" {
		return false
	}
	rt.mu.Lock()
	defer rt.mu.Unlock()
	for _, sent := range rt.recentSent {
		if sent == text {
			return true
		}
	}
	return false
}

func (rt *bridgeRuntime) rememberSent(item outboundItem) {
	text := renderOutboundText(item)
	if text == "" {
		return
	}
	rt.mu.Lock()
	defer rt.mu.Unlock()
	rt.recentSent = append(rt.recentSent, text)
	if len(rt.recentSent) > recentSentLimit {
		rt.recentSent = rt.recentSent[len(rt.recentSent)-recentSentLimit:]
	}
}

// nicknameFor 取发送人昵称，按用户缓存。
//
// 昵称只是显示名，协议里缺省会用 userId，所以**任何失败都只是少一个好看的名字**，
// 不该影响这条消息送进游戏。
func (rt *bridgeRuntime) nicknameFor(robotJSON, userID string) string {
	if userID == "" || !rt.configSnapshot().FetchNickname {
		return ""
	}
	rt.mu.Lock()
	if name, ok := rt.nicknames[userID]; ok {
		rt.mu.Unlock()
		return name
	}
	rt.mu.Unlock()

	api, err := NewBeeAPI(robotJSON)
	if err != nil {
		return ""
	}
	name, err := api.ctx.GetUserNickname(userID)
	if err != nil {
		return ""
	}
	name = strings.TrimSpace(name)
	rt.mu.Lock()
	if len(rt.nicknames) >= nicknameCacheLimit {
		rt.nicknames = map[string]string{}
	}
	rt.nicknames[userID] = name
	rt.mu.Unlock()
	return name
}

// debugLog 把回调的原始参数追加到 bridge-debug.log。
//
// 它的用途只有一个，但很关键：确认框架传进来的参数顺序与本模板的假设一致。
// 参数错位的表现是「消息正文里出现一串 QQ 号」这类怪现象，不会报任何错。
func (rt *bridgeRuntime) debugLog(robotJSON, scene, sceneID, userID, message, messageID string) {
	rt.mu.Lock()
	dir := rt.dataDir
	rt.mu.Unlock()
	if dir == "" {
		return
	}
	// robotJSON 也记下来：框架给的那份上下文里带着消息子类型之类的线索，
	// 而「私聊发不出去」这类问题的答案经常就在里面（真好友 vs 群临时会话）。
	// 截断是为了别让一行日志变成几 KB。
	context := robotJSON
	if len(context) > 600 {
		context = context[:600] + "…(截断)"
	}
	line := fmt.Sprintf("%s\tscene=%s\tsceneId=%s\tuserId=%s\tmessageId=%s\tmessage=%q\n\trobot=%s\n",
		time.Now().Format("2006-01-02 15:04:05"), scene, sceneID, userID, messageID, message, context)
	file, err := os.OpenFile(filepath.Join(dir, debugFileName), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer file.Close()
	_, _ = file.WriteString(line)
}

func sleepCtx(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// 下面三个方法供设置窗口（settings.go，仅 Windows）读取当前状态。
//
// 放在这里而不是 settings.go，是为了让状态文本在没有窗口的平台上也能被测试覆盖：
// 「窗口显示什么」和「状态怎么算」是两件事，后者可以离线验。
func (rt *bridgeRuntime) statusText() string {
	rt.mu.Lock()
	cfg := rt.cfg
	state := rt.state
	rt.mu.Unlock()
	return state.statusText(cfg)
}

// settingsCard 是设置窗口里的一张检测卡片。
//
// 为什么要结构化而不是拼一段文字：用户的原话是「不要塞了一堆文字标签在那里」。
// 「环境检测」这件事本身就是三个独立的事实（内核、Node、服务端），
// 每一个都有自己的状态色 —— 拼成一段文字之后，这三件事就分不开了，
// 出问题时得从头读到尾才知道该看哪一句。
type settingsCard struct {
	Label string // 卡片标题，例：「游戏内核」
	Value string // 主值，例：「已就绪」
	Note  string // 补充，例：「端口 3200」
	Level string // ok / warn / error，决定那个小圆点的颜色
}

// settingsCards 组装三张检测卡片。
func (rt *bridgeRuntime) settingsCards() []settingsCard {
	cfg := rt.configSnapshot()
	snap := rt.state.snapshot()

	coreValue, coreNote, coreLevel := "尚未启动", "启用插件后自动启动", "warn"
	switch {
	case strings.Contains(snap.discovery, "未找到"):
		coreValue, coreNote, coreLevel = "未找到", snap.discovery, "error"
	case strings.HasPrefix(snap.discovery, "使用配置里的地址"):
		coreValue, coreNote, coreLevel = "外部内核", snap.discovery, "ok"
	case strings.HasPrefix(snap.discovery, "已自动找到"):
		coreValue, coreNote, coreLevel = "已就绪", snap.discovery, "ok"
	case strings.Contains(snap.discovery, "内核"):
		coreValue, coreNote, coreLevel = "启动中", snap.discovery, "warn"
	}

	nodeValue, nodeNote := "尚未检测", "启用插件后自动检测"
	nodeLevel := "warn"
	switch {
	case strings.Contains(snap.nodeStatus, "正在下载"):
		nodeValue, nodeNote, nodeLevel = "正在安装", snap.nodeStatus, "warn"
	case strings.Contains(snap.nodeStatus, "未找到"):
		nodeValue, nodeNote, nodeLevel = "未找到", "将自动下载便携版", "warn"
	case snap.nodeStatus == "":
		// 保持默认
	default:
		nodeValue = snap.nodeStatus
		nodeNote = "内核用它来跑"
		nodeLevel = "ok"
	}

	serverValue, serverNote, serverLevel := "未连接", cfg.API, "warn"
	if cfg.API != "" {
		serverValue = "已连接"
		serverNote = cfg.API
		serverLevel = rt.healthLevel()
	} else {
		serverNote = "地址还没解析出来"
	}

	return []settingsCard{
		{Label: "游戏内核", Value: coreValue, Note: coreNote, Level: coreLevel},
		{Label: "Node 运行时", Value: nodeValue, Note: nodeNote, Level: nodeLevel},
		{Label: "服务端", Value: serverValue, Note: serverNote, Level: serverLevel},
	}
}

// countersLine 是卡片下面那一行计数。
func (rt *bridgeRuntime) countersLine() string {
	snap := rt.state.snapshot()
	return fmt.Sprintf("入站 %d · 失败 %d　　投递 %d · 失败 %d · 丢档 %d　　游标 %d　　运行 %s",
		snap.inboundSent, snap.inboundFailed, snap.delivered, snap.deliverFailed, snap.gaps,
		snap.cursor, uptimeText(snap.startedAt))
}

// channelLine 是计数行下面那行：正文现在是什么形态。
//
// 它回答的是「为什么我的消息里是 $\textcolor{…}$ 源码」——那个问题的答案只有两种：
// richText 关着（出纯文本，任何通道都能读），或者开着但平台没给这个机器人
// 开通「原生 Markdown」（官方就把 markdown.content 当纯文本显示）。
func (rt *bridgeRuntime) channelLine() string {
	if rt.configSnapshot().RichText {
		return "正文：markdown（richText 开着）—— 需要平台给这个机器人开通「原生 Markdown」，否则会显示成源码"
	}
	return "正文：纯文本（richText 关着，任何通道都能正常阅读）"
}

// footerLine 是窗口底部那句状态/错误。
func (rt *bridgeRuntime) footerLine() string {
	snap := rt.state.snapshot()
	if snap.lastError == "" {
		return "运行正常。配置见同目录 bridge-config.json，改动在下次启用插件时生效。"
	}
	return "最近错误（" + humanAgo(snap.lastErrorAt) + "）：" + snap.lastError
}

// adminURL 是运营后台的地址（bridge-api 自带 /admin，跟插件同一个口令体系之外）。
func (rt *bridgeRuntime) adminURL() string {
	cfg := rt.configSnapshot()
	if cfg.API == "" {
		return ""
	}
	return strings.TrimRight(cfg.API, "/") + "/admin"
}

// addressSummary 是给日志用的一句话：现在连的是哪儿、或者正在往哪儿找。
//
// 单独抽出来是因为「服务端：」后面接空字符串是最容易误导人的一种日志 ——
// 它看起来像配置没读到，其实是「正在自动检索」。
func (rt *bridgeRuntime) addressSummary() string {
	cfg := rt.configSnapshot()
	if cfg.API != "" {
		return "服务端 " + cfg.API
	}
	return "服务端 自动检索中（候选端口 " + cfg.ScanRange + "）"
}

func (rt *bridgeRuntime) statusLine() string { return rt.state.statusLine() }

func (rt *bridgeRuntime) healthLevel() string { return rt.state.healthLevel() }
