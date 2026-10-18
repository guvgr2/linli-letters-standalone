# 给 .ps1 补上 UTF-8 BOM
#
# 为什么非要这一条（2026-10-18 实证）：
#   build.ps1 的调用方式是 `powershell.exe -File build.ps1`，那是 **Windows PowerShell 5.1**。
#   5.1 读没有 BOM 的 .ps1 时按**系统 ANSI 代码页**解（本机是 GBK/936），不是 UTF-8。
#   文件里全是中文注释与中文报错文案 ⇒ 注释里的汉字按 GBK 解出来会吞掉后半个字节，
#   于是把后面的引号/花括号一起吃掉，语法树当场崩：
#     Missing closing '}' in statement block or type definition.
#     At E:\linli-letters\build.ps1:31 char:28
#   注意这条**不是**我这次改出来的：从仓库第一次提交开始，build.ps1 就是无 BOM 的 UTF-8。
#
# 为什么不能改用 `pwsh -File` 绕开：用户机器上可能只有 5.1。坚持让 5.1 也能跑，
#   就得让文件自己能被 5.1 正确识别 —— 也就是带 BOM。
#
# 用法：pwsh -NoProfile -File tools\ensure-ps1-bom.ps1 [-Check]
#   -Check 只检查不修改，发现问题 exit 1（给 CI / 门禁用）。

param([switch]$Check)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
# 只纳管会被人手执行的入口脚本；tests\ 下那批是本机 node 跑的，不走 PowerShell。
$targets = @(
  (Join-Path $root 'build.ps1')
)

$bad = @()
foreach ($f in $targets) {
  if (-not (Test-Path -LiteralPath $f)) { throw "没找到：$f" }
  $bytes = [System.IO.File]::ReadAllBytes($f)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  if ($hasBom) {
    Write-Host "  有 BOM：$([System.IO.Path]::GetFileName($f))"
    continue
  }
  if ($Check) {
    Write-Host "  缺 BOM：$([System.IO.Path]::GetFileName($f))" -ForegroundColor Red
    $bad += $f
    continue
  }
  Write-Host "  补 BOM：$([System.IO.Path]::GetFileName($f))"
  $new = New-Object 'byte[]' ($bytes.Length + 3)
  $new[0] = 0xEF; $new[1] = 0xBB; $new[2] = 0xBF
  [System.Array]::Copy($bytes, 0, $new, 3, $bytes.Length)
  [System.IO.File]::WriteAllBytes($f, $new)
}

if ($bad.Count -gt 0) {
  Write-Host '上述 .ps1 缺 UTF-8 BOM，5.1 会把它按 GBK 解，中文注释会让语法树崩。' -ForegroundColor Red
  exit 1
}
Write-Host '全部就绪。'
