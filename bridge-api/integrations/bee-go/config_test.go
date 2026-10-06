package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestNormalizeRepairsUnsafeValues(t *testing.T) {
	cases := []struct {
		name string
		in   Config
		want func(Config) bool
		desc string
	}{
		{
			name: "空地址 = 自动检索",
			in:   Config{API: "   "},
			want: func(c Config) bool { return c.API == "" },
			desc: "留空表示自动检索，不该被填成一个写死的地址",
		},
		{
			name: "auto 与留空同义",
			in:   Config{API: "  AUTO "},
			want: func(c Config) bool { return c.API == "" },
			desc: "写 auto 的人要的也是自动检索",
		},
		{
			name: "中文「自动」同义",
			in:   Config{API: "自动"},
			want: func(c Config) bool { return c.API == "" },
			desc: "中文写法也认",
		},
		{
			name: "空扫描范围回落默认区间",
			in:   Config{},
			want: func(c Config) bool { return c.ScanRange == defaultScanRange },
			desc: "没写扫描范围时用默认区间",
		},
		{
			name: "没有协议的地址补 http",
			in:   Config{API: "127.0.0.1:3200"},
			want: func(c Config) bool { return c.API == "http://127.0.0.1:3200" },
			desc: "补上 http://",
		},
		{
			name: "末尾斜杠去掉",
			in:   Config{API: "http://host:3200///"},
			want: func(c Config) bool { return c.API == "http://host:3200" },
			desc: "去尾斜杠（否则拼出的路径会多一层）",
		},
		{
			name: "长轮询上限收敛",
			in:   Config{LongPollSec: 9999},
			want: func(c Config) bool { return c.LongPollSec == 60 },
			desc: "别让一次请求挂上几小时",
		},
		{
			name: "负的长轮询归零",
			in:   Config{LongPollSec: -5},
			want: func(c Config) bool { return c.LongPollSec == 0 },
			desc: "负数不能进 query",
		},
		{
			name: "等待上限收敛",
			in:   Config{WaitMs: 999999},
			want: func(c Config) bool { return c.WaitMs == 15000 },
			desc: "这个值等于回调阻塞上限，必须有天花板",
		},
		{
			name: "上游名回落",
			in:   Config{},
			want: func(c Config) bool { return c.Platform == defaultPlatform },
			desc: "platform 为空时用 bee",
		},
		{
			name: "过长的上游名截断",
			in:   Config{Platform: strings.Repeat("x", 100)},
			want: func(c Config) bool { return len(c.Platform) == 32 },
			desc: "协议限 32 字符",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := tc.in
			cfg.Normalize()
			if !tc.want(cfg) {
				t.Fatalf("%s: 归一化后 %+v", tc.desc, cfg)
			}
		})
	}
}

func TestLoadConfigWritesDefaultOnFirstRun(t *testing.T) {
	dir := t.TempDir()
	cfg, err := loadConfig(dir)
	if err != nil {
		t.Fatalf("首次运行不该报错: %v", err)
	}
	// 默认取「开箱即用」：地址留空 = 自动检索，同机部署不用改任何东西
	if cfg.API != "" || cfg.Platform != defaultPlatform || cfg.ScanRange != defaultScanRange {
		t.Fatalf("默认值不对: %+v", cfg)
	}
	if _, err := os.Stat(filepath.Join(dir, configFileName)); err != nil {
		t.Fatalf("首次运行应落一份默认配置供运营照着改: %v", err)
	}
}

func TestLoadConfigKeepsBrokenFile(t *testing.T) {
	dir := t.TempDir()
	broken := "{ 这不是 JSON "
	if err := os.WriteFile(filepath.Join(dir, configFileName), []byte(broken), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := loadConfig(dir)
	if err == nil {
		t.Fatal("坏 JSON 必须报错（插件要知道自己在用默认值跑）")
	}
	if cfg.API != "" || cfg.ScanRange != defaultScanRange {
		t.Fatalf("报错后应按默认值运行，得到 %+v", cfg)
	}
	// 关键：不能把运营手改坏的文件冲掉 —— 那是他的编辑
	onDisk, readErr := os.ReadFile(filepath.Join(dir, configFileName))
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(onDisk) != broken {
		t.Fatalf("坏文件被覆盖了，内容变成: %s", onDisk)
	}
}

func TestLoadConfigRoundTrip(t *testing.T) {
	dir := t.TempDir()
	saved := Config{API: "http://game.local:3200", Token: "abc", Platform: "bee-guild",
		LongPollSec: 5, WaitMs: 800, Images: true, DebugRawCallbacks: true,
		// M2.172：管理员名单是切片 —— 不验的话，「配了却没生效」会是一条静默缺口
		AdminIDs: []string{"10001", "10002"}}
	// 先归一化再存：saveConfig 自己会归一化（把空的 scanRange 填成默认区间），
	// 不先做一次的话比的就是「归一化前 vs 归一化后」，那是这条用例的假失败
	saved.Normalize()
	if err := saveConfig(dir, saved); err != nil {
		t.Fatal(err)
	}
	loaded, err := loadConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	/*
	 * M2.172：这里必须用 DeepEqual —— Config 里现在有 AdminIDs（[]string），
	 * 含切片的结构体不能用 != 比，编译期就会红。
	 */
	if !reflect.DeepEqual(loaded, saved) {
		t.Fatalf("存回来的和存进去的不一样:\n got %+v\nwant %+v", loaded, saved)
	}
}

func TestTokenStateNeverEchoesSecret(t *testing.T) {
	if got := (Config{Token: "s3cret"}).tokenState(); strings.Contains(got, "s3cret") {
		t.Fatalf("设置窗口不该回显口令，得到 %q", got)
	}
}
