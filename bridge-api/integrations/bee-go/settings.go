//go:build windows

package main

import (
	"fmt"
	"os"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

const (
	// 交流群：显示在设置窗口顶部。数字与链接分开写，链接用于将来的点击跳转。
	communityGroup = "1121395453"
	communityLink  = "https://qm.qq.com/q/wxW7hgC6sM"

	settingsBaseWidth       = 680
	settingsBaseHeight      = 472
	settingsBasePadding     = 24
	settingsBaseTitleHeight = 40
)

type settingsLayout struct {
	ClientWidth  int
	ClientHeight int
	Padding      int
	TitleHeight  int
	Resizable    bool
	Maximizable  bool
}

// settingsCardBox 是「一张检测卡片 + 它在窗口里的位置」。
//
// 位置放在模型里而不是绘制时算：命中测试要用同一份坐标，
// 两处各算一遍迟早会差几个像素 —— 那种偏差表现为「按钮点不准」，很难查。
type settingsCardBox struct {
	Card settingsCard
	Rect rect
}

// settingsButton 是窗口底部的按钮。
type settingsButton struct {
	Label  string
	Action string
	Rect   rect
}

type settingsModel struct {
	Title string
	// Community 是交流群号，画在标题下方 —— 用户要在设置窗口里就能看到它
	Community string
	Status    string
	Level     string
	Cards     []settingsCardBox
	// Counters 是卡片下面那一行：入站/投递/游标/运行时长
	Counters string
	// Channel 是再下面一行：走在哪条通道上、正文是什么形态
	Channel string
	// Footer 是底部那句：正常时是一句说明，出错时是最近那条错误
	Footer  string
	Buttons []settingsButton
}

// levelColor 把状态等级变成颜色。三张卡片和顶部状态条共用它，
// 这样「什么是正常」在窗口里只有一个定义。
func levelColor(level string) (byte, byte, byte) {
	switch level {
	case "warn":
		return 217, 119, 6
	case "error":
		return 220, 38, 38
	default:
		return 18, 183, 106
	}
}

// statusColor 返回顶部状态圆点的颜色。
func (model settingsModel) statusColor() (byte, byte, byte) { return levelColor(model.Level) }

// statusTextColor 是状态那行字的颜色，比圆点深一档才看得清。
func (model settingsModel) statusTextColor() uintptr {
	r, g, b := levelColor(model.Level)
	return rgb(r*3/4, g*3/4, b*3/4)
}

func scaleDPI(value, dpi int) int {
	if dpi <= 0 {
		dpi = 96
	}
	return (value*dpi + 48) / 96
}

func defaultSettingsLayout(dpi int) settingsLayout {
	return settingsLayout{
		ClientWidth:  scaleDPI(settingsBaseWidth, dpi),
		ClientHeight: scaleDPI(settingsBaseHeight, dpi),
		Padding:      scaleDPI(settingsBasePadding, dpi),
		TitleHeight:  scaleDPI(settingsBaseTitleHeight, dpi),
		Resizable:    false,
		Maximizable:  false,
	}
}

func centeredPosition(screenWidth, screenHeight, windowWidth, windowHeight int) (int, int) {
	x := (screenWidth - windowWidth) / 2
	y := (screenHeight - windowHeight) / 2
	if x < 0 {
		x = 0
	}
	if y < 0 {
		y = 0
	}
	return x, y
}

// defaultSettingsModel 组装窗口内容。
//
// 刻意**不缓存**：这个窗口的用处就是「点开看一眼现在什么情况」，
// 缓存住只会显示过期状态。每次重绘重新取一次，代价只是一次加锁读结构体。
// defaultSettingsModel 组装窗口内容与布局。
//
// 刻意**不缓存**：这个窗口的用处就是「点开看一眼现在什么情况」，
// 缓存住只会显示过期状态。每次重绘重新取一次，代价只是几次加锁读结构体。
func defaultSettingsModel(dpi int) settingsModel {
	layout := defaultSettingsLayout(dpi)
	padding := layout.Padding
	contentWidth := layout.ClientWidth - 2*padding
	gap := scaleDPI(14, dpi)

	// 三张卡片横排
	cardWidth := (contentWidth - 2*gap) / 3
	cardHeight := scaleDPI(92, dpi)
	cardTop := padding + scaleDPI(104, dpi)
	cards := bridge.settingsCards()
	boxes := make([]settingsCardBox, 0, len(cards))
	for index, card := range cards {
		left := padding + index*(cardWidth+gap)
		boxes = append(boxes, settingsCardBox{
			Card: card,
			Rect: rect{int32(left), int32(cardTop), int32(left + cardWidth), int32(cardTop + cardHeight)},
		})
	}

	// 底部是两个按钮：主按钮打开运营后台，次按钮开日志目录
	buttonWidth := scaleDPI(146, dpi)
	buttonHeight := scaleDPI(38, dpi)
	buttonTop := layout.ClientHeight - padding - buttonHeight - scaleDPI(30, dpi)
	buttons := []settingsButton{
		{
			Label: "打开运营后台", Action: "admin",
			Rect: rect{int32(padding), int32(buttonTop), int32(padding + buttonWidth), int32(buttonTop + buttonHeight)},
		},
		{
			Label: "打开日志目录", Action: "logs",
			Rect: rect{int32(padding + buttonWidth + gap), int32(buttonTop), int32(padding + 2*buttonWidth + gap), int32(buttonTop + buttonHeight)},
		},
	}

	return settingsModel{
		Title:     PluginName + " 设置",
		Community: "交流群 " + communityGroup + "　" + communityLink,
		Status:    bridge.statusLine(),
		Level:     bridge.healthLevel(),
		Cards:     boxes,
		Counters:  bridge.countersLine(),
		Channel:   bridge.channelLine(),
		Footer:    bridge.footerLine(),
		Buttons:   buttons,
	}
}

const (
	synchronize       = 0x00100000
	wmDestroy         = 0x0002
	wmClose           = 0x0010
	wmPaint           = 0x000f
	wmEraseBkgnd      = 0x0014
	wmGetMinMaxInfo   = 0x0024
	wmLeftButtonDown  = 0x0201
	swShow            = 5
	swRestore         = 9
	wsExTopmost       = 0x00000008
	wsOverlapped      = 0x00000000
	wsCaption         = 0x00c00000
	wsSysMenu         = 0x00080000
	wsMinimizeBox     = 0x00020000
	cwUseDefault      = 0x80000000
	colorWindow       = 5
	idiApplication    = 32512
	idcArrow          = 32512
	dtLeft            = 0x00000000
	dtCenter          = 0x00000001
	dtVCenter         = 0x00000004
	dtSingleLine      = 0x00000020
	dtWordBreak       = 0x00000010
	dtNoPrefix        = 0x00000800
	transparent       = 1
	fwNormal          = 400
	fwSemiBold        = 600
	logPixelsX        = 88
	smCxScreen        = 0
	mbOK              = 0
	mbIconInformation = 0x40
	swpNoSize         = 0x0001
	swpNoMove         = 0x0002
	swpShowWindow     = 0x0040
)

var hwndTopmost = ^uintptr(0)

var (
	kernel32                = syscall.NewLazyDLL("kernel32.dll")
	user32                  = syscall.NewLazyDLL("user32.dll")
	gdi32                   = syscall.NewLazyDLL("gdi32.dll")
	gdiplus                 = syscall.NewLazyDLL("gdiplus.dll")
	shell32                 = syscall.NewLazyDLL("shell32.dll")
	procRegisterClassExW    = user32.NewProc("RegisterClassExW")
	procUnregisterClassW    = user32.NewProc("UnregisterClassW")
	procDestroyWindow       = user32.NewProc("DestroyWindow")
	procCreateWindowExW     = user32.NewProc("CreateWindowExW")
	procDefWindowProcW      = user32.NewProc("DefWindowProcW")
	procShowWindow          = user32.NewProc("ShowWindow")
	procUpdateWindow        = user32.NewProc("UpdateWindow")
	procSetForegroundWindow = user32.NewProc("SetForegroundWindow")
	procSetWindowPos        = user32.NewProc("SetWindowPos")
	procGetWindowPlacement  = user32.NewProc("GetWindowPlacement")
	procIsIconic            = user32.NewProc("IsIconic")
	procIsWindow            = user32.NewProc("IsWindow")
	procIsWindowVisible     = user32.NewProc("IsWindowVisible")
	procInvalidateRect      = user32.NewProc("InvalidateRect")
	procPostMessageW        = user32.NewProc("PostMessageW")
	procGetMessageW         = user32.NewProc("GetMessageW")
	procTranslateMessage    = user32.NewProc("TranslateMessage")
	procDispatchMessageW    = user32.NewProc("DispatchMessageW")
	procPostQuitMessage     = user32.NewProc("PostQuitMessage")
	procBeginPaint          = user32.NewProc("BeginPaint")
	procEndPaint            = user32.NewProc("EndPaint")
	procGetClientRect       = user32.NewProc("GetClientRect")
	procAdjustWindowRectEx  = user32.NewProc("AdjustWindowRectEx")
	procLoadCursorW         = user32.NewProc("LoadCursorW")
	procLoadIconW           = user32.NewProc("LoadIconW")
	procGetSystemMetrics    = user32.NewProc("GetSystemMetrics")
	procDrawTextW           = user32.NewProc("DrawTextW")
	procFillRect            = user32.NewProc("FillRect")
	procGetDC               = user32.NewProc("GetDC")
	procReleaseDC           = user32.NewProc("ReleaseDC")
	procGetDeviceCaps       = gdi32.NewProc("GetDeviceCaps")
	procGetModuleHandleW    = kernel32.NewProc("GetModuleHandleW")
	openProcess             = kernel32.NewProc("OpenProcess")
	waitSingleObject        = kernel32.NewProc("WaitForSingleObject")
	closeHandle             = kernel32.NewProc("CloseHandle")
	procCreateFontW         = gdi32.NewProc("CreateFontW")
	procSelectObject        = gdi32.NewProc("SelectObject")
	procDeleteObject        = gdi32.NewProc("DeleteObject")
	procSetTextColor        = gdi32.NewProc("SetTextColor")
	procSetBkMode           = gdi32.NewProc("SetBkMode")
	procCreateSolidBrush    = gdi32.NewProc("CreateSolidBrush")
	procGdiplusStartup      = gdiplus.NewProc("GdiplusStartup")
	procGdiplusShutdown     = gdiplus.NewProc("GdiplusShutdown")
	procGdipCreateFromHDC   = gdiplus.NewProc("GdipCreateFromHDC")
	procGdipDeleteGraphics  = gdiplus.NewProc("GdipDeleteGraphics")
	procGdipSetSmoothing    = gdiplus.NewProc("GdipSetSmoothingMode")
	procGdipCreateSolidFill = gdiplus.NewProc("GdipCreateSolidFill")
	procGdipDeleteBrush     = gdiplus.NewProc("GdipDeleteBrush")
	procGdipFillRectangleI  = gdiplus.NewProc("GdipFillRectangleI")
	procGdipFillEllipseI    = gdiplus.NewProc("GdipFillEllipseI")
	procShellExecuteW       = shell32.NewProc("ShellExecuteW")
)

type point struct{ X, Y int32 }
type rect struct{ Left, Top, Right, Bottom int32 }
type windowPlacement struct {
	Length, Flags, ShowCmd   uint32
	MinPosition, MaxPosition point
	NormalPosition           rect
}
type msg struct {
	HWnd, Message, WParam, LParam uintptr
	Time                          uint32
	Pt                            point
	Private                       uint32
}
type paintStruct struct {
	HDC, Erase, Restore, IncUpdate uintptr
	Paint                          rect
	Reserved                       [32]byte
}
type wndClassEx struct {
	Size, Style          uint32
	WndProc, ClsExtra    uintptr
	WndExtra, Instance   uintptr
	Icon, Cursor         uintptr
	Background, MenuName uintptr
	ClassName, IconSmall uintptr
}
type gdiplusStartupInput struct {
	Version                  uint32
	Debug                    uintptr
	SuppressBackgroundThread int32
	SuppressExternalCodecs   int32
}
type minMaxInfo struct {
	Reserved, MaxSize, MaxPosition, MinTrackSize, MaxTrackSize point
}

var settingsNative = struct {
	sync.Mutex
	hwnd     uintptr
	done     chan struct{}
	closing  bool
	classSeq uint32
}{}

// settingsButtons 记下最后一次绘制时按钮的位置。
//
// 绘制与命中测试共用同一份坐标 —— 这是「按钮点不准」这类问题的唯一预防办法：
// 两处各算一遍，迟早差几个像素，而那种偏差没有任何报错。
var settingsButtons = struct {
	sync.Mutex
	items []settingsButton
}{}

var settingsWndProc = syscall.NewCallback(settingsWindowProc)

func showSettingsWindow() {
	settingsNative.Lock()
	hwnd := settingsNative.hwnd
	settingsNative.Unlock()

	if hwnd != 0 {
		// 先验一次句柄还有效没。
		//
		// 失效的句柄是「点设置没反应」的常见成因：窗口已经销毁，而记录没跟上，
		// 后面那些 ShowWindow / SetWindowPos 全部作用在一个不存在的窗口上 ——
		// 每个调用都"成功"，只是什么也没发生。
		if valid, _, _ := procIsWindow.Call(hwnd); valid == 0 {
			bridge.diagLog("设置窗口：记录的句柄 %d 已失效，按没有窗口处理", hwnd)
			settingsNative.Lock()
			if settingsNative.hwnd == hwnd {
				settingsNative.hwnd = 0
			}
			settingsNative.Unlock()
		} else {
			restoreSettingsWindow(hwnd)
			return
		}
	}

	settingsNative.Lock()
	if settingsNative.done != nil || settingsNative.closing {
		settingsNative.Unlock()
		return
	}
	settingsNative.done = make(chan struct{})
	done := settingsNative.done
	settingsNative.Unlock()
	go settingsWindowThread(done)
}

// restoreSettingsWindow 把已经存在的窗口叫回前台，并让它重画一遍。
//
// 两处都不是多余的：
//
//  1. **必须先 ShowWindow(SW_RESTORE)**。最小化的窗口不会因为
//     SetWindowPos 带了 SWP_SHOWWINDOW 就还原（这是 Windows 的规矩），
//     漏掉这一步的表现就是「最小化之后再点设置，窗口不见了」。
//  2. **必须强制重绘**。窗口里显示的是活状态（连的哪个地址、检索到哪一步、
//     最近什么错），不重绘的话用户看到的永远是打开那一刻的快照 ——
//     表现就是「一直停在检索中」，哪怕后台早就查完了。
func restoreSettingsWindow(hwnd uintptr) {
	if iconic, _, _ := procIsIconic.Call(hwnd); iconic != 0 {
		procShowWindow.Call(hwnd, swRestore)
	}
	procShowWindow.Call(hwnd, swShow)
	procSetWindowPos.Call(hwnd, hwndTopmost, 0, 0, 0, 0, swpNoMove|swpNoSize|swpShowWindow)
	procSetForegroundWindow.Call(hwnd)
	procInvalidateRect.Call(hwnd, 0, 1)
	procUpdateWindow.Call(hwnd)
	bridge.diagLog("设置窗口：已恢复并重绘（hwnd=%d）", hwnd)
}

// requestSettingsRepaint 让已经开着的设置窗口重画一遍。
//
// 这一条是「窗口一直停在检索中」的正解：窗口里的内容是**活状态**
// （地址、检索到哪一步、投递计数、最近错误），但窗口只在收到 WM_PAINT 时才更新。
// 用户打开窗口的那一刻如果检索还没结束，他看到的快照就永远不会变 ——
// 哪怕后台两百毫秒后就查完了。所以状态一变就主动叫它一声。
//
// InvalidateRect 可以从别的线程调（Windows 会把它投递到窗口线程），
// 所以后台 goroutine 直接调是安全的。
func requestSettingsRepaint() {
	settingsNative.Lock()
	hwnd := settingsNative.hwnd
	settingsNative.Unlock()
	if hwnd == 0 {
		return
	}
	procInvalidateRect.Call(hwnd, 0, 1)
}

func closeSettingsWindow() {
	settingsNative.Lock()
	done, hwnd := settingsNative.done, settingsNative.hwnd
	if done == nil {
		settingsNative.Unlock()
		return
	}
	settingsNative.closing = true
	settingsNative.Unlock()
	if hwnd != 0 {
		procPostMessageW.Call(hwnd, wmClose, 0, 0)
	}
	<-done
}

func settingsWindowThread(done chan struct{}) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer func() {
		settingsNative.Lock()
		settingsNative.hwnd = 0
		settingsNative.done = nil
		settingsNative.closing = false
		close(done)
		settingsNative.Unlock()
	}()

	instance, _, _ := procGetModuleHandleW.Call(0)
	// 类名带自增序号。
	//
	// RegisterClassExW 对**同名类**的第二次调用会直接失败（返回 0），
	// 而那时窗口根本建不出来、也没有任何可见的提示 —— 表现就是「设置窗口再也打不开」。
	// 只要有一次 UnregisterClassW 没成功（例如窗口还没完全销毁就去注销），
	// 那个类名就被永久占住了。换个名字的成本是零，所以每次都用一个新的。
	settingsNative.Lock()
	settingsNative.classSeq++
	seq := settingsNative.classSeq
	settingsNative.Unlock()
	classNameText := fmt.Sprintf("BeeGoSettingsWindow-%d", seq)
	className, _ := syscall.UTF16PtrFromString(classNameText)
	title, _ := syscall.UTF16PtrFromString(PluginName + " 设置")
	cursor, _, _ := procLoadCursorW.Call(0, idcArrow)
	icon, _, _ := procLoadIconW.Call(0, idiApplication)
	class := wndClassEx{Size: uint32(unsafe.Sizeof(wndClassEx{})), WndProc: settingsWndProc, Instance: instance, Icon: icon, Cursor: cursor, Background: colorWindow + 1, ClassName: uintptr(unsafe.Pointer(className)), IconSmall: icon}
	atom, _, _ := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&class)))
	if atom == 0 {
		bridge.diagLog("设置窗口：注册窗口类 %s 失败（窗口不会出现）", classNameText)
		return
	}
	defer procUnregisterClassW.Call(uintptr(unsafe.Pointer(className)), instance)

	dpi := settingsDPI()
	layout := defaultSettingsLayout(dpi)
	style := uintptr(wsOverlapped | wsCaption | wsSysMenu | wsMinimizeBox)
	windowRect := rect{Right: int32(layout.ClientWidth), Bottom: int32(layout.ClientHeight)}
	procAdjustWindowRectEx.Call(uintptr(unsafe.Pointer(&windowRect)), style, 0, 0)
	width, height := int(windowRect.Right-windowRect.Left), int(windowRect.Bottom-windowRect.Top)
	screenW, _, _ := procGetSystemMetrics.Call(smCxScreen)
	screenH, _, _ := procGetSystemMetrics.Call(1)
	x, y := centeredPosition(int(screenW), int(screenH), width, height)
	hwnd, _, _ := procCreateWindowExW.Call(wsExTopmost, uintptr(unsafe.Pointer(className)), uintptr(unsafe.Pointer(title)), style, uintptr(x), uintptr(y), uintptr(width), uintptr(height), 0, 0, instance, 0)
	if hwnd == 0 {
		bridge.diagLog("设置窗口：CreateWindowExW 失败（类 %s）", classNameText)
		return
	}
	bridge.diagLog("设置窗口：已创建（hwnd=%d，类 %s）", hwnd, classNameText)
	settingsNative.Lock()
	settingsNative.hwnd = hwnd
	settingsNative.Unlock()
	procShowWindow.Call(hwnd, swShow)
	procSetWindowPos.Call(hwnd, hwndTopmost, 0, 0, 0, 0, swpNoMove|swpNoSize|swpShowWindow)
	procSetForegroundWindow.Call(hwnd)
	procUpdateWindow.Call(hwnd)
	var message msg
	for {
		result, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if int32(result) <= 0 {
			break
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&message)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&message)))
	}
}

func settingsDPI() int {
	dc, _, _ := procGetDC.Call(0)
	if dc == 0 {
		return 96
	}
	defer procReleaseDC.Call(0, dc)
	dpi, _, _ := procGetDeviceCaps.Call(dc, logPixelsX)
	if dpi == 0 {
		return 96
	}
	return int(dpi)
}

func settingsWindowProc(hwnd uintptr, message uint32, wparam, lparam uintptr) uintptr {
	switch message {
	case wmEraseBkgnd:
		return 1
	case wmGetMinMaxInfo:
		info := *(**minMaxInfo)(unsafe.Pointer(&lparam))
		// 尺寸**从布局常量算**，不要去问 GetWindowPlacement。
		//
		// 问它会踩一个很难看的坑，而且现象完全不指向原因：窗口最小化时
		// GetWindowPlacement 返回的 NormalPosition 是**最小化之后**的小尺寸
		//（本机实测 183x0），于是"最小尺寸限制"被设成那么一点，
		// 还原时窗口就永远缩成一条 —— 看着像窗口没了，其实只是小得只剩标题栏。
		//
		// 这个窗口本来就是固定尺寸（不可缩放），用常量算既准确、又不受窗口当前状态影响。
		dpi := settingsDPI()
		layout := defaultSettingsLayout(dpi)
		style := uintptr(wsOverlapped | wsCaption | wsSysMenu | wsMinimizeBox)
		windowRect := rect{Right: int32(layout.ClientWidth), Bottom: int32(layout.ClientHeight)}
		procAdjustWindowRectEx.Call(uintptr(unsafe.Pointer(&windowRect)), style, 0, 0)
		width := int(windowRect.Right - windowRect.Left)
		height := int(windowRect.Bottom - windowRect.Top)
		if width > 0 && height > 0 {
			info.MinTrackSize = point{int32(width), int32(height)}
			info.MaxTrackSize = point{int32(width), int32(height)}
		}
		return 0
	case wmPaint:
		paintSettings(hwnd)
		return 0
	case wmLeftButtonDown:
		// lParam 的低 16 位是 x、高 16 位是 y（都是 int16，要按有符号解）
		x := int32(int16(lparam & 0xffff))
		y := int32(int16((lparam >> 16) & 0xffff))
		handleSettingsClick(x, y)
		return 0
	case wmClose:
		procDestroyWindow.Call(hwnd)
		return 0
	case wmDestroy:
		procPostQuitMessage.Call(0)
		return 0
	}
	result, _, _ := procDefWindowProcW.Call(hwnd, uintptr(message), wparam, lparam)
	return result
}

func paintSettings(hwnd uintptr) {
	var ps paintStruct
	hdc, _, _ := procBeginPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
	if hdc == 0 {
		return
	}
	defer procEndPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
	var client rect
	procGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&client)))
	dpi := settingsDPI()
	layout := defaultSettingsLayout(dpi)
	model := defaultSettingsModel(dpi)

	background, _, _ := procCreateSolidBrush.Call(rgb(243, 245, 249))
	procFillRect.Call(hdc, uintptr(unsafe.Pointer(&client)), background)
	procDeleteObject.Call(background)

	// ---- GDI+：卡片底、按钮底、状态圆点 ----
	var token, graphics, cardBrush, accentBrush, statusBrush uintptr
	input := gdiplusStartupInput{Version: 1}
	started, _, _ := procGdiplusStartup.Call(uintptr(unsafe.Pointer(&token)), uintptr(unsafe.Pointer(&input)), 0)
	if started == 0 {
		procGdipCreateFromHDC.Call(hdc, uintptr(unsafe.Pointer(&graphics)))
		procGdipSetSmoothing.Call(graphics, 4)
		procGdipCreateSolidFill.Call(argb(255, 255, 255, 255), uintptr(unsafe.Pointer(&cardBrush)))
		procGdipCreateSolidFill.Call(argb(255, 99, 102, 241), uintptr(unsafe.Pointer(&accentBrush)))
		dotR, dotG, dotB := model.statusColor()
		procGdipCreateSolidFill.Call(argb(255, dotR, dotG, dotB), uintptr(unsafe.Pointer(&statusBrush)))

		for _, box := range model.Cards {
			width := box.Rect.Right - box.Rect.Left
			height := box.Rect.Bottom - box.Rect.Top
			procGdipFillRectangleI.Call(graphics, cardBrush, uintptr(box.Rect.Left), uintptr(box.Rect.Top), uintptr(width), uintptr(height))
			cardR, cardG, cardB := levelColor(box.Card.Level)
			var cardDot uintptr
			procGdipCreateSolidFill.Call(argb(255, cardR, cardG, cardB), uintptr(unsafe.Pointer(&cardDot)))
			procGdipFillEllipseI.Call(graphics, cardDot,
				uintptr(box.Rect.Left+int32(scaleDPI(16, dpi))), uintptr(box.Rect.Top+int32(scaleDPI(17, dpi))),
				uintptr(scaleDPI(9, dpi)), uintptr(scaleDPI(9, dpi)))
			procGdipDeleteBrush.Call(cardDot)
		}

		// 标题左侧那条短竖线：和状态圆点同色，让人一眼看出这里是"总的状态"
		procGdipFillRectangleI.Call(graphics, statusBrush,
			uintptr(layout.Padding), uintptr(layout.Padding+scaleDPI(7, dpi)),
			uintptr(scaleDPI(4, dpi)), uintptr(scaleDPI(22, dpi)))

		// 主按钮实心、次按钮留白 —— 一眼能分出哪个是主要动作
		if len(model.Buttons) > 0 {
			first := model.Buttons[0]
			procGdipFillRectangleI.Call(graphics, accentBrush,
				uintptr(first.Rect.Left), uintptr(first.Rect.Top),
				uintptr(first.Rect.Right-first.Rect.Left), uintptr(first.Rect.Bottom-first.Rect.Top))
		}
		for _, button := range model.Buttons[1:] {
			procGdipFillRectangleI.Call(graphics, cardBrush,
				uintptr(button.Rect.Left), uintptr(button.Rect.Top),
				uintptr(button.Rect.Right-button.Rect.Left), uintptr(button.Rect.Bottom-button.Rect.Top))
		}

		procGdipDeleteBrush.Call(statusBrush)
		procGdipDeleteBrush.Call(accentBrush)
		procGdipDeleteBrush.Call(cardBrush)
		procGdipDeleteGraphics.Call(graphics)
		procGdiplusShutdown.Call(token)
	}

	// ---- 文字统一用 GDI，放在 GDI+ 之后（否则会被后画的图形盖住）----
	fontName, _ := syscall.UTF16PtrFromString("Microsoft YaHei UI")
	titleFont, _, _ := procCreateFontW.Call(uintptr(-scaleDPI(20, dpi)), 0, 0, 0, fwSemiBold, 0, 0, 0, 1, 0, 0, 5, 0, uintptr(unsafe.Pointer(fontName)))
	valueFont, _, _ := procCreateFontW.Call(uintptr(-scaleDPI(15, dpi)), 0, 0, 0, fwSemiBold, 0, 0, 0, 1, 0, 0, 5, 0, uintptr(unsafe.Pointer(fontName)))
	bodyFont, _, _ := procCreateFontW.Call(uintptr(-scaleDPI(12, dpi)), 0, 0, 0, fwNormal, 0, 0, 0, 1, 0, 0, 5, 0, uintptr(unsafe.Pointer(fontName)))
	procSetBkMode.Call(hdc, transparent)

	padding := layout.Padding
	textLeft := int32(padding + scaleDPI(14, dpi))
	drawWindowText(hdc, model.Title,
		rect{textLeft, int32(padding), int32(layout.ClientWidth - padding), int32(padding + scaleDPI(30, dpi))},
		titleFont, rgb(16, 24, 40), dtLeft|dtVCenter|dtSingleLine|dtNoPrefix)
	drawWindowText(hdc, model.Status,
		rect{textLeft, int32(padding + scaleDPI(30, dpi)), int32(layout.ClientWidth - padding), int32(padding + scaleDPI(56, dpi))},
		bodyFont, model.statusTextColor(), dtLeft|dtVCenter|dtSingleLine|dtNoPrefix)

	// 交流群：挂在状态行下面。用户不用去翻 readme 就能看到它。
	drawWindowText(hdc, model.Community,
		rect{textLeft, int32(padding + scaleDPI(56, dpi)), int32(layout.ClientWidth - padding), int32(padding + scaleDPI(78, dpi))},
		bodyFont, rgb(102, 112, 133), dtLeft|dtVCenter|dtSingleLine|dtNoPrefix)

	for _, box := range model.Cards {
		left := box.Rect.Left
		top := box.Rect.Top
		inner := int32(scaleDPI(15, dpi))
		drawWindowText(hdc, box.Card.Label,
			rect{left + inner + int32(scaleDPI(14, dpi)), top + int32(scaleDPI(11, dpi)), box.Rect.Right - inner, top + int32(scaleDPI(30, dpi))},
			bodyFont, rgb(102, 112, 133), dtLeft|dtVCenter|dtSingleLine|dtNoPrefix)
		drawWindowText(hdc, box.Card.Value,
			rect{left + inner, top + int32(scaleDPI(32, dpi)), box.Rect.Right - inner, top + int32(scaleDPI(54, dpi))},
			valueFont, rgb(16, 24, 40), dtLeft|dtVCenter|dtSingleLine|dtNoPrefix)
		drawWindowText(hdc, box.Card.Note,
			rect{left + inner, top + int32(scaleDPI(56, dpi)), box.Rect.Right - inner, box.Rect.Bottom - int32(scaleDPI(8, dpi))},
			bodyFont, rgb(102, 112, 133), dtLeft|dtWordBreak|dtNoPrefix)
	}

	if len(model.Cards) > 0 {
		countersTop := model.Cards[0].Rect.Bottom + int32(scaleDPI(14, dpi))
		drawWindowText(hdc, model.Counters,
			rect{int32(padding), countersTop, int32(layout.ClientWidth - padding), countersTop + int32(scaleDPI(20, dpi))},
			bodyFont, rgb(71, 84, 103), dtLeft|dtVCenter|dtSingleLine|dtNoPrefix)

		// Footer 跟在计数行下面，**不贴窗口底边**。
		//
		// 贴底边画过一次，结果是只露出上半截 —— 截图里看得清清楚楚：
		// 窗口的客户区高度和"我以为的"差着边框那几像素，
		// 而紧贴边缘的文字正好被吃掉下半。放到中间这片空白里就没这问题，
		// 顺带把计数行与按钮之间那块空地也用上了。
		// 通道那一行夹在计数与 Footer 之间
		channelTop := countersTop + int32(scaleDPI(22, dpi))
		drawWindowText(hdc, model.Channel,
			rect{int32(padding), channelTop, int32(layout.ClientWidth - padding), channelTop + int32(scaleDPI(18, dpi))},
			bodyFont, rgb(52, 64, 84), dtLeft|dtVCenter|dtSingleLine|dtNoPrefix)

		footerTop := countersTop + int32(scaleDPI(46, dpi))
		drawWindowText(hdc, model.Footer,
			rect{int32(padding), footerTop, int32(layout.ClientWidth - padding), int32(layout.ClientHeight - padding - scaleDPI(56, dpi))},
			bodyFont, rgb(102, 112, 133), dtLeft|dtWordBreak|dtNoPrefix)
	}

	for index, button := range model.Buttons {
		color := rgb(255, 255, 255)
		if index > 0 {
			color = rgb(52, 64, 84)
		}
		drawWindowText(hdc, button.Label, button.Rect, valueFont, color, dtCenter|dtVCenter|dtSingleLine|dtNoPrefix)
	}

	if titleFont != 0 {
		procDeleteObject.Call(titleFont)
	}
	if valueFont != 0 {
		procDeleteObject.Call(valueFont)
	}
	if bodyFont != 0 {
		procDeleteObject.Call(bodyFont)
	}

	// 记下按钮位置供命中测试用。
	// 必须用绘制时那一份：另算一遍迟早差几个像素，表现成"按钮点不准"。
	settingsButtons.Lock()
	settingsButtons.items = model.Buttons
	settingsButtons.Unlock()
}

// handleSettingsClick 处理窗口里的点击。
//
// 只有两个动作，但它们的价值在于**把用户送到该去的地方**：
// 出问题时他不用去翻文档找后台地址、找 plugin_data 在哪。
func handleSettingsClick(x, y int32) {
	settingsButtons.Lock()
	action := ""
	for _, button := range settingsButtons.items {
		if x >= button.Rect.Left && x < button.Rect.Right && y >= button.Rect.Top && y < button.Rect.Bottom {
			action = button.Action
			break
		}
	}
	settingsButtons.Unlock()

	switch action {
	case "admin":
		url := bridge.adminURL()
		if url == "" {
			// 地址还没解析出来（内核还没起来）。说清楚，别让人以为按钮坏了。
			bridge.diagLog("设置窗口：运营后台地址还没有（内核尚未就绪），忽略这次点击")
			return
		}
		openInShell(url)
	case "logs":
		openInShell(bridge.dataDirectory())
	}
}

// openInShell 用系统默认程序打开一个 URL 或目录。
func openInShell(target string) {
	if strings.TrimSpace(target) == "" {
		bridge.diagLog("设置窗口：要打开的目标是空的，忽略")
		return
	}
	verb, _ := syscall.UTF16PtrFromString("open")
	file, _ := syscall.UTF16PtrFromString(target)
	if result, _, _ := procShellExecuteW.Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(file)), 0, 0, swShow); result <= 32 {
		// ShellExecuteW 的返回值 <= 32 表示失败（它不设置 GetLastError）
		bridge.diagLog("设置窗口：打不开 %s（ShellExecute 返回 %d）", target, result)
		return
	}
	bridge.diagLog("设置窗口：已请系统打开 %s", target)
}

func drawWindowText(hdc uintptr, text string, area rect, font uintptr, color uintptr, flags uintptr) {
	value, _ := syscall.UTF16PtrFromString(text)
	old, _, _ := procSelectObject.Call(hdc, font)
	procSetTextColor.Call(hdc, color)
	procDrawTextW.Call(hdc, uintptr(unsafe.Pointer(value)), ^uintptr(0), uintptr(unsafe.Pointer(&area)), flags)
	procSelectObject.Call(hdc, old)
}

func rgb(r, g, b byte) uintptr { return uintptr(uint32(r) | uint32(g)<<8 | uint32(b)<<16) }
func argb(a, r, g, b byte) uintptr {
	return uintptr(uint32(a)<<24 | uint32(r)<<16 | uint32(g)<<8 | uint32(b))
}

func startHostWatcher(hostPID uint32) {
	handle, _, _ := openProcess.Call(synchronize, 0, uintptr(hostPID))
	if handle == 0 {
		return
	}
	go func() {
		defer closeHandle.Call(handle)
		waitSingleObject.Call(handle, 0xffffffff)
		os.Exit(0)
	}()
}
