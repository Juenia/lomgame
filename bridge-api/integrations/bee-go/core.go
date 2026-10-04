package main

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 内核随身版：插件把 Node 那一侧的内核打包带在身上，启用时自己解开、自己拉起来。
//
// 为什么值得这么做：原来要玩家先跑一句 node bridge-api/src/main.ts 起服务，
// 再让插件去连它 —— 两件事、两个地方、两份排障，而最常踩的坑
// （起错了版本、端口不对、忘了起）恰好都出在「那两件事之间」。
// 内核塞进插件之后，玩家只需要装一个 DLL。
//
// 插件仍然**优先复用**本机已经在跑的内核（见 resolveClient）：
// 手动起过的、上一次没退干净的，都直接用，免得抢端口、免得出现两个世界。
const (
	// managedNodeDirName 是插件自己下载的 Node 放的地方（相对 core/）
	managedNodeDirName = "node"
	// coreDirName 是内核解压后在 plugin_data/<插件名>/ 下的目录名
	coreDirName = "core"
	// coreZipName 是 C 壳从 DLL 资源里释放出来的内核包
	coreZipName = "core.zip"
	// coreStampName 记的是「现在解开的是哪一版内核」（内容是 zip 的 sha256）
	coreStampName = "core.stamp"
	// coreEntry 是内核入口，相对 core/
	coreEntry = "bridge-api/src/main.ts"
	// coreLogName 收内核的 stdout/stderr。
	//
	// 必须落文件：内核起不来的时候，那几行日志是**唯一**的线索 ——
	// 插件这侧只看得到「连不上」。
	coreLogName = "core.log"
	// coreReadyTimeout 是等内核回答 /api/v1 的上限。
	// 实测：解压几秒；就算带着空世界首次建库也只要 40-60 秒。留三分钟是给慢机器。
	coreReadyTimeout = 3 * time.Minute
	// corePollInterval 是等待时的轮询间隔。
	corePollInterval = 500 * time.Millisecond
)

// corePaths 是内核相关的那几个路径。
type corePaths struct {
	root  string // .../core
	zip   string // .../core.zip
	stamp string // .../core/core.stamp
	data  string // .../core/data（玩家的世界，升级时不许动）
}

func corePathsFor(dataDir string) corePaths {
	root := filepath.Join(dataDir, coreDirName)
	return corePaths{
		root:  root,
		zip:   filepath.Join(dataDir, coreZipName),
		stamp: filepath.Join(root, coreStampName),
		data:  filepath.Join(root, "data"),
	}
}

// ensureCoreExtracted 保证 core/ 下是一份与 core.zip 对得上的内核。
//
// 判据是 zip 的 SHA256 与上次解压后记下的比对：重新构建过插件、内核变了，
// 就必须重解一遍；没变就直接用 —— 上千个文件没必要每次启用都写一遍。
func (rt *bridgeRuntime) ensureCoreExtracted(paths corePaths) error {
	sum, err := fileSHA256(paths.zip)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("内核包 %s 不在（C 壳释放失败？）", paths.zip)
		}
		return fmt.Errorf("读内核包: %w", err)
	}
	if recorded, err := os.ReadFile(paths.stamp); err == nil {
		if strings.TrimSpace(string(recorded)) == sum {
			return nil
		}
		rt.diagLog("内核：检测到新版本，重新解压")
	} else {
		rt.diagLog("内核：首次解压（大约几秒）")
	}
	if err := extractCoreZip(paths.zip, paths.root, paths.data); err != nil {
		return err
	}
	if err := writeFileAtomic(paths.stamp, []byte(sum+"\n")); err != nil {
		// 只是下次会多解压一遍，不是致命错误
		rt.diagLog("内核：写入版本戳失败（下次会重新解压）：%v", err)
	}
	rt.diagLog("内核：解压完成于 %s", paths.root)
	return nil
}

// extractCoreZip 把内核包解开到 targetDir。
//
// keepDir 是**玩家的世界**（core/data）。它的内容是数据库与存档，
// 一次内核升级绝不该把它冲掉 —— 所以这个目录下的文件「已存在就不动」，
// 只有打包进来的那份初始库在首次解压时才会落地。
func extractCoreZip(zipPath, targetDir, keepDir string) error {
	reader, err := zip.OpenReader(zipPath)
	if err != nil {
		return fmt.Errorf("打开内核包: %w", err)
	}
	defer reader.Close()

	keep := filepath.Clean(keepDir)
	for _, entry := range reader.File {
		name := path.Clean(entry.Name)
		// zip slip：包里的路径可以写成 ../../ 跑到外面去。
		// 这不是理论风险 —— zip 是构建产物，但它经过的每一手都可能是别人。
		if name == "." || name == ".." || strings.HasPrefix(name, "../") || path.IsAbs(name) {
			return fmt.Errorf("内核包里有越界路径: %q", entry.Name)
		}
		target := filepath.Join(targetDir, filepath.FromSlash(name))
		if !strings.HasPrefix(target, filepath.Clean(targetDir)+string(os.PathSeparator)) {
			return fmt.Errorf("内核包里有越界路径: %q", entry.Name)
		}
		if entry.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if strings.HasPrefix(target, keep+string(os.PathSeparator)) {
			if _, err := os.Stat(target); err == nil {
				continue // 玩家自己的世界，不动
			}
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := writeZipEntry(entry, target); err != nil {
			return err
		}
	}
	return nil
}

func writeZipEntry(entry *zip.File, target string) error {
	source, err := entry.Open()
	if err != nil {
		return err
	}
	defer source.Close()
	destination, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(destination, source); err != nil {
		destination.Close()
		return err
	}
	return destination.Close()
}

// downloadClient 专门用来下 Node。
//
// 不设 http.Client.Timeout：34 MB 在慢网上要几分钟，全局超时会把正常的下载砍掉。
// 超时交给调用方的 context。
var downloadClient = &http.Client{}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

// waitCoreReady 轮询内核，直到它回答得出 GET /api/v1 的那份自述。
//
// 判据用的是同一套指纹（probeEndpoint），不是「端口开着」——
// 内核起来之后会先建库、播种，那期间端口可能已经在听但还答不出东西。
func waitCoreReady(ctx context.Context, port int, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	base := baseURLForPort(port)
	var lastOutcome probeOutcome
	for time.Now().Before(deadline) {
		if err := ctx.Err(); err != nil {
			return err
		}
		lastOutcome = probeEndpoint(ctx, base, 2*time.Second)
		if lastOutcome == probeBridge {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(corePollInterval):
		}
	}
	return fmt.Errorf("等了 %s，内核还没准备好（最后一次探测：%s）", timeout.Round(time.Second), lastOutcome)
}

// bundledNodeName 是内核包里那份 Node 的文件名。
func bundledNodeName() string {
	if runtime.GOOS == "windows" {
		return "node.exe"
	}
	return "node"
}

// ensureNode 保证有一个能用的 Node，返回它的路径。
//
// 顺序：配置指定 → 插件自己装过的 → 系统 PATH 里的 → **自己下载一个**。
//
// 最后一步是「安装即用」的落点：目标机器上什么都没装，插件也能把自己跑起来。
// 下载的是官方**便携版压缩包**，解压到插件自己的目录里 —— 不装进系统、
// 不需要管理员权限、卸载时跟着删掉，比「静默安装一个 Node 到 C 盘」干净得多，
// 也不会和用户已有的 Node 打架。
func (rt *bridgeRuntime) ensureNode(ctx context.Context, paths corePaths, cfg Config) (string, error) {
	if path, ok := rt.findNode(paths, cfg); ok {
		return path, nil
	}
	if !cfg.AutoInstallNode {
		return "", errors.New("本机没有可用的 Node，而配置里关掉了自动安装（autoInstallNode=false）。" +
			"自己装一个 Node 22.18+，或者把 nodePath 指到它")
	}
	return rt.installNode(ctx, paths, cfg)
}

// findNode 按顺序找一个现成的 Node，找到就顺手把来源写进状态（设置窗口显示它）。
func (rt *bridgeRuntime) findNode(paths corePaths, cfg Config) (string, bool) {
	requested := strings.TrimSpace(cfg.NodePath)
	if requested != "" && !strings.EqualFold(requested, "auto") {
		if path, err := exec.LookPath(requested); err == nil {
			rt.rememberNode(path, "配置指定")
			return path, true
		}
		rt.diagLog("Node：配置指定的 %q 找不到，继续往下找", requested)
	}
	managed := filepath.Join(paths.root, managedNodeDirName, bundledNodeName())
	if info, err := os.Stat(managed); err == nil && !info.IsDir() {
		rt.rememberNode(managed, "插件自带（自动装的）")
		return managed, true
	}
	if path, err := exec.LookPath("node"); err == nil {
		rt.rememberNode(path, "系统 PATH")
		return path, true
	}
	rt.state.setNodeStatus("未找到，准备自动安装")
	return "", false
}

// rememberNode 记下用的是哪个 Node、来自哪儿、什么版本。
//
// 版本要真的问一次 —— 「有没有 Node」和「这个 Node 够不够新」是两个问题，
// 而后者才是内核起不来的常见原因。
func (rt *bridgeRuntime) rememberNode(path, source string) {
	version := nodeVersionOf(path)
	text := source
	if version != "" {
		text += " · " + version
	}
	rt.state.setNodeStatus(text)
	rt.diagLog("Node：用 %s（%s）", path, text)
	requestSettingsRepaint()
}

// nodeVersionOf 问一次版本；问不出来就返回空（不拦，只显示得少一点）。
func nodeVersionOf(path string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, path, "--version").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

// installNode 下载官方便携版 Node，解压到插件目录。
//
// 两件事必须做对：
//  1. **校验 SHA256**。下载的是可执行文件，网络中断留下的半截 zip 会以
//     「Node 起来了但什么都没发生」这种最难查的形式表现出来。
//     期望值取自同一个目录下的 SHASUMS256.txt。
//  2. **只取 node.exe**。官方包里还有 npm、corepack、一堆 .cmd ——
//     内核只用得到 node 本身，其余的解压出来只是给杀毒软件添素材。
func (rt *bridgeRuntime) installNode(ctx context.Context, paths corePaths, cfg Config) (string, error) {
	url := strings.TrimSpace(cfg.NodeDownloadURL)
	if url == "" {
		return "", errors.New("本机没有可用的 Node，配置里也没给下载地址（nodeDownloadURL）")
	}
	// core/ 可能还不存在（比如内核还没解压就先来装 Node）。
	// 不依赖调用顺序：这里自己把目录建出来，否则后面 os.Create 会报
	// "The system cannot find the path specified" —— 一个和下载毫无关系的错误。
	if err := os.MkdirAll(paths.root, 0o755); err != nil {
		return "", fmt.Errorf("建内核目录失败：%w", err)
	}
	targetDir := filepath.Join(paths.root, managedNodeDirName)
	target := filepath.Join(targetDir, bundledNodeName())
	rt.state.setNodeStatus("正在下载 Node（约 34 MB）…")
	rt.diagLog("Node：本机没有可用的，开始下载 %s", url)
	requestSettingsRepaint()

	archivePath := filepath.Join(paths.root, "node-download.zip")
	if err := rt.downloadFile(ctx, url, archivePath); err != nil {
		return "", fmt.Errorf("下载 Node 失败：%w", err)
	}
	defer os.Remove(archivePath)

	rt.state.setNodeStatus("正在校验 Node 安装包…")
	requestSettingsRepaint()
	verified, err := verifyDownload(ctx, url, archivePath)
	if err != nil {
		return "", err
	}
	if verified {
		rt.diagLog("Node：安装包 SHA256 校验通过")
	} else {
		rt.diagLog("Node：拿不到 SHASUMS256.txt，跳过校验（能用，但万一包是坏的，会到启动阶段才暴露）")
	}

	rt.state.setNodeStatus("正在解压 Node…")
	requestSettingsRepaint()
	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		return "", err
	}
	if err := extractSingleFromZip(archivePath, bundledNodeName(), target); err != nil {
		return "", fmt.Errorf("解开 Node 失败：%w", err)
	}
	rt.diagLog("Node：已装到 %s", target)
	rt.rememberNode(target, "插件自带（自动装的）")
	return target, nil
}

// downloadFile 流式下载并报告进度。
//
// 进度是必须的：34 MB 在慢网上要几分钟，而设置窗口里那句「正在下载…」
// 如果一直停在 0%，玩家会以为卡死了。
func (rt *bridgeRuntime) downloadFile(ctx context.Context, url, target string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	response, err := downloadClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("服务端回了 %d", response.StatusCode)
	}
	file, err := os.Create(target)
	if err != nil {
		return err
	}
	defer file.Close()

	total := response.ContentLength
	buffer := make([]byte, 256<<10)
	var written, lastReport int64
	for {
		read, readErr := response.Body.Read(buffer)
		if read > 0 {
			if _, writeErr := file.Write(buffer[:read]); writeErr != nil {
				return writeErr
			}
			written += int64(read)
			// 每 4 MB 报一次：够看出在动，又不会把窗口刷爆
			if written-lastReport >= 4<<20 {
				lastReport = written
				if total > 0 {
					rt.state.setNodeStatus(fmt.Sprintf("正在下载 Node… %d%%", written*100/total))
				} else {
					rt.state.setNodeStatus(fmt.Sprintf("正在下载 Node… %d MB", written>>20))
				}
				requestSettingsRepaint()
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	return file.Sync()
}

// verifyDownload 用同目录下的 SHASUMS256.txt 校验刚下下来的包。
//
// 返回值 verified 表示"真的校验过了"。清单拿不到时**不拦**：
// 校验是加分项、不是通行证，拦下来会让「官方改了文件名」变成玩家装不上插件。
func verifyDownload(ctx context.Context, url, archivePath string) (bool, error) {
	slash := strings.LastIndex(url, "/")
	if slash < 0 {
		return false, nil
	}
	sumsURL := url[:slash+1] + "SHASUMS256.txt"
	want, err := fetchExpectedSHA256(ctx, sumsURL, url[slash+1:])
	if err != nil {
		return false, nil
	}
	got, err := fileSHA256(archivePath)
	if err != nil {
		return false, err
	}
	if got != want {
		os.Remove(archivePath)
		return false, errors.New("Node 安装包校验不通过（下载损坏或地址不对），已删掉 —— 下次启用会重下")
	}
	return true, nil
}

func fetchExpectedSHA256(ctx context.Context, sumsURL, fileName string) (string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, sumsURL, nil)
	if err != nil {
		return "", err
	}
	response, err := downloadClient.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("SHASUMS256.txt 回了 %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(body), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[1] == fileName {
			return fields[0], nil
		}
	}
	return "", fmt.Errorf("SHASUMS256.txt 里没有 %s", fileName)
}

// extractSingleFromZip 只从 zip 里取出指定文件名的那一个条目。
//
// 官方包里 node.exe 在 node-v22.x.x-win-x64/ 这一层下面，
// 所以按 basename 比 —— 写死那一层目录名会在换版本时失效。
func extractSingleFromZip(zipPath, baseName, target string) error {
	reader, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer reader.Close()
	for _, entry := range reader.File {
		if path.Base(entry.Name) != baseName {
			continue
		}
		source, err := entry.Open()
		if err != nil {
			return err
		}
		defer source.Close()
		destination, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
		if err != nil {
			return err
		}
		if _, err := io.Copy(destination, source); err != nil {
			destination.Close()
			return err
		}
		return destination.Close()
	}
	return fmt.Errorf("包里没有 %s", baseName)
}

// coreRunner 持有插件自己拉起来的内核进程。
type coreRunner struct {
	mu   sync.Mutex
	cmd  *exec.Cmd
	port int
	// stdinWrite 是给内核的 stdin 写端，**必须一直持有**。
	//
	// 它一被关闭（本进程退出导致的关闭也算），内核就读到 EOF 并退出 ——
	// 这正是我们要的「父进程死了，别当孤儿」。
	// 反过来，如果让它被 GC 收走，等于内核一启动就被告知父进程没了。
	stdinWrite *os.File
	// done 在进程真正退出、日志文件也关掉之后关闭。
	// stopCore 等它，才能保证「回来的时候进程确实没了、文件确实能删」。
	done chan struct{}
}

// startCore 把内核拉起来，返回它监听的端口。
//
// 只负责「把进程起对」：解压核对、Node 版本、工作目录、日志去向。
// 等它就绪是 waitCoreReady 的事 —— 那一步要几十秒，不该混在这里。
func (rt *bridgeRuntime) startCore(ctx context.Context, paths corePaths, cfg Config) (int, error) {
	if err := rt.ensureCoreExtracted(paths); err != nil {
		return 0, err
	}
	nodePath, err := rt.ensureNode(ctx, paths, cfg)
	if err != nil {
		return 0, err
	}
	if err := checkNodeVersion(nodePath, nodePath); err != nil {
		return 0, err
	}

	port := cfg.CorePort
	logPath := filepath.Join(filepath.Dir(paths.root), coreLogName)
	logFile, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, fmt.Errorf("打开内核日志 %s: %w", logPath, err)
	}

	environment := append(os.Environ(),
		fmt.Sprintf("BRIDGE_PORT=%d", port),
		// 只监听本机：内核与插件在同一台机器上，没有任何理由把它暴露到局域网
		"BRIDGE_HOST=127.0.0.1",
		// 库放在 core/data 下 —— 也就是 plugin_data 里，跟着插件走
		"BRIDGE_DB_PATH="+filepath.Join(paths.data, "bridge.db"),
		// 不设口令：同机访问，服务端本来就只接受本机请求
		"BRIDGE_TOKEN=",
	)
	// 默认**不设** LOM_PLAIN_TEXT：BEE 是 QQ 官方框架，会渲染正文里的
	// LaTeX 彩色与粗体（前提是用 markdown 消息类型发，见 sendAsMarkdown）。
	// 只有用户明确要求纯文本时才设 —— 那时内核出的正文逐字退回旧版。
	// 没开 richText 就让内核**根本不生成**彩色与粗体标记。
	//
	// 关键在"根本不出"而不是"出了不用"：内核生成的 $\textcolor{…}$ 一旦落到
	// 不支持 markdown 的通道上，玩家看到的就是源码 —— 比没有颜色难看得多。
	if !cfg.RichText {
		environment = append(environment, "LOM_PLAIN_TEXT=1")
	}
	// 头像直链模板：没有它，服务端拼不出 avatarUrl，判定层就不画信息头。
	if template := rt.avatarTemplate(); template != "" {
		environment = append(environment, "BRIDGE_AVATAR_TEMPLATE="+template)
	}
	command := newCoreCommand(nodePath, coreEntry, paths.root, environment)
	command.Stdout = logFile
	command.Stderr = logFile
	// 给内核一个 stdin 管道，**并且把这个写端一直握在手里**。
	//
	// 内核靠「stdin 读到 EOF」判断拉起它的进程已经没了 —— 而这一侧（worker）
	// 通常是被强杀的，没机会发任何信号。写端句柄随本进程消失而关闭，
	// 内核那边立刻读到 EOF 并退出。
	//
	// 不这么做它会变成**孤儿**：实测过一次，BEE 退出半小时后内核还活着，
	// 占着端口和数据库。
	stdinReader, stdinWriter, pipeErr := os.Pipe()
	if pipeErr == nil {
		command.Stdin = stdinReader
	}
	if err := command.Start(); err != nil {
		logFile.Close()
		return 0, fmt.Errorf("启动内核进程失败: %w", err)
	}
	rt.diagLog("内核：进程已启动（pid=%d，端口 %d，日志 %s）", command.Process.Pid, port, logPath)

	runner := &coreRunner{cmd: command, port: port, done: make(chan struct{}), stdinWrite: stdinWriter}
	// 收尾放在这里而不是 stopCore，有两个原因：
	//   1. exec.Cmd 只允许 Wait 一次，两边都调会打架；
	//   2. **日志文件的句柄要活到进程结束** —— 子进程继承的就是它。
	//      不关的后果在 Windows 上很具体：文件被 worker 一直占着，删不掉。
	//      玩家的 plugin_data 会因此清不干净，测试的临时目录也一样。
	go func() {
		_ = command.Wait()
		logFile.Close()
		close(runner.done)
	}()

	rt.mu.Lock()
	rt.core = runner
	rt.mu.Unlock()
	return port, nil
}

// stopCore 收掉插件拉起来的内核。
//
// 这条路覆盖的是**正常**的禁用/卸载。万一 worker 是被强杀的（C 壳等不及），
// 内核会变成孤儿进程继续跑 —— 那种情况由下一次启动兜住：
// resolveClient 会先探测本机，发现它还在就直接复用，不会去抢端口。
func (rt *bridgeRuntime) stopCore() {
	rt.mu.Lock()
	runner := rt.core
	rt.core = nil
	rt.mu.Unlock()
	if runner == nil {
		return
	}
	runner.mu.Lock()
	command := runner.cmd
	runner.mu.Unlock()
	if command == nil || command.Process == nil {
		return
	}
	if err := command.Process.Kill(); err != nil {
		rt.diagLog("内核：结束进程失败（可能已经退出）：%v", err)
	} else {
		rt.diagLog("内核：已要求进程退出")
	}
	// 等那个收尾 goroutine 把进程与日志文件都处理干净。
	// 不等的话，调用方（onDisable、测试清理）会拿到一个「还在占用文件」的目录。
	select {
	case <-runner.done:
	case <-time.After(5 * time.Second):
		rt.diagLog("内核：等进程退出超时，不再等")
	}
	rt.diagLog("内核：进程已结束")
}

// checkNodeVersion 确认 Node 够新。
//
// 内核是 TypeScript 直接跑的（node 的 --experimental-strip-types 那套），
// 低于 22.18 会在启动时报一句很难读的语法错误 —— 那正是玩家最不容易反应过来的地方，
// 所以在这里先说清楚。
func checkNodeVersion(nodePath, asGiven string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, nodePath, "--version").Output()
	if err != nil {
		return fmt.Errorf("执行 %s --version 失败: %w", asGiven, err)
	}
	text := strings.TrimSpace(string(output))
	major, minor, ok := parseNodeVersion(text)
	if !ok {
		// 版本读不出来就不拦（可能是别的实现，比如某些兼容运行时）
		return nil
	}
	if major > 22 || (major == 22 && minor >= 18) {
		return nil
	}
	return fmt.Errorf("Node 版本太低：%s（需要 22.18 以上）—— 内核的 .ts 是直接交给 Node 跑的，"+
		"低版本会在启动时报语法错误。升级 Node，或把 bridge-config.json 的 nodePath 指到新版本", text)
}

// parseNodeVersion 解析 "v22.23.2" 这样的输出。
func parseNodeVersion(text string) (int, int, bool) {
	text = strings.TrimPrefix(strings.TrimSpace(text), "v")
	parts := strings.Split(text, ".")
	if len(parts) < 2 {
		return 0, 0, false
	}
	major, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, 0, false
	}
	minor, err := strconv.Atoi(parts[1])
	if err != nil {
		return 0, 0, false
	}
	return major, minor, true
}

// readCoreLogTail 读内核日志的最后几行。
//
// 内核起不来的时候（端口被占、依赖缺失、语法错误），它自己会把原因写进日志，
// 而插件这侧只看得到「连不上」。把这几行带进错误信息，能省掉一整轮来回。
func readCoreLogTail(dataDir string, lines int) string {
	path := filepath.Join(dataDir, coreLogName)
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	all := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	if len(all) > lines {
		all = all[len(all)-lines:]
	}
	// 内核日志里可能有很长的 JSON，截一下免得把设置窗口撑爆
	joined := strings.Join(all, "\n")
	if len(joined) > 600 {
		joined = joined[len(joined)-600:]
	}
	return joined
}
