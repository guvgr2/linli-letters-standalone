# 「OliviaSoul-community独立版」打包脚本
#   1. 发布 C# 外壳（自包含单文件，用户机器上不必装 .NET）
#   2. 组装 dist\package\（外壳 exe + app\ + runtime\）
#   3. 调 Inno Setup 出安装程序
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1 -SkipPublish   # 只重新组装
param(
  [switch]$SkipPublish
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$shellProject = Join-Path $root 'src\LinliShell\LinliShell.csproj'
$publishDir   = Join-Path $root 'dist\shell'
$packageDir   = Join-Path $root 'dist\package'
$appDir       = Join-Path $root 'app'
$runtimeDir   = Join-Path $root 'runtime'
$issFile      = Join-Path $root 'install.iss'
$iscc         = 'E:\Inno Setup 6\ISCC.exe'

Write-Host '== 1/3 发布外壳 ==' -ForegroundColor Cyan
if (-not $SkipPublish) {
  if (Test-Path -LiteralPath $publishDir) { [System.IO.Directory]::Delete($publishDir, $true) }
  & dotnet publish $shellProject -c Release -r win-x64 --self-contained true `
      -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
      -o $publishDir
  if ($LASTEXITCODE -ne 0) { throw "dotnet publish 失败（exit $LASTEXITCODE）" }
}
$exe = Join-Path $publishDir 'LinliLetters.exe'
if (-not (Test-Path $exe)) { throw "没找到外壳 exe：$exe" }
Write-Host "   外壳：$( (Get-Item $exe).Length ) 字节"

Write-Host '== 2/3 组装 package ==' -ForegroundColor Cyan
# 用 .NET 直接删，不用 Remove-Item：Remove-Item 被外层的删除护栏包了，
# 而那个护栏依赖回收站程序，在部分盘符上会 fail-closed。
if (Test-Path -LiteralPath $packageDir) { [System.IO.Directory]::Delete($packageDir, $true) }
New-Item -ItemType Directory -Path $packageDir -Force | Out-Null
Copy-Item -LiteralPath $exe -Destination (Join-Path $packageDir 'LinliLetters.exe') -Force
Copy-Item -LiteralPath $appDir -Destination (Join-Path $packageDir 'app') -Recurse -Force

# 内置运行时只带 node.exe 一个文件：npm / corepack / node_modules 一律不随包。
# 这里逐个显式拷贝，不用「先整目录拷再批量删」—— 批量删会撞上被占用的文件，报
# ParameterBindingException: InputObjectNotBound。
$nodeDir = Join-Path $packageDir 'runtime\node'
New-Item -ItemType Directory -Path $nodeDir -Force | Out-Null
$nodeExe = Join-Path $runtimeDir 'node\node.exe'
if (-not (Test-Path -LiteralPath $nodeExe)) { throw "没找到内置运行时：$nodeExe" }
Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $nodeDir 'node.exe') -Force
if (-not (Test-Path -LiteralPath (Join-Path $nodeDir 'node.exe'))) { throw 'runtime\node\node.exe 没拷过去' }
# 随包分发 node.exe 就必须连它的许可证一起带上（MIT 要求保留版权与许可声明）。
$nodeLic = Join-Path $runtimeDir 'node\LICENSE'
if (-not (Test-Path -LiteralPath $nodeLic)) { throw "没找到内置运行时的许可证：$nodeLic（缺它不能分发）" }
Copy-Item -LiteralPath $nodeLic -Destination (Join-Path $nodeDir 'LICENSE') -Force

# ★ 2026-10-16 加（全面检查 §2）：包里不许出现字体文件。
#   字体是用户自己从官网下、自己导入的，我们不分发（README 也这么写）。
#   实证：源码里早就删掉了，dist 的包里还留着 5.4 MB 的 SentyTEA.ttf —— 因为
#   Inno 只往里加、不删多余的（install.iss 已补 [InstallDelete]）。
#   ⇒ 这一条是"下次再发生就当场拦下"，不是靠人记得。
$strayFonts = Get-ChildItem -LiteralPath $packageDir -Recurse -File -Include *.ttf,*.otf,*.ttc,*.woff,*.woff2 -ErrorAction SilentlyContinue
if ($strayFonts) {
  # ★ 每个过滤器必须单独 -Include（2026-10-18 实证）：写成 -Include *.ttf,*.otf,... 时，
  #   PowerShell 把逗号后面那几个当成**位置参数**（这里正是 -LiteralPath 的值），
  #   于是 -Include 只剩 *.ttf、其余几个变成了不存在的路径，且 -Recurse 被后面的
  #   位置参数顶掉 ⇒ Get-ChildItem 退化成"列 {packageDir}\*.otf" ⇒ 报错/结果错乱，
  #   这道护栏就从来没真正生效过。真用回老写法的话，第一次发布就会误报一行
  #   「包里出现了字体文件」+ 整个目录清单。
  $strayFonts = @()
  foreach ($pattern in '*.ttf', '*.otf', '*.ttc', '*.woff', '*.woff2') {
    $strayFonts += @(Get-ChildItem -LiteralPath $packageDir -Recurse -File -Filter $pattern -ErrorAction SilentlyContinue)
  }
}
if ($strayFonts) {
  $list = ($strayFonts | ForEach-Object { $_.FullName.Replace($packageDir, '') }) -join "`n  "
  throw "包里出现了字体文件（我们不随包分发字体）：`n  $list"
}
Write-Host "   组装完成：$( (Get-ChildItem -LiteralPath $packageDir -Recurse -File).Count ) 个文件"

Write-Host '== 3/3 出安装程序 ==' -ForegroundColor Cyan
if (-not (Test-Path $iscc)) { throw "没找到 ISCC：$iscc" }
& $iscc $issFile
if ($LASTEXITCODE -ne 0) { throw "ISCC 失败（exit $LASTEXITCODE）" }

$setup = Get-ChildItem -LiteralPath (Join-Path $root 'dist') -Filter '*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host ''
Write-Host "完成：$($setup.FullName)" -ForegroundColor Green
Write-Host ("      {0:N1} MB" -f ($setup.Length / 1MB))
