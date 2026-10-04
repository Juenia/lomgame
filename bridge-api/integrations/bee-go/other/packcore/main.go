// packcore 把「能跑起来的 bridge-api 内核」打成一个 zip。
//
// 为什么是 zip 而不是把每个文件都嵌成资源：Windows 的资源是**单块**的，
// 而内核有 1000 多个文件 —— 只能先打成一个包，运行时再解开（见 core.go）。
//
// 打包判据是「跑起来需要什么」，不是「仓库里有什么」：
//
//	src/                     判定层、内容 YAML、数据库迁移 —— 全部必需
//	bridge-api/src/          上游对接层
//	package.json             里面那句 "type": "module" 决定 Node 怎么解释 .ts
//	bridge-api/package.json
//	node_modules/zod         唯一的两个第三方依赖，都没有子依赖
//	node_modules/yaml
//	data/bridge.db           预建好的空世界，省掉首次启用约 40 秒的播种
//
// 用法：
//
//	go run ./other/packcore <仓库根目录> <输出 zip>
package main

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// 只保留运行时真正用得到的后缀。
//
// 这不只是「干净」问题，是**体积**问题：zod 的类型声明与 sourcemap 加起来
// 比它的 .js 还大，而这些包解压后要落在玩家的 plugin_data 里（每次内核更新还要重来一遍）。
var (
	sourceExts  = map[string]bool{".ts": true, ".yaml": true, ".yml": true, ".sql": true, ".js": true, ".mjs": true, ".cjs": true, ".json": true}
	runtimeExts = map[string]bool{".js": true, ".mjs": true, ".cjs": true, ".json": true}
)

type packRule struct {
	// rel 是相对仓库根的路径，同时也是**包内**的路径
	rel string
	// exts 为 nil 表示这是一个单文件，或该目录下全收
	exts map[string]bool
	// source 非空时从这个绝对路径取内容，包内路径仍用 rel。
	// 初始数据库就是这么来的：它由一次干净的播种生成在别处，不该先塞进仓库。
	source string
}

// 刻意**不打包** Node：它是 83 MB（deflate 后也有 33 MB），
// 塞进 DLL 会让插件从 11 MB 涨到 44 MB，而绝大多数机器上本来就有。
// 缺了怎么办？插件自己检测、自己下载一个便携版（见 core.go 的 ensureNode）——
// 下载发生在**目标机器上、真正需要的时候**，不占每个玩家的硬盘和带宽。
func packRules(initialDB string) []packRule {
	return []packRule{
		{rel: "src", exts: sourceExts},
		{rel: "bridge-api/src", exts: sourceExts},
		{rel: "package.json"},
		{rel: "bridge-api/package.json"},
		{rel: "node_modules/zod", exts: runtimeExts},
		{rel: "node_modules/yaml", exts: runtimeExts},
		{rel: "data/bridge.db", source: initialDB},
	}
}

func main() {
	if len(os.Args) < 3 || len(os.Args) > 4 {
		fmt.Fprintln(os.Stderr, "usage: go run ./other/packcore <repo-root> <output-zip> [initial-db]")
		os.Exit(2)
	}
	initialDB := ""
	if len(os.Args) == 4 {
		initialDB = os.Args[3]
	}
	if err := run(os.Args[1], os.Args[2], initialDB); err != nil {
		fmt.Fprintln(os.Stderr, "打包失败:", err)
		os.Exit(1)
	}
}

func run(repoRoot, outPath, initialDB string) error {
	// 先删掉旧的：上一次构建留下的 zip 会让「压缩后多大」这个读数变得不可信
	if err := os.Remove(outPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	output, err := os.Create(outPath)
	if err != nil {
		return err
	}
	defer output.Close()
	archive := zip.NewWriter(output)

	var files int
	var total int64
	for _, rule := range packRules(initialDB) {
		source := filepath.Join(repoRoot, filepath.FromSlash(rule.rel))
		if rule.source != "" {
			source = rule.source
		}
		abs := source
		info, err := os.Stat(abs)
		if err != nil {
			// 缺件必须当场报错：少打一个目录，做出来的插件要到玩家机器上才会发现
			return fmt.Errorf("缺少 %s: %w", rule.rel, err)
		}
		if !info.IsDir() {
			if err := addFileFrom(archive, source, rule.rel, info); err != nil {
				return err
			}
			files++
			total += info.Size()
			continue
		}
		walkErr := filepath.Walk(abs, func(path string, entry os.FileInfo, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() {
				return nil
			}
			rel, err := filepath.Rel(repoRoot, path)
			if err != nil {
				return err
			}
			rel = filepath.ToSlash(rel)
			if rule.exts != nil && !rule.exts[strings.ToLower(filepath.Ext(rel))] {
				return nil
			}
			if err := addFileFrom(archive, path, rel, entry); err != nil {
				return err
			}
			files++
			total += entry.Size()
			return nil
		})
		if walkErr != nil {
			return walkErr
		}
	}
	if err := archive.Close(); err != nil {
		return err
	}
	zipped, err := os.Stat(outPath)
	if err != nil {
		return err
	}
	// 输出用 ASCII：build.bat 里是 chcp 936，UTF-8 的中文在那里会显示成乱码
	fmt.Printf("core packed: %d files, %.1f MB raw, %.1f MB zipped\n",
		files, float64(total)/1048576, float64(zipped.Size())/1048576)
	return nil
}

func addFileFrom(archive *zip.Writer, absPath, rel string, info os.FileInfo) error {
	source, err := os.Open(absPath)
	if err != nil {
		return err
	}
	defer source.Close()
	header, err := zip.FileInfoHeader(info)
	if err != nil {
		return err
	}
	header.Name = rel
	header.Method = zip.Deflate
	writer, err := archive.CreateHeader(header)
	if err != nil {
		return err
	}
	_, err = io.Copy(writer, source)
	return err
}
