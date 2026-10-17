# 探桌面那一层（修好了：第二次枚举也要真的读新列表）。
# 逐个列出所有顶层 Progman / WorkerW：属于哪个进程、可见否、有哪些孩子。
# ★ 目的：这套"发 0x052C 把 WorkerW 拆出来"的做法在不同 Explorer 上不成立的情况很常见，
#   先看清这台机器的真实结构，再决定挂到哪儿。
import ctypes, ctypes.wintypes as wt, subprocess

u = ctypes.windll.user32
k32 = ctypes.windll.kernel32
EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)


def cls(h):
    b = ctypes.create_unicode_buffer(256)
    u.GetClassNameW(h, b, 256)
    return b.value


def kids(h):
    out = []
    c = u.FindWindowExW(h, None, None, None)
    while c:
        out.append(c)
        c = u.FindWindowExW(h, c, None, None)
    return out


def proc_of(h):
    pid = wt.DWORD()
    u.GetWindowThreadProcessId(h, ctypes.byref(pid))
    return pid.value


def snapshot():
    rows = []

    @EnumWindowsProc
    def each(h, _l):
        c = cls(h)
        if c in ("Progman", "WorkerW"):
            rows.append({"hwnd": h, "class": c, "pid": proc_of(h),
                         "visible": bool(u.IsWindowVisible(h)),
                         "kids": [(k, cls(k)) for k in kids(h)]})
        return True

    u.EnumWindows(each, 0)
    return rows


names = {}
out = subprocess.run(["tasklist", "/FO", "CSV", "/NH"], capture_output=True, text=True, encoding="gbk", errors="replace")
for line in out.stdout.splitlines():
    parts = [p.strip('"') for p in line.split('","')]
    if len(parts) >= 2:
        names[int(parts[1])] = parts[0]


def dump(tag, rows):
    print(f"\n===== {tag} =====")
    for r in rows:
        pn = names.get(r["pid"], "?")
        print(f"{r['hwnd']:#x} {r['class']:<8} pid={r['pid']:<6} {pn:<18} visible={r['visible']}")
        for k, kc in r["kids"]:
            print(f"      └ 子 {k:#x} {kc}")


dump("当前", snapshot())

progman = u.FindWindowW("Progman", None)
res = wt.LPVOID()
sent = u.SendMessageTimeoutW(progman, 0x052C, 0, 0, 0, 1000, ctypes.byref(res))
print(f"\n发 0x052C → {bool(sent)}（Progman={progman:#x}）")
dump("发完之后", snapshot())
