# 给"真渲染体检"用的假数据：几条信 + 两首入库曲。
# 写进隔离的 LINLI_DATA_DIR，不碰用户那一份。
import os
import sqlite3
import time
import uuid

DB = r"C:\Users\guvgr\AppData\Local\Temp\linli-render\data\letters.sqlite"
LIB = r"E:\linlimusic"

conn = sqlite3.connect(DB)
now = int(time.time())

# 列顺序：id, content, reply_text, origin, status, error, created_at, replied_at, is_read, trigger_kind
# ★ content 是 NOT NULL —— 她先写的那封 content 给空串，不是 NULL（照服务端的实际写法）。
letter_cols = [r[1] for r in conn.execute("PRAGMA table_info(letters)")]
letters = [
    (uuid.uuid4().hex, "今天路过那家旧书店，橱窗里摆着一本你提过的诗集。我站了一会儿，没进去。",
     "那本我也有。翻到中间那页的时候，会想起你说话的声音。", None, 4, None,
     now - 86400 * 2, now - 86400 * 2 + 900, 1, None),
    (uuid.uuid4().hex, "昨天把窗帘洗了，挂回去的时候发现颜色比记忆里淡。",
     "淡了才说明它陪了你很久。要不要我陪你去挑一块新的？", None, 4, None,
     now - 5400, now - 5400 + 700, 0, None),
    (uuid.uuid4().hex, "有点睡不着。", None, None, 1, None, now - 600, None, 1, None),
    (uuid.uuid4().hex, "",
     "你今天是不是很忙。我把想说的都写在信里了，等你有空再看。", "proactive", 4, None,
     now - 3600, now - 3600, 0, None),
]
placeholders = ",".join("?" * len(letter_cols))
conn.executemany(
    "INSERT INTO letters({}) VALUES({})".format(",".join(letter_cols), placeholders), letters)

song_cols = [r[1] for r in conn.execute("PRAGMA table_info(songs)")]
dirs = sorted(d for d in os.listdir(LIB) if d.lower().startswith(("solo", "playsing")))
sp = ",".join("?" * len(song_cols))
conn.execute("INSERT OR REPLACE INTO songs({}) VALUES({})".format(",".join(song_cols), sp),
             (dirs[0], "Solo · The Fading Stories", now))
conn.execute("INSERT OR REPLACE INTO songs({}) VALUES({})".format(",".join(song_cols), sp),
             (dirs[1], "PlaySing · Emberfire", now - 3600))
conn.commit()

print("letters 列：", letter_cols)
print("songs 列：", song_cols)
print("曲库目录数：", len(dirs), dirs[:2])
print("已写入 4 封信 + 2 首入库曲")
