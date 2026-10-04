package main

import (
	"errors"
)

// 插件元数据。这四个常量是构建工具**直接读源码**取的（见 other/buildmeta/main.go），
// 不是运行期入口，所以必须是字符串字面量，且不能为空。
//
// PluginName 决定三件事：BEE 插件列表里的名字、默认 DLL 文件名、
// 以及数据目录 plugin_data/<PluginName>。
// 它与易语言版那份插件（应用名「诡秘之主」）刻意不同名 ——
// 同名的话两个插件的 plugin_data 目录会撞在一起，配置与游标互相覆盖。
const (
	PluginName        = "群星的低语"
	PluginAuthor      = "曾经"
	PluginVersion     = "1.1"
	PluginDescription = "诡秘之主同人游戏《群星的低语》"
)

func pluginMetadata() PluginInfo {
	return PluginInfo{Name: PluginName, Author: PluginAuthor, Version: PluginVersion, Description: PluginDescription}
}

// bridge 是插件的运行期单例。
//
// 一个进程只服务一个 BEE 插件实例，所以这里用单例而不是到处传引用；
// 所有后台 goroutine 都挂在它身上，禁用时统一停掉。
var bridge = newBridgeRuntime()

// beeFromArgs 从回调参数的第一项创建 BeeAPI。
func beeFromArgs(args [][]byte) (*BeeAPI, error) {
	if len(args) == 0 {
		return nil, errors.New("callback missing robot context")
	}
	return NewBeeAPI(string(args[0]))
}

func robotJSONFromArgs(args [][]byte) string {
	if len(args) == 0 {
		return ""
	}
	return string(args[0])
}

// onInitialize 在 Bee_初始化 返回插件信息之前调用一次。
//
// 这里只做「读配置、准备目录」：C 壳在这个回调之后立刻停掉 worker 进程，
// 在此处启动的任何后台任务都活不到插件启用。
func onInitialize(args [][]byte) {
	bee, err := beeFromArgs(args)
	if err != nil {
		return
	}
	dataDir, err := bee.GetAppDataDir()
	if err != nil {
		_ = bee.Log("群星的低语：取插件数据目录失败：" + err.Error())
		return
	}
	bridge.prepare(dataDir)
	_ = bee.Log("群星的低语 " + PluginVersion + " 初始化完成，数据目录：" + dataDir)
}

// onEnable 在插件被启用时调用，是后台任务真正的起点。
func onEnable(args [][]byte) {
	bee, err := beeFromArgs(args)
	if err != nil {
		return
	}
	// 初始化没跑成（或框架直接启用了插件）时补一次，否则启用后什么都不会发生
	if dataDir, err := bee.GetAppDataDir(); err == nil {
		bridge.prepare(dataDir)
	}
	// 取一次 AppID 并记下来。它有两个用途，都跟「这条通道长什么样」有关：
	//
	//   · 头像直链模板 https://q.qlogo.cn/qqapp/<appid>/{userId}/{size}
	//     （形状来自 src/adapter/qq-official/index.ts:1331 的真机核对）。
	//     没有它，判定层拿不到头像，角色卡的信息头就整个不画 ——
	//     玩家看到的是「卡片顶部空着」加一行「没拿到你的 QQ 头像」。
	//   · 按钮键盘的 BuildKeyboard 需要 bot_appid。
	//
	// ⚠️ 这里调 API 是**有意为之**，而且必须在回调线程里（Bee API 的调用约束）。
	// 曾经有一轮把它当成「消息发不出去」的嫌疑人回滚过 —— 后来查清了，
	// 那次真凶是出站游标比队列还新（见 state.resetCursor），与这次调用无关。
	bridge.setBotAppID(bee)

	cfg := bridge.configSnapshot()
	bridge.start(robotJSONFromArgs(args))
	// cfg.API 可能是空的（自动检索）—— 那时别在日志里留一个空的「服务端 」，
	// 让人以为是配置没读到
	_ = bee.Log("群星的低语：已启用，" + bridge.addressSummary() + "，上游名 " + cfg.Platform)
}

// onDisable 停止后台任务并关闭设置窗口。
//
// 顺序是有讲究的：先停后台（长轮询会被 context 立刻取消，不会卡住），
// 再关窗口 —— 反过来的话窗口线程可能还在读状态，读到一半被清掉。
func onDisable(args [][]byte) {
	bridge.stop()
	if bee, err := beeFromArgs(args); err == nil {
		_ = bee.Log("群星的低语：已停用")
	}
	closeSettingsWindow()
}

// onUnload 在插件被卸载时调用。
//
// Bee 只允许先禁用再卸载，后台任务与设置窗口已经在 onDisable 里收干净了。
func onUnload(args [][]byte) {
	if bee, err := beeFromArgs(args); err == nil {
		_ = bee.Log("群星的低语：已卸载")
	}
}

// onSettings 打开只读的设置窗口。
func onSettings(args [][]byte) {
	if bee, err := beeFromArgs(args); err == nil {
		_ = bee.Log("群星的低语：打开设置窗口")
	}
	// 顺手保证「地址解析」至少跑过一次。
	//
	// 用户打开设置最想知道的头一件事就是「它连的是哪个地址」，而插件**没启用**时
	// 后台根本没跑过 —— 窗口只能显示「尚未检索」，看着像插件坏了。
	// 这里只探地址，不启动收发循环（那是 onEnable 的事）。
	bridge.probeOnce()
	showSettingsWindow()
}

// onGroupMessage 处理群聊消息。
//
// 群号既是会话 id（sceneId）也是回执目标（targetId）—— 协议里两者在群聊下同一个值。
func onGroupMessage(
	robotJSON string, // 当前机器人上下文 JSON，用于创建本次消息的 BeeAPI
	groupID string, // 来源群 ID
	userID string, // 触发人 ID，即群消息发送人（BEE 给的就是 QQ 号）
	message string, // 收到的群聊消息内容
	messageID string, // 消息 ID，用于撤回、引用等上下文相关 API
) int {
	bridge.handleInbound(robotJSON, sceneGroup, groupID, groupID, userID, message, messageID)
	return MessageContinue
}

// onPrivateMessage 处理好友私聊消息。
//
// 私聊的回执目标是**发送人的 QQ 号**（协议里 private 的 targetId 就是 userId）。
// 填群号、或填带前缀的会话 id，回执都会发不出去 —— 而且**不报错**。
func onPrivateMessage(
	robotJSON string, // 当前机器人上下文 JSON
	friendID string, // 好友 ID，即私聊消息发送人
	message string, // 收到的私聊消息内容
	messageID string, // 消息 ID
) int {
	bridge.handleInbound(robotJSON, scenePrivate, friendID, friendID, friendID, message, messageID)
	return MessageContinue
}

// onChannelMessage 处理频道消息。
//
// 频道场景的 sceneId 与回执目标都是**子频道 id**。
func onChannelMessage(
	robotJSON string, // 当前机器人上下文 JSON
	channelID string, // 来源频道 ID
	subChannelID string, // 来源具体子频道 ID
	userID string, // 触发人 ID
	message string, // 收到的频道消息内容
	messageID string, // 消息 ID
) int {
	bridge.handleInbound(robotJSON, sceneChannel, subChannelID, subChannelID, userID, message, messageID)
	return MessageContinue
}

// onChannelPrivate 处理频道私信。
//
// 频道私信按私聊口径走：玩家身份与回执目标都是发送人。
func onChannelPrivate(
	robotJSON string, // 当前机器人上下文 JSON
	channelID string, // 来源频道 ID
	subChannelID string, // 来源子频道 ID
	userID string, // 触发人 ID，即频道私信发送人
	message string, // 收到的频道私信内容
	messageID string, // 消息 ID
) int {
	bridge.handleInbound(robotJSON, scenePrivate, userID, userID, userID, message, messageID)
	return MessageContinue
}

// onChannelEvent 处理频道事件（成员变动、子频道增删、按钮交互等）。
//
// 本插件不消费这些事件：订阅它们只会让一条无关的事件去排队等长轮询。
// 保留空实现是为了让模板的结构完整（事件常量见 bee_sdk.go）。
func onChannelEvent(
	robotJSON string, // 当前机器人上下文 JSON
	channelID string, // 事件所属频道 ID
	subChannelID string, // 事件所属子频道 ID
	userID string, // 触发人 ID
	operatorID string, // 操作人 ID
	eventType string, // 事件类型，对应 bee_sdk.go 中的频道 EventType 常量
	rawMessage string, // 事件原始内容
) int {
	_, _, _, _, _, _, _ = robotJSON, channelID, subChannelID, userID, operatorID, eventType, rawMessage
	return MessageContinue
}

// onCommonEvent 处理好友、私聊与群聊的通常事件（加好友、入群、被踢等）。
//
// 同样不消费。注意按钮事件（EventInteractionCreate）也走这里：
// 本插件声明了 buttons=false，判定层不会发按钮，所以没有要响应的事件。
func onCommonEvent(
	robotJSON string, // 当前机器人上下文 JSON
	sourceID string, // 消息来源 ID：群聊事件为群 ID，私聊事件为好友 ID
	userID string, // 触发人 ID
	operatorID string, // 操作人 ID
	eventType string, // 事件类型，对应 bee_sdk.go 中的 EventType 常量
	rawMessage string, // 事件原始内容
) int {
	_, _, _, _, _, _ = robotJSON, sourceID, userID, operatorID, eventType, rawMessage
	return MessageContinue
}
