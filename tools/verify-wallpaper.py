# 真机验证：桌面壁纸有没有真的铺到 Windows 桌面那一层、画面是不是真的在动。
#
# 用法：verify-wallpaper.py <外壳PID>
#   · ★ 被 SetParent 挂上去之后，那个窗口**不再是顶层窗口** —— EnumWindows 枚举不到它。
#     所以要从桌面那一层往下找：Progman / WorkerW 的所有子孙窗口里，谁的 PID 是我们。
#     （第一版就是漏在这：明明铺上了，却报"没挂上"。）
#   · 连抓三张全屏（隔 1.5 秒）比一块区域，确认画面在动 —— "在播"只有像素能证明。
import sys, time, ctypes, ctypes.wintypes as wt
from PIL import ImageChops, ImageStat
from PIL import ImageGrab

pid = int(sys.argv[1])
u = ctypes.windll.user32

EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)


def cls(h):
    b = ctypes.create_unicode_buffer(256)
    u.GetClassNameW(h, b, 256)
    return b.value


def owner(h):
    p = wt.DWORD()
    u.GetWindowThreadProcessId(h, ctypes.byref(p))
    return p.value


def chain(h):
    out = []
    while h:
        h = u.GetParent(h)
        if not h:
            break
        out.append(f"{cls(h)}({h:#x})")
    return out


# 1) 我们的窗口：从桌面那一层往下枚举子孙
hits = []
top = []


@EnumProc
def each_top(h, _l):
    if cls(h) in ("Progman", "WorkerW"):
        top.append(h)
    return True


u.EnumWindows(each_top, 0)


@EnumProc
def each_child(h, _l):
    if owner(h) == pid:
        hits.append({"hwnd": h, "class": cls(h), "visible": bool(u.IsWindowVisible(h)), "parents": chain(h)})
    return True


for h in top:
    u.EnumChildWindows(h, each_child, 0)

print(f"-- 桌面那一层（Progman/WorkerW）里属于 PID {pid} 的窗口 --")
for f in hits:
    print(f"   hwnd={f['hwnd']:#x} class={f['class']!r} visible={f['visible']}")
    print(f"        祖先链：{' ← '.join(f['parents']) or '（无）'}")
print(f"\n铺上去的窗口数：{len(hits)}  → {'成' if hits else '没成'}")

# 2) 画面在不在动
W, H = u.GetSystemMetrics(0), u.GetSystemMetrics(1)
box = (int(W * 0.55), int(H * 0.12), int(W * 0.95), int(H * 0.55))
shots = []
for i in range(3):
    shots.append(ImageGrab.grab().convert("RGB").crop(box))
    print(f"   抓屏 {i + 1}/3 （区域 {box}）")
    if i < 2:
        time.sleep(1.5)


def diff(a, b):
    st = ImageStat.Stat(ImageChops.difference(a, b))
    return sum(st.mean) / 3, max(st.extrema[i][1] for i in range(3))


for name, (a, b) in (("A→B", (shots[0], shots[1])), ("B→C", (shots[1], shots[2]))):
    mean, peak = diff(a, b)
    print(f"   {name}: 平均差 {mean:.2f} / 峰值 {peak}")

shots[0].save("E:/linli-letters/analysis/wallpaper-shot.png")
print("\n样张存到 analysis/wallpaper-shot.png")
