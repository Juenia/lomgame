//go:build !windows

package main

import "os/exec"

// newCoreCommand 在没有窗口概念的平台上不需要隐藏什么。
func newCoreCommand(nodePath, entry, workDir string, env []string) *exec.Cmd {
	command := exec.Command(nodePath, entry)
	command.Dir = workDir
	command.Env = env
	return command
}
