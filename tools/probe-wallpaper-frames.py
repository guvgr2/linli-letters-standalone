# 直接抓**壁纸窗口自己**的画面（PrintWindow + PW_RENDERFULLCONTENT）。
#
# ★ 为什么不能用全屏截图比差：前台可能开着别的窗口（这次就是用户正在玩游戏），
#   全屏差分量到的是**那个游戏在动**，跟壁纸在不在播毫无关系。
#   PrintWindow 要的是这个窗口自己的内容，被谁盖住都不影响。
import ctypes
import ctypes.wintypes as wt
import sys
import time
from PIL import Image, ImageChops, ImageStat

u = ctypes.windll.user32
g = ctypes.windll.gdi32
u.GetParent.restype = ctypes.c_void_p
u.GetParent.argtypes = [ctypes.c_void_p]
u.GetClassNameW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
u.PrintWindow.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint]
u.GetWindowRect.argtypes = [ctypes.c_void_p, ctypes.POINTER(wt.RECT)]
u.IsWindowVisible.argtypes = [ctypes.c_void_p]

EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)


def cls(h):
    b = ctypes.create_unicode_buffer(256)
    u.GetClassNameW(ctypes.c_void_p(h), b, 256)
    return b.value


def owner(h):
    p = wt.DWORD()
    u.GetWindowThreadProcessId(ctypes.c_void_p(h), ctypes.byref(p))
    return p.value


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wt.DWORD), ("biWidth", wt.LONG), ("biHeight", wt.LONG),
                ("biPlanes", wt.WORD), ("biBitCount", wt.WORD), ("biCompression", wt.DWORD),
                ("biSizeImage", wt.DWORD), ("biXPelsPerMeter", wt.LONG), ("biYPelsPerMeter", wt.LONG),
                ("biClrUsed", wt.DWORD), ("biClrImportant", wt.DWORD)]


def grab_window(hwnd):
    r = wt.RECT()
    u.GetWindowRect(ctypes.c_void_p(hwnd), ctypes.byref(r))
    w, h = r.right - r.left, r.bottom - r.top
    hdc = u.GetWindowDC(ctypes.c_void_p(hwnd))
    mem = g.CreateCompatibleDC(hdc)
    bmp = g.CreateCompatibleBitmap(hdc, w, h)
    g.SelectObject(mem, bmp)
    ok = u.PrintWindow(ctypes.c_void_p(hwnd), mem, 2)   # 2 = PW_RENDERFULLCONTENT
    bi = BITMAPINFOHEADER()
    bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bi.biWidth, bi.biHeight = w, -h
    bi.biPlanes, bi.biBitCount, bi.biCompression = 1, 32, 0
    buf = ctypes.create_string_buffer(w * h * 4)
    got = g.GetDIBits(mem, bmp, 0, h, buf, ctypes.byref(bi), 0)
    img = Image.frombuffer("RGBA", (w, h), buf, "raw", "BGRA", 0, 1).convert("RGB")
    g.DeleteObject(bmp)
    g.DeleteDC(mem)
    u.ReleaseDC(ctypes.c_void_p(hwnd), hdc)
    return ok, got, img


pid = int(sys.argv[1])
tops = []


@EnumProc
def each_top(h, _l):
    if cls(h) in ("Progman", "WorkerW"):
        tops.append(h)
    return True


u.EnumWindows(each_top, 0)

ours = []


@EnumProc
def each_child(h, _l):
    if owner(h) == pid:
        full = []
        cur = ctypes.c_void_p(h)
        for _ in range(8):
            cur = ctypes.c_void_p(u.GetParent(cur))
            if not cur.value:
                break
            full.append(f"{cls(cur)}({hex(cur.value)})")
        ours.append({"hwnd": h, "class": cls(h), "visible": bool(u.IsWindowVisible(ctypes.c_void_p(h))), "chain": full})
    return True


for h in tops:
    u.EnumChildWindows(h, each_child, 0)

print(f"桌面层里属于 PID {pid} 的窗口：{len(ours)}")
for o in ours:
    print(f"   {o['hwnd']:#x} {o['class']!r} visible={o['visible']} 祖先链={' ← '.join(o['chain']) or '（无）'}")

if not ours:
    sys.exit(1)

target = ours[0]["hwnd"]
frames = []
for i in range(3):
    ok, got, img = grab_window(target)
    print(f"   第 {i + 1} 帧：PrintWindow={ok} 行数={got} 尺寸={img.size} 平均色={[round(x) for x in ImageStat.Stat(img).mean]}")
    frames.append(img)
    if i < 2:
        time.sleep(1.5)

for name, (a, b) in (("1→2", (frames[0], frames[1])), ("2→3", (frames[1], frames[2]))):
    st = ImageStat.Stat(ImageChops.difference(a, b))
    print(f"   {name}: 平均差 {sum(st.mean) / 3:.2f} / 峰值 {max(st.extrema[i][1] for i in range(3))}")

frames[0].save("E:/linli-letters/analysis/wallpaper-window.png")
print("窗口画面存到 analysis/wallpaper-window.png")
