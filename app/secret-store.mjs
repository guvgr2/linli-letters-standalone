// API Key 的 DPAPI 存取。
//
// 竞品那条值得抄的是「Key 用 DPAPI 按当前 Windows 用户加密，明确不进日志」——
// 我们只抄这个**做法**（Windows 原生 API，谁都能调），不抄他的代码。
//
// ★ 2026-10-19 改（七轮审查 F3）：明文**不再落任何临时文件**，只走管道。
//   旧做法是「明文写 %TEMP%\linli-in-<hex>.bin → 调 dpapi.ps1 → finally 里 rm」。
//   正常跑当然删得掉，但审查方在本机 %TEMP% 里真找到了 2026-10-18 02:20 的两份遗留
//   （`linli-in-…bin` 14 B，内容就是明文 Key）—— 进程被强杀 / 崩溃 / 断电时
//   `finally` 根本跑不到。所以现在：明文进子进程的 stdin、密文从 stdout 出来，
//   磁盘上从头到尾没有明文可残留。服务端启动时还会顺手扫一遍旧命名残留（见 sweepTempFiles）。
//
// ★ 密文带 `dpapi-v1:` 前缀。老库里存的是**裸十六进制**（ConvertFrom-SecureString 的输出）：
//   不加前缀就分不清"这是哪个方案的密文"，将来换算法只能靠猜。读的时候两种都认，
//   所以老用户的 Key 不会因为这次改动而失效。
//
// 明文承诺：Key 不写日志、不进诊断包、不进导出包、不随数据目录搬走。
// （换 Windows 用户或换机器后密文解不开 —— 这是预期行为，届时让用户重新填一次。）

import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

/** 密文版本前缀（不写进文件格式以外的任何地方）。 */
export const SECRET_PREFIX = "dpapi-v1:";

/**
 * ★ 给子进程一份**干净**的环境：把 `PSModulePath` 整个摘掉。
 *
 *   这是 2026-10-18 实测出来的坑，不是防御性编程。我们调的永远是 `powershell.exe`
 *   （Windows PowerShell 5.1，硬路径在 System32），而启动我们的进程可能是
 *   PowerShell 7 —— pwsh 7 会把 `PSModulePath` 扩成
 *   `…\Documents\PowerShell\Modules;C:\Program Files\PowerShell\Modules;
 *    c:\program files\powershell\7\Modules;C:\Program Files\WindowsPowerShell\Modules;…`
 *   然后原样传给子进程。5.1 拿到这份清单会去加载 **7 的** `Microsoft.PowerShell.Security`，
 *   而那套模块的类型数据（System.Security.AccessControl.ObjectSecurity）跟 5.1 自带的重名，
 *   于是报 `The member AuditToString is already present`，`ConvertTo-SecureString`
 *   直接找不到 —— 最终表现是「填了 Key 却提示 DPAPI 失败」，错误信息里一个有用的字都没有。
 *
 *   摘掉之后 5.1 按自己的默认值重建路径，正常加载。实测：同一份脚本、同一组参数，
 *   带继承环境 exit 1，摘掉 PSModulePath exit 0。
 *   （本条只影响这一个子进程，不动用户环境。）
 */
function cleanEnv() {
  const env = { ...process.env };
  delete env.PSModulePath;
  return env;
}

/**
 * 一段 PowerShell：从 stdin 读 UTF-8 文本 → DPAPI 处理 → 结果写 stdout（UTF-8、无 BOM）。
 * ★ 为什么用 `[Console]::OpenStandardInput()` + `StreamReader(…, UTF8)` 而不是 `[Console]::In`：
 *   后者按控制台代码页解码，中文 Key（或将来带非 ASCII 的字段）会被解成乱码。
 * ★ 为什么 stdout 也显式 UTF8 无 BOM：BOM 会被 Node 读进字符串，变成密文前面的脏字符。
 * ★ 这一段刻意写成**纯 ASCII**，原因见 dpapi.ps1 早年的注释：5.1 按 ANSI 读 .ps1。
 *   这里是 `-Command` 传字符串，但保持 ASCII 同样避免编码歧义。
 */
// ★ 必须写成**单个表达式**：若写成 `$rd = …; $rd.ReadToEnd()` 再接 `$text = …`，
//   链式赋值会把 `$text` 变成 StreamReader 对象，而那条 ReadToEnd() 变成一个**独立语句**，
//   它的值会被 PowerShell 顺带打印到 stdout ⇒ 明文/密文会多回一份、还夹在结果前面
//   （实测：unprotect 回来的字符串是 "sk-…\r\n01000000d08c9ddf…"）。
const READ_STDIN = "([System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)).ReadToEnd()";
const WRITE_STDOUT = "$o = [System.IO.StreamWriter]::new([Console]::OpenStandardOutput(), [System.Text.UTF8Encoding]::new($false)); $o.Write($r); $o.Flush()";
const PROTECT_SCRIPT = `$text = ${READ_STDIN}; if ($text.Length -eq 0) { exit 3 }; ` +
  `$sec = ConvertTo-SecureString -String $text -AsPlainText -Force; ` +
  `$r = ConvertFrom-SecureString -SecureString $sec; ${WRITE_STDOUT}; exit 0`;
const UNPROTECT_SCRIPT = `$text = ${READ_STDIN}.Trim(); ` +
  `$sec = ConvertTo-SecureString -String $text; ` +
  `$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec); ` +
  `try { $r = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } ` +
  `finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }; ${WRITE_STDOUT}; exit 0`;

/**
 * 跑一段 PowerShell，值只走管道（stdin 进、stdout 出）。
 * ★ Node 的 `execFile` **没有** `input` 选项（那是 Python `subprocess.run` 的用法），
 *   必须用 spawn 自己喂 stdin，所以这里手写三个事件。
 */
function psPipe(script, input) {
  return new Promise((resolve, reject) => {
    const ps = spawn("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, env: cleanEnv() });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { ps.kill(); reject(new Error("DPAPI 超时（30 秒）")); }, 30000);
    ps.stdout.setEncoding("utf8");
    ps.stderr.setEncoding("utf8");
    ps.stdout.on("data", (d) => { out += d; });
    ps.stderr.on("data", (d) => { err += d; });
    ps.on("error", (e) => { clearTimeout(timer); reject(new Error(`DPAPI 起不来：${e.message}`)); });
    ps.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(out);
      reject(new Error(`DPAPI 失败（exit ${code}）${err ? `：${err.trim()}` : ""}`));
    });
    ps.stdin.end(input, "utf8");
  });
}

/**
 * 清掉旧版本留在 %TEMP% 里的明文/密文临时文件（2026-10-19 之前那套写文件的机制）。
 * ★ 服务端启动时调一次即可。只删**自己命名模式**的文件，别的一概不碰。
 * ★ 删不掉不算错误：可能是别的会话正在用（同一台机器的另一个实例），下次启动还会再试。
 */
export async function sweepTempFiles() {
  let names;
  try {
    names = await readdir(tmpdir());
  } catch {
    return { removed: 0 };
  }
  let removed = 0;
  for (const name of names) {
    if (!/^linli-(?:in|out)-[0-9a-f]{16}\.bin$/u.test(name)) continue;
    try {
      await rm(join(tmpdir(), name), { force: true });
      removed += 1;
    } catch {
      /* 被别的进程占着，下次再说 */
    }
  }
  return { removed };
}

/** 加密。返回 `dpapi-v1:` 前缀 + 旧格式密文。 */
export async function protect(plaintext) {
  if (!plaintext) throw new Error("没有可加密的内容");
  const cipher = (await psPipe(PROTECT_SCRIPT, String(plaintext))).trim();
  if (!cipher) throw new Error("DPAPI 没有返回密文");
  return SECRET_PREFIX + cipher;
}

/**
 * 解密。接受两种形态：带 `dpapi-v1:` 前缀的（新）与裸十六进制（旧库里存的）。
 * 解不开就抛错（换用户/换机器后会走到这里）。
 */
export async function unprotect(blob) {
  if (!blob) return "";
  const raw = String(blob).trim();
  const cipher = raw.startsWith(SECRET_PREFIX) ? raw.slice(SECRET_PREFIX.length) : raw;
  return (await psPipe(UNPROTECT_SCRIPT, cipher)).trim();
}

export async function runSecretPipeline(mode, value) {
  return mode === "protect" ? protect(value) : unprotect(value);
}
