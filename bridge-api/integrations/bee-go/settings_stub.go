//go:build !windows

package main

// 非 Windows 平台上的窗口桩。
//
// worker 与设置窗口都只在 Windows 上构建（Bee 是 Windows 框架），
// 这个文件存在的唯一理由：让 go vet / go test 能在别的平台上跑起来，
// 于是本插件的纯逻辑部分（协议、渲染、配置、队列）可以被独立验证 ——
// 那正好是最容易悄悄写错、又最难在真机上发现的那一半。
func showSettingsWindow() {}

func closeSettingsWindow() {}

// requestSettingsRepaint 在没有窗口的平台上什么也不用做。
func requestSettingsRepaint() {}
