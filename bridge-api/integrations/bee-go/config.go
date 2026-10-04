package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// 默认值取「同机部署、最省事」的那一档 —— 与 bridge-api/README.md 的默认部署一致。
const (
	defaultAPIBase  = "http://127.0.0.1:3200"
	defaultPlatform = "bee"
	defaultLongPoll = 25
	defaultWaitMs   = 2500
	// defaultCorePort 与 bridge-api 的 BRIDGE_PORT 默认值一致
	defaultCorePort = 3200
	// defaultNodeDownloadURL 是 Node 官方的 Windows 便携版压缩包。
	// 选便携版而不是安装包：解压即用、不动系统、不需要管理员。
	defaultNodeDownloadURL = "https://nodejs.org/dist/v22.23.2/node-v22.23.2-win-x64.zip"
)

// 三个文件名都带 bridge- 前缀：易语言版那份插件若与本插件装在同一台 BEE 上，
// 两者的 plugin_data 目录可能同名（都由插件名决定），不要互相踩。
const (
	configFileName = "bridge-config.json"
	cursorFileName = "bridge-cursor.json"
	debugFileName  = "bridge-debug.log"
)

// Config 是插件的全部可调项，落在 plugin_data/插件名/bridge-config.json。
//
// 为什么配置在文件里、而不是设置窗口的输入框里：这一版设置窗口是**只读**的
// （改 Win32 编辑控件要在真机上逐项验收，见 docs/设置窗口开发规范.md），
// 而运营改一个地址不该需要重新编译 DLL。
type Config struct {
	// API 是 bridge-api 的地址。
	//
	// **留空（或写 auto）= 自动检索**：插件在本机扫一遍候选端口（见 ScanRange），
	// 用免口令的 GET /api/v1 自述确认哪个端口是 bridge-api。同机部署不用填，这也是默认值。
	//
	// 跨机部署必须填成完整地址（例 http://192.168.1.9:3200）：
	// 自动检索只扫本机 —— 端口扫描不该往局域网里发。
	API string "json:\"api\""
	// ScanRange 是自动检索的候选端口，写法 "3100-3300"、"3200,8080"、"3200,8000-8010"。
	// 只在 API 留空时用得上。
	ScanRange string "json:\"scanRange\""
	// Token 必须与游戏机上的 BRIDGE_TOKEN 一致；同机部署留空。
	//
	// 留空是**正常状态**，不是配置缺失：服务端没设口令时只接受本机请求，
	// 同机部署两边都不用配。只有跨机（BRIDGE_HOST=0.0.0.0）才必须两边填同一个值。
	Token string "json:\"token\""
	// Platform 是写进审计与出站回源的框架名。
	// 同一台游戏机上两个上游的 Platform 不能相同 —— 出站回执是按它定向的。
	Platform string "json:\"platform\""
	// LongPollSec 是出站长轮询一次挂多久（秒）。0 = 关掉长轮询（会退化成短轮询，不推荐）。
	LongPollSec int "json:\"longpollSec\""
	// WaitMs 是一条消息回调里最多等多久让回执回来（毫秒）。
	// 它直接等于 BEE 处理一条群消息时会被卡住的上限，不要往大了调。
	WaitMs int "json:\"waitMs\""
	// Images 声明这条通道能不能发图。**默认 true**。
	//
	// 关着的时候判定层走文字降级（角色卡变成一大段文字状态卡）——
	// 那是易语言版的限制（那边发不了图），Go 版没有：BEE 的消息接口本来就带图片参数。
	//
	// 两种图片形态插件都处理：BRIDGE_IMAGE_MODE=url 时直接用链接；
	// 默认的 base64 模式下插件把图落到临时文件、发完删掉。
	// 万一发图失败，会**自动退化成纯文字重发**，玩家不会什么都看不到。
	Images bool "json:\"images\""
	// Buttons 声明能不能摆原生按钮。**默认 true**。
	//
	// BEE 支持 QQ 官方机器人的 keyboard（见 bee_sdk.go 的 BuildKeyboard），
	// 而 markdown 消息上就带着 KeyboardJSON 那一栏 —— 所以正文和按钮是同一条消息。
	// 按钮点击后 data（选项 id）会作为玩家消息发回来，走的正是判定层的数字回复那条路。
	//
	// 拿不到 AppID 时自动退回文本菜单，不会让玩家看到一排点不动的按钮。
	Buttons bool "json:\"buttons\""
	// FetchNickname 是否顺带取发送人昵称（多一次进程内 API 调用，结果按用户缓存）。
	FetchNickname bool "json:\"fetchNickname\""
	// ManageCore 决定「本机没有 bridge-api 时，插件要不要自己把随身内核拉起来」。
	//
	// 默认 true —— 这正是「只装一个 DLL」的那条路：插件里带着 Node 侧的内核，
	// 启用时自己解开、自己启动、禁用时自己收掉。
	// 关掉它：你想自己掌控内核进程（自己起、自己停），插件只负责连。
	ManageCore bool "json:\"manageCore\""
	// NodePath 指定用哪个 Node。
	//
	// **留空（默认）= 自动**：先用内核包自带的那份（安装即用就靠它），
	// 没有再找 PATH 里的。只在你想强制用某个特定版本时才需要填。
	NodePath string "json:\"nodePath\""
	// RichText 决定正文走不走 markdown（彩色 + 粗体）。**默认 true**。
	//
	// 打开它需要**两个条件同时成立**，缺一个就会把源码丢给玩家看：
	//   ① BEE 接的是 **QQ 官方机器人**通道（go-cqhttp / OneBot 那头根本没有
	//      markdown 消息类型 —— 依据是 BEE 官方文档《BeeBot框架》写着「基于 Go-cqhttp」，
	//      而它的 SDK 里又有官方机器人专属的 GetRobotAppID / SendGroupMarkdown）；
	//   ② 那个机器人**开通了「原生 Markdown」**。这是平台侧的申请项，插件在本地
	//      无论怎么探测都判断不出来 —— 没开通时，官方会把 markdown.content
	//      当纯文本原样显示，也就是你现在看到的 $\textcolor{…}$ 源码。
	//
	// 所以默认关：出纯文本，任何通道、任何权限下都**可读**。
	// 确认上面两条都成立之后再打开，那时正文会有颜色。
	RichText bool "json:\"richText\""
	// AutoInstallNode 决定「本机没有 Node 时，插件要不要自己下载一个」。
	//
	// 默认 true —— 这是「安装即用」的落点：目标机器上什么都没装也能跑起来。
	// 下载的是官方**便携版压缩包**，解压到插件自己的目录里，不装进系统、
	// 不要管理员权限、卸载时跟着删掉，也不会和用户已有的 Node 打架。
	AutoInstallNode bool "json:\"autoInstallNode\""
	// NodeDownloadURL 是自动安装时下载的地址。
	// 默认是 Node 官方 v22 的 Windows 便携版（约 34 MB）。
	// 内网/离线环境改成自己的镜像即可；填 "" 表示不下载。
	NodeDownloadURL string "json:\"nodeDownloadURL\""
	// CorePort 是随身内核监听的端口，默认 3200（与 bridge-api 的默认一致）。
	// 它只在「插件自己拉起内核」时用得上 —— 拉起来之后插件自己知道端口，不需要你再配 api。
	CorePort int "json:\"corePort\""
	// DebugRawCallbacks 把每次消息回调的原始参数追加进 bridge-debug.log。
	//
	// 它是为一件**不会报错**的事准备的：本模板假设回调参数是
	// (robotJSON, groupID, userID, message, messageID)。若你的 BEE 版本传的顺序不同，
	// 表现是「消息正文里出现一串 QQ 号」这类怪现象，而不是任何一条错误日志。
	// 行为不对时先开这个开关，看一眼原始参数。
	DebugRawCallbacks bool "json:\"debugRawCallbacks\""
}

func defaultConfig() Config {
	return Config{
		// 空 = 自动检索。默认值取「开箱即用」：同机部署不用改任何东西。
		API:           "",
		ScanRange:     defaultScanRange,
		Platform:      defaultPlatform,
		LongPollSec:   defaultLongPoll,
		WaitMs:        defaultWaitMs,
		FetchNickname: true,
		// 默认自己带内核：装一个 DLL 就能用，不必再开一个终端起服务
		// 默认声明能发图：BEE 的消息接口本来就有图片参数，
		// 关着的话判定层会走文字降级（角色卡变成一大段文字），那是易语言版的限制，不是这一版的。
		Images:          true,
		ManageCore:      true,
		AutoInstallNode: true,
		NodeDownloadURL: defaultNodeDownloadURL,
		// 空 = 自动：先用插件自己装的，再找 PATH 里的
		NodePath: "",
		CorePort: defaultCorePort,
	}
}

// Normalize 把配置收进安全区间。
//
// 它存在的理由不是「好看」：这几个值直接决定回调阻塞时长与轮询频率，
// 手写一个 0 或 999999 都不会报错，只会让机器人卡住或空转。
func (c *Config) Normalize() {
	c.API = strings.TrimSpace(c.API)
	// "auto" / "自动" 与留空同义 —— 写一个显式的词比留白更像「我确实要自动」
	if strings.EqualFold(c.API, "auto") || c.API == "自动" {
		c.API = ""
	}
	if c.API != "" {
		c.API = strings.TrimRight(c.API, "/")
		if !strings.HasPrefix(c.API, "http://") && !strings.HasPrefix(c.API, "https://") {
			c.API = "http://" + c.API
		}
	}
	c.ScanRange = strings.TrimSpace(c.ScanRange)
	if c.ScanRange == "" {
		c.ScanRange = defaultScanRange
	}
	c.Token = strings.TrimSpace(c.Token)
	c.Platform = strings.TrimSpace(c.Platform)
	if c.Platform == "" {
		c.Platform = defaultPlatform
	}
	if len(c.Platform) > 32 {
		c.Platform = c.Platform[:32]
	}
	if c.LongPollSec < 0 {
		c.LongPollSec = 0
	}
	if c.LongPollSec > 60 {
		c.LongPollSec = 60
	}
	if c.WaitMs < 0 {
		c.WaitMs = 0
	}
	if c.WaitMs > 15000 {
		c.WaitMs = 15000
	}
	// NodePath 留空是**正常状态**：意思是「先用内核包里自带的那份，再找 PATH」
	c.NodePath = strings.TrimSpace(c.NodePath)
	// 端口交给内核去 bind，但明显越界的值在这里就拦掉 ——
	// 让它在启用时安静地失败，不如在配置层就归位
	if c.CorePort < 1024 || c.CorePort > 65535 {
		c.CorePort = defaultCorePort
	}
}

// tokenState 只对外给「有没有口令」，不回显口令本身。
func (c Config) tokenState() string {
	if c.Token == "" {
		return "未设置（同机部署可留空）"
	}
	return "已设置"
}

func configPath(dir string) string { return filepath.Join(dir, configFileName) }

// loadConfig 读取配置；文件不存在时落一份默认值，供运营照着改。
//
// 解析失败时**不覆盖**原文件：那是运营手改坏的，冲掉就等于把他的编辑弄丢了。
func loadConfig(dir string) (Config, error) {
	cfg := defaultConfig()
	data, err := os.ReadFile(configPath(dir))
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return cfg, fmt.Errorf("读取 %s: %w", configFileName, err)
		}
		if writeErr := saveConfig(dir, cfg); writeErr != nil {
			return cfg, fmt.Errorf("写入默认 %s: %w", configFileName, writeErr)
		}
		return cfg, nil
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return defaultConfig(), fmt.Errorf("%s 不是合法 JSON（已按默认值运行，原文件未被改动）: %w", configFileName, err)
	}
	cfg.Normalize()
	return cfg, nil
}

func saveConfig(dir string, cfg Config) error {
	cfg.Normalize()
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(configPath(dir), append(data, '\n'))
}

// writeFileAtomic 先写临时文件再改名，避免写一半断电留下半截 JSON。
func writeFileAtomic(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
