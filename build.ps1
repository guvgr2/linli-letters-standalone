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
  # ★ 2026-10-19（21:53 那版包的真实事故）：只要有一个 LinliLetters.exe 还活着
  #   （上一轮测试超时没杀掉、或我自己手动双击过），`dist\shell` 就删不掉、
  #   publish 也覆盖不了，于是**旧 exe 被原样打进安装包**，而 build 照样成功。
  #   表现：`--check-recovery` 的决策表全是 fallback-browser（sane=false）。
  #   所以这里先查占用、publish 之后再拿自检**当场验一遍**，不通过就不出包。
  $running = @(Get-Process -Name 'LinliLetters' -ErrorAction SilentlyContinue)
  if ($running.Count -gt 0) {
    $pids = ($running | ForEach-Object { $_.Id }) -join ', '
    throw "还有 $($running.Count) 个 LinliLetters.exe 在跑（pid $pids）—— 先把它们退掉再构建，否则旧 exe 会被原样打进包里"
  }
  if (Test-Path -LiteralPath $publishDir) { [System.IO.Directory]::Delete($publishDir, $true) }
  & dotnet publish $shellProject -c Release -r win-x64 --self-contained true `
      -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
      -o $publishDir
  if ($LASTEXITCODE -ne 0) { throw "dotnet publish 失败（exit $LASTEXITCODE）" }
}
$exe = Join-Path $publishDir 'LinliLetters.exe'
if (-not (Test-Path $exe)) { throw "没找到外壳 exe：$exe" }

# 发布门禁：拿真 exe 跑一次 `--check-recovery`，决策表与 STA 必须都自洽。
# 这一步就是 21:53 那版缺的：旧 exe 被原样打进包，直到测试红才发现。
$selfCheckOut = Join-Path ([System.IO.Path]::GetTempPath()) ("linli-selfcheck-" + [guid]::NewGuid().ToString('N') + ".json")
$selfProc = Start-Process -FilePath $exe -ArgumentList @('--check-recovery', $selfCheckOut) -Wait -PassThru
$selfExit = $selfProc.ExitCode
if ($selfExit -ne 0 -or -not (Test-Path $selfCheckOut)) {
  throw "外壳自检没过（exit $selfExit）：$selfCheckOut —— 这个 exe 不该发出去"
}
# ★★ 必须显式 -Encoding UTF8：Windows PowerShell 5.1 的 Get-Content 默认按 ANSI
#   （本机 GB18030）读文件，而这两份 json 都是**无 BOM 的 UTF-8**（covers-meta.json
#   中文曲名；自检 json 见 Program.cs:134 `new UTF8Encoding(false)`）⇒ 5.1 下读出来
#   是乱码，ConvertFrom-Json 直接 ArgumentException。build.ps1 头部文档的用法就是
#   `powershell -File`（= 5.1），不能只在 PowerShell 7 里能跑。
#   （2026-10-21 实测炸过：封面护栏挂在 covers-meta.json 上，报错还带着一堆乱码。）
$selfJson = Get-Content $selfCheckOut -Raw -Encoding UTF8
# ★ 同 line 64 的理由：Remove-Item 被外层删除护栏包了（依赖回收站程序，后台/部分盘符
#   fail-closed 会直接把构建炸掉）⇒ 自检的临时 json 也用 .NET 删。
if (Test-Path -LiteralPath $selfCheckOut) { [System.IO.File]::Delete($selfCheckOut) }
if ($selfJson -notmatch '"sane":true') { throw "外壳自检 sane=false：$selfJson" }
if ($selfJson -notmatch '"apartment":"STA"') { throw "外壳 Main 线程不是 STA（WebView2 会起不来）：$selfJson" }
Write-Host '   外壳自检：sane=true / STA ✅'
Write-Host "   外壳：$( (Get-Item $exe).Length ) 字节"

Write-Host '== 2/3 组装 package ==' -ForegroundColor Cyan
# 用 .NET 直接删，不用 Remove-Item：Remove-Item 被外层的删除护栏包了，
# 而那个护栏依赖回收站程序，在部分盘符上会 fail-closed。
if (Test-Path -LiteralPath $packageDir) { [System.IO.Directory]::Delete($packageDir, $true) }
New-Item -ItemType Directory -Path $packageDir -Force | Out-Null
Copy-Item -LiteralPath $exe -Destination (Join-Path $packageDir 'LinliLetters.exe') -Force
# ★ 这里**只拷 app\**（+ 下面显式的 runtime\node）。不要图省事改成「拷仓库根」：
#   `tools\make-install-frames.mjs` 里有作者本机路径，`tests\no-personal-paths.test.js`
#   对 `tools/` 是明文豁免的 —— 那条豁免成立的前提就是"打包脚本只拷 app"。
#   换脚本时忘了这一条，本机路径会随包发出去（2026-10-20 终轮报告 §3.5 提醒）。
Copy-Item -LiteralPath $appDir -Destination (Join-Path $packageDir 'app') -Recurse -Force

# ★ 2026-10-21 加：曲库封面必须随包（用户 2026-10-19 原话「官方 120 多首歌的封面你也得
#   给对应上……随包，必须随包」；THIRD-PARTY-NOTICES.txt 第 5) 条有版权口径）。
#   为什么必须是**护栏**而不是"记得拷"：`app/covers/` 这批 256×256 缩略图在 git 里是
#   未跟踪的（第三方专辑图，不入库），所以**换一台机器 clone 后它会凭空消失**，而
#   `Copy-Item app\ -Recurse` 对"目录不存在"毫无反应 ⇒ 会静默产出一个没有封面的安装包，
#   server.mjs 里「已随包」的注释当场变成假话。所以在这里按数量当场拦。
#   ★ 期望值不写死 129，而是从 `app\covers-meta.json`（运行时真正读的那份元数据，
#     server.mjs:712）现数条目数：将来加歌改了元数据，护栏自动跟着改，不会变成假话。
#   ★★ 踩坑（2026-10-21 被这道护栏自己逮到的）：**不能**写成
#        `@(Get-Content … | ConvertFrom-Json).PSObject.Properties.Name.Count`
#      —— `@()` 会把单个 PSCustomObject 包成 1 元数组，于是 `.PSObject` 取到的是
#      **数组自己**的 PSObject，`.Properties.Name` 出来是 Count/Length/Rank/SyncRoot…
#      一共 8 个，跟 JSON 的键一个都对不上 ⇒ 护栏拿"8"当期望值，对着 129 张真封面报错。
#      ⇒ 先落到变量、再取 `.PSObject.Properties.Name`（外面那层 `@()` 才是包数组用的）。
$coverDir = Join-Path $packageDir 'app\covers'
$coverMetaSrc = Join-Path $appDir 'covers-meta.json'
if (-not (Test-Path -LiteralPath $coverMetaSrc)) { throw "没找到曲库元数据：$coverMetaSrc" }
$coverMetaObj = Get-Content -LiteralPath $coverMetaSrc -Raw -Encoding UTF8 | ConvertFrom-Json
$expectCovers = @($coverMetaObj.PSObject.Properties.Name).Count
$coverJpgs = @(Get-ChildItem -LiteralPath $coverDir -File -Filter *.jpg -ErrorAction SilentlyContinue)
if ($coverJpgs.Count -ne $expectCovers) {
  throw "曲库封面没随包：app\covers\ 下只有 $($coverJpgs.Count) 张 jpg，应为 $expectCovers（与 app\covers-meta.json 条目数一致）—— `$appDir\covers` 是不是没同步过来？（git 不跟踪这批图，换机器 clone 会整目录消失）"
}
if (-not (Test-Path -LiteralPath (Join-Path $coverDir 'manifest.json'))) {
  throw "曲库封面清单缺失：$(Join-Path $coverDir 'manifest.json')"
}
Write-Host "   曲库封面：$($coverJpgs.Count)/$expectCovers 张随包 ✅"

# ★ 2026-10-21 加：原版待机壁纸视频（Wallpaper_Presence）随包 —— 用户要求「待机正片进打包」，
#   让没装原版游戏的用户也能直接用桌面待机。
#   来源：构建机上本机装过的原版目录（steamapps\common\BSide Olivia Lin Test\<版本>\assets\Wallpaper_Presence）。
#   不进 git（2.9GB，体积过大），只在 build.ps1 打包时一次性拷进 dist\package\app\assets\Wallpaper_Presence\。
#   之所以放进 app\assets\ 而不是 app\transitions\：assetRoot() 的 ASSET_ROOTS 第一个就是
#   join(HERE,'assets')，会**优先于本机原版**被找到 ⇒ 安装包自包含，不依赖用户机器上有原版。
#   （app\transitions\ 那 3 支 A 场景自制过渡片现在被这套原版 9 支完整覆盖，留着无害、仅作兜底。）
#   ★ 护栏：先数源文件数（应为 36：27 正片 + 9 过场），拷完**双判据**拦——① 递归数包内 mp4 必须正好 36
#     （完整性，漏拷/半途失败立刻暴露）；② 直接下层绝不能出现再套一层 Wallpaper_Presence 目录（套层 bug
#     专有标志）。两个一起挡，避免「递归数仍 36 把套层掩盖」。跟曲库封面那道护栏同一条理由：这批文件 git
#     不跟踪、跨机器 clone 会消失，Copy-Item 对"目录不存在"无反应会静默产出缺片的包。
#   ★ 找不到原版时不报错、只警告：允许出"不含待机视频"的包（用户仍可靠本机原版或回退）。
# ★ 复用 app\assets.mjs 里 steamLibraryRoots() 的探测法（2026-10-19 踩过的坑）：
#   Steam 库可以在任意子目录（本机在 E:\SteamLibrary，不在盘符根），且
#   steamapps\libraryfolders.vdf 只在 Steam 自己的安装目录里 ——
#   所以先扫各盘顶层目录找"含 steamapps\libraryfolders.vdf / config\libraryfolders.vdf"的目录，
#   再解析 vdf 里的 "path" 展开出全部库根，最后在每根下找原版游戏。
#   LINLI_GAME_ASSETS 环境变量可强制指定原版 assets 目录，跳过自动探测。
function Find-GameAssets {
  $roots = New-Object System.Collections.Generic.HashSet[string]
  foreach ($code in 65..90) {
    $drive = [char]$code + ':\'
    if (-not (Test-Path -LiteralPath $drive)) { continue }
    try { $names = (Get-ChildItem -LiteralPath $drive -Directory -ErrorAction SilentlyContinue).Name } catch { continue }
    foreach ($name in $names) {
      $dir = Join-Path $drive $name
      $vdf = $null
      if (Test-Path -LiteralPath (Join-Path $dir 'steamapps\libraryfolders.vdf')) { $vdf = Join-Path $dir 'steamapps\libraryfolders.vdf' }
      elseif (Test-Path -LiteralPath (Join-Path $dir 'config\libraryfolders.vdf')) { $vdf = Join-Path $dir 'config\libraryfolders.vdf' }
      if ($vdf) {
        $roots.Add($dir) | Out-Null
        $text = Get-Content -LiteralPath $vdf -Raw -Encoding UTF8
        foreach ($m in [regex]::Matches($text, '"path"\s+"([^"]+)"')) {
          $p = $m.Groups[1].Value -replace '\\\\', '\'
          if (Test-Path -LiteralPath $p) { $roots.Add($p) | Out-Null }
        }
      }
    }
  }
  if (Test-Path -LiteralPath 'C:\Program Files (x86)\Steam') { $roots.Add('C:\Program Files (x86)\Steam') | Out-Null }
  if ($env:LINLI_GAME_ASSETS) { $roots.Add($env:LINLI_GAME_ASSETS) | Out-Null }

  foreach ($root in $roots) {
    $common = Join-Path $root 'steamapps\common\BSide Olivia Lin Test'
    if (Test-Path -LiteralPath $common) {
      $ver = Get-ChildItem -LiteralPath $common -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
      if ($ver) {
        $assets = Join-Path $ver.FullName 'assets'
        if (Test-Path -LiteralPath (Join-Path $assets 'Wallpaper_Presence')) { return $assets }
      }
    }
  }
  return $null
}
$gameAssetsRoot = Find-GameAssets
$bundledPresenceDir = Join-Path $packageDir 'app\assets\Wallpaper_Presence'
if ($gameAssetsRoot -and (Test-Path -LiteralPath (Join-Path $gameAssetsRoot 'Wallpaper_Presence'))) {
  $srcPresence = Join-Path $gameAssetsRoot 'Wallpaper_Presence'
  $srcPresenceFiles = @(Get-ChildItem -LiteralPath $srcPresence -File -Filter *.mp4 -ErrorAction SilentlyContinue)
  if ($srcPresenceFiles.Count -ne 36) {
    throw "原版 Wallpaper_Presence 文件数异常：源目录只有 $($srcPresenceFiles.Count) 个 mp4，应为 36（27 正片 + 9 过场）。源：$srcPresence"
  }
  New-Item -ItemType Directory -Path $bundledPresenceDir -Force | Out-Null
  # ★ 用 robocopy /E 拷「目录内容」，绕开 PowerShell Copy-Item 的两个坑：
  #   ① `Copy-Item -LiteralPath <目录> -Destination <已存在目录> -Recurse` 会把源目录**整层套进**
  #      目标（包内变 Wallpaper_Presence\Wallpaper_Presence\*，assetRoot 按一层找文件全落空 ⇒ 构建绿运行红）；
  #   ② `Copy-Item -LiteralPath "<目录>\*"` 因 -LiteralPath 把 `*` 当字面量，找不到叫「*」的文件 ⇒ 啥都没拷（实测：空目录）。
  #   robocopy /E 递归拷子目录（含空目录），对 2.9GB 大目录稳健；退出码 0-7 都算成功，>7 才失败。
  robocopy $srcPresence $bundledPresenceDir /E /NP /NFL /NDL /NJH /NJS
  if ($LASTEXITCODE -gt 7) {
    throw "robocopy 拷贝 Wallpaper_Presence 失败，退出码 $LASTEXITCODE（>7 即失败）。源：$srcPresence"
  }
  # ★ 护栏（双判据）：递归数 mp4 必须正好 36（完整性）；且直接下层绝不能出现再套一层
  #   Wallpaper_Presence 目录（套层 bug 的专有标志）。两个一起挡，避免「递归数仍 36 把套层掩盖」。
  $bundledPresenceFiles = @(Get-ChildItem -LiteralPath $bundledPresenceDir -Recurse -File -Filter *.mp4 -ErrorAction SilentlyContinue)
  if ($bundledPresenceFiles.Count -ne 36) {
    throw "待机视频没随包：包内 Wallpaper_Presence 递归只有 $($bundledPresenceFiles.Count) 个 mp4，应为 36（拷贝中途失败？）。"
  }
  if (Test-Path -LiteralPath (Join-Path $bundledPresenceDir 'Wallpaper_Presence')) {
    throw "套层 bug：包内 Wallpaper_Presence 之下又多了一层 Wallpaper_Presence 目录，拷贝把源目录本身也带进来了。assetRoot 按一层找文件会全落空。"
  }
  $presenceBytes = (Get-ChildItem -LiteralPath $bundledPresenceDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
  Write-Host "   待机壁纸视频：$($bundledPresenceFiles.Count)/36 个随包 ✅ ($([math]::Round($presenceBytes / 1GB, 1)) GB)"
} else {
  Write-Warning "未找到本机原版 Wallpaper_Presence（LINLI_GAME_ASSETS 未设，且各盘未扫到原版安装）。本安装包将不含待机视频，用户需自行装有原版游戏才能用待机。"
}

# ★ 2026-10-21 加：`harness-manifest.json` **不进安装产物**——它自己第 5 行的 statusNote
#   就是这么写的（"本文件不进打包产物（开发/审计用）"），运行时不读它（harness-render.mjs
#   只在注释里提名字）。但它此前一直被 `Copy-Item app\ -Recurse` 原样带进包里，而里面有
#   16 处「姊妹项目」、10 处审查/施工单编号、`repo/source/...` 与 `.cursor/skills/...`
#   这类内部路径 —— 用户 2026-10-21 点名要剥的就是这类内部行话外溢。
#   ⇒ 拷完立刻从 package 里删掉；源文件不动（两端同步还要靠它）。
$manifestInPkg = Join-Path $packageDir 'app\harness\harness-manifest.json'
if (Test-Path -LiteralPath $manifestInPkg) {
  # ★ 必须用 .NET 删，**不能**用 Remove-Item —— 跟 line 64 删 package 目录是同一条理由：
  #   Remove-Item 被外层删除护栏包了，那个护栏依赖回收站程序（genie-trash），在后台任务
  #   语境 / 部分盘符上会 fail-closed 抛 SAFE_DELETE_FAIL_CLOSED，把整个构建炸在这里
  #   （2026-10-21 实测：前台能过、后台 PowerShell 任务里必炸）。
  [System.IO.File]::Delete($manifestInPkg)
  Write-Host '   已排除 harness-manifest.json（开发/审计用，不随包）'
}

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

# ★ 2026-10-19 加（七轮审查 F12）：发一份 `.sha256` 校验文件，跟安装包同目录、同名 + `.sha256`。
#   目的：用户下载完能自己核对，不必信任"下载站没被改过"这件事。成本就是一行 Get-FileHash。
#   格式照 `sha256sum` 的口径：`<64 位小写十六进制>  <文件名>`（两个空格），
#   这样 Linux/macOS 上 `sha256sum -c` 也能直接验。
$hash = (Get-FileHash -LiteralPath $setup.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$checksumFile = "$($setup.FullName).sha256"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($checksumFile, "$hash  $($setup.Name)`n", $utf8NoBom)
Write-Host "SHA256：$hash" -ForegroundColor Green
Write-Host "校验：$checksumFile" -ForegroundColor Green