//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// createNoWindow 让内核进程不弹控制台窗口。
//
// 不加它的话，插件一启用就会在玩家屏幕上闪一个黑框 —— 那不只是难看：
// 玩家会以为程序出错了，然后顺手把那个窗口关掉（那等于把内核关了）。
const createNoWindow = 0x08000000

// newCoreCommand 组装启动内核的命令。
//
// 平台相关的只有这一小块（隐藏窗口）。解压、版本检查、就绪检测都留在 core.go 里 ——
// 那些能测；这一块只能在真机上验。
func newCoreCommand(nodePath, entry, workDir string, env []string) *exec.Cmd {
	command := exec.Command(nodePath, entry)
	command.Dir = workDir
	command.Env = env
	command.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNoWindow,
	}
	return command
}
