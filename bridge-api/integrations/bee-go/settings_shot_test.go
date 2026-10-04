//go:build windows && windowtest

package main

// 把设置窗口截成 PNG。
//
// 为什么值得写：窗口是**画**出来的，编译通过、逻辑正确都不等于它长得对。
// 之前几轮我只能靠推理说"布局应该没问题"，而用户看到的是重叠的文字和空白。
// 有了它，改完之后能真的看一眼。
//
//   go test -tags windowtest -run TestSettingsWindowScreenshot -v .
//   → %TEMP%\settings-window.png

import (
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"time"
	"unsafe"
)

var (
	procCreateCompatibleDC     = gdi32.NewProc("CreateCompatibleDC")
	procCreateCompatibleBitmap = gdi32.NewProc("CreateCompatibleBitmap")
	procDeleteDC               = gdi32.NewProc("DeleteDC")
	procBitBlt                 = gdi32.NewProc("BitBlt")
	procGetDIBits              = gdi32.NewProc("GetDIBits")
	procPrintWindow            = user32.NewProc("PrintWindow")
)

type bitmapInfoHeader struct {
	Size          uint32
	Width         int32
	Height        int32
	Planes        uint16
	BitCount      uint16
	Compression   uint32
	SizeImage     uint32
	XPelsPerMeter int32
	YPelsPerMeter int32
	ClrUsed       uint32
	ClrImportant  uint32
}

type rgbQuad struct{ Blue, Green, Red, Reserved byte }

type bitmapInfo struct {
	Header bitmapInfoHeader
	Colors [1]rgbQuad
}

func TestSettingsWindowScreenshot(t *testing.T) {
	showSettingsWindow()
	defer closeSettingsWindow()
	waitUntil(t, "窗口被创建", func() bool { return settingsHandle() != 0 }, 5*time.Second)
	hwnd := settingsHandle()
	// 等它把第一帧画完 —— WM_PAINT 是异步的
	time.Sleep(800 * time.Millisecond)

	var client rect
	procGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&client)))
	width := int(client.Right - client.Left)
	height := int(client.Bottom - client.Top)
	if width <= 0 || height <= 0 {
		t.Fatalf("窗口尺寸不对: %dx%d", width, height)
	}
	t.Logf("客户区 %dx%d", width, height)

	windowDC, _, _ := procGetDC.Call(hwnd)
	if windowDC == 0 {
		t.Fatal("拿不到窗口 DC")
	}
	defer procReleaseDC.Call(hwnd, windowDC)
	memoryDC, _, _ := procCreateCompatibleDC.Call(windowDC)
	if memoryDC == 0 {
		t.Fatal("建不了内存 DC")
	}
	defer procDeleteDC.Call(memoryDC)
	bitmap, _, _ := procCreateCompatibleBitmap.Call(windowDC, uintptr(width), uintptr(height))
	if bitmap == 0 {
		t.Fatal("建不了位图")
	}
	defer procDeleteObject.Call(bitmap)
	procSelectObject.Call(memoryDC, bitmap)

	// PrintWindow 让窗口把自己画到内存 DC 上（PW_RENDERFULLCONTENT = 2）
	if drawn, _, _ := procPrintWindow.Call(hwnd, memoryDC, 2); drawn == 0 {
		// 少数情况下 PrintWindow 不干活，退回位块传送（能拿到画面，但可能没有客户区之外的合成）
		const srccopy = 0x00CC0020
		procBitBlt.Call(memoryDC, 0, 0, uintptr(width), uintptr(height), windowDC, 0, 0, srccopy)
	}

	info := bitmapInfo{}
	info.Header.Size = uint32(unsafe.Sizeof(info.Header))
	info.Header.Width = int32(width)
	// 负高度 = 自上而下，省得再翻转一遍
	info.Header.Height = -int32(height)
	info.Header.Planes = 1
	info.Header.BitCount = 32
	info.Header.Compression = 0 // BI_RGB

	pixels := make([]byte, width*height*4)
	scanned, _, _ := procGetDIBits.Call(memoryDC, bitmap, 0, uintptr(height),
		uintptr(unsafe.Pointer(&pixels[0])), uintptr(unsafe.Pointer(&info)), 0)
	if scanned == 0 {
		t.Fatal("GetDIBits 没取到像素")
	}

	// BGRA -> RGBA
	canvas := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			offset := (y*width + x) * 4
			canvas.Set(x, y, color.RGBA{R: pixels[offset+2], G: pixels[offset+1], B: pixels[offset], A: 255})
		}
	}

	out := filepath.Join(os.TempDir(), "settings-window.png")
	file, err := os.Create(out)
	if err != nil {
		t.Fatal(err)
	}
	if err := png.Encode(file, canvas); err != nil {
		file.Close()
		t.Fatal(err)
	}
	file.Close()
	t.Logf("截图: %s", out)

	// 顺手做两个廉价但有用的断言：画面不能是纯色（那说明什么都没画上去）
	distinct := map[uint32]int{}
	for y := 0; y < height; y += 3 {
		for x := 0; x < width; x += 3 {
			offset := (y*width + x) * 4
			key := uint32(pixels[offset])<<16 | uint32(pixels[offset+1])<<8 | uint32(pixels[offset+2])
			distinct[key]++
		}
	}
	t.Logf("画面里有 %d 种颜色", len(distinct))
	if len(distinct) < 8 {
		t.Fatalf("画面只有 %d 种颜色，像是没画上东西", len(distinct))
	}
}
