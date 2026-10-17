; 「OliviaSoul-community独立版」安装脚本（Inno Setup 6）
;
; 三条写在前头的坑：
;   1. 桌面快捷方式直接指向 exe 本身，不经任何 .bat / .vbs / .ps1 中转。
;      中转脚本会被安全软件当成可疑启动项拦掉（图标点了没反应），是同类程序最常见的坑。
;   2. 开机自启动同理：写注册表 Run 项、值直接是 exe 本体，不挂脚本。
;   3. ★ 卸载只删程序本体，**绝不碰用户数据**（%APPDATA%\LinliLetters）。
;      信件是这个程序存在的理由，卸载程序没有资格替用户做"连信一起删"的决定。
;
; 借鉴竞品 Install.ps1 的那几条（不是抄代码，是抄它把什么当回事）：
;   - 安装锁：同时跑两个安装会互相踩文件 ⇒ 用互斥量挡住（它的 Enter-ManagedInstallLock）。
;   - 路径体检：拒绝盘符根、系统目录、非法字符、**重解析点**（junction/符号链接）——
;     装在 junction 上，卸载时 Delete 会顺着链接删到别的地方去（它的 Assert-NoReparsePointsInPath）。
;   - 结构化错误码：每种失败有一个固定代号（E-PATH-IS-REPARSE-POINT 这种），
;     用户把代号报过来就能对上号，不用猜"它说安装失败是哪一步失败"（它的 Get-SafeSetupErrorCode）。
;   - 装前先请正在跑的程序退出，而不是硬抢文件（它的 Request-ManagedApplicationClose）。

#define MyAppName "OliviaSoul-community独立版"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "OliviaSoul 社区"
#define MyAppExeName "LinliLetters.exe"

[Setup]
AppId={{B7E4C1A2-6D3F-4A18-9C55-2F0A7D31E9A4}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
; ★ 图标：只有一份真源 installer\linli.ico。同一份还被
;   src\LinliShell\LinliShell.csproj 的 ApplicationIcon 用着（exe 自己的图标，
;   开始菜单/任务栏/桌面快捷方式继承的是它），以及 app\icon.ico
;   （外壳运行时从 {app}\app\icon.ico 读托盘图标）。改图标要三处一起换。
SetupIconFile=installer\linli.ico
; ★ 协议页：设了 LicenseFile，向导就会多出一页协议，并且必须点「我同意」才能继续
;   （Inno 自己就把"不接受"挡住了）—— 协议从此只在安装时出现一次，设置页不必再放。
LicenseFile=协议.txt
; ★ 按**用户**装，不走 Program Files（也就全程不弹 UAC）。理由有三：
;   1. 这是个人程序：信件本来就在 %APPDATA%\LinliLetters 下，本就没有"机器级"的那一份。
;   2. 开机自启动写的是 **HKCU** 的 Run 项 —— 那是"当前这个用户"的语义，必须按用户装，
;      否则提权安装时 HKCU 会落到别的账户上，自启动等于写给了别人。
;      竞品也一样：它装在 E:\bside olivia community 这种普通目录里，不进 Program Files。
;   3. 装和卸都不用管理员，协议页 → 选位置 → 勾两项这一整条流程就没有打断。
;   （要改回机器级：把这两行换成 PrivilegesRequired=admin + DefaultDirName={autopf}\LinliLetters 即可，
;    但那样自启动项得改用 HKA，且会写成"所有用户都自启"。）
PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
; ★ 欢迎页**必须开**。Inno 6 的 DisableWelcomePage 默认是 yes（欢迎页不显示），
;   而 WizardImageFile 那块图位只在**欢迎页**和**完成页**左侧出现 ——
;   不开欢迎页，安装动画就只能在装完之后那页播上几秒，装的过程中什么也看不到。
;   用户抱怨的就是"安装动画没有" ⇒ 让这一版的纸质动画从头（欢迎页）就开始播。
DisableWelcomePage=no
; 自定义安装路径：这一页默认就是开着的，显式写出来是怕以后有人顺手关掉。
DisableDirPage=no
DisableProgramGroupPage=yes
AllowUNCPath=no
OutputDir=dist
OutputBaseFilename=OliviaSoul-community独立版-1.0.0-安装程序
Compression=lzma2/ultra64
SolidCompression=yes
; ★ 外观：本机 Inno 是 6.6+（目录里有 SetupCustomStyle.e32 与 ISetup-dark.chm），
;   支持深色模式与内置自定义样式。dynamic = 跟随 Windows 的浅色/深色设置；
;   windows11 = 浅色时也走 Win11 那套观感 —— 不加它，浅色模式退回的是 Inno 自带的
;   灰白向导，也就是竞品现在那个样子。
WizardStyle=modern dynamic windows11
; 欢迎页 / 完成页左侧的品牌图。规格严格 164:314，这里给 4 倍（656×1256），
; 250% DPI 也不糊。★ 竞品的 windows_setup.iss 里没有这一条 ——
; 它用的就是 Inno 自带那张灰图，这一块是真正能拉开差距的地方。
WizardImageFile=installer\wizard-panel.png
; 其余各页右上角的小图，正方形。
WizardSmallImageFile=installer\wizard-mark.png
; 图位四周的衬底色，跟着品牌图的主色走，免得比例上差一点就露出白边。
WizardImageBackColor=#16141A
ArchitecturesInstallIn64BitMode=x64compatible
; ★ 故意不写 PrivilegesRequiredOverridesAllowed：
;   它的 dialog 值会在开头弹一个英文的「Setup Install Mode」对话框（用户截图里那个），
;   而且跟 PrivilegesRequired=lowest 语义打架 —— 用户一旦选「给所有用户装」，
;   提权后 HKCU 会落到别的账户上，自启动等于写给了别人。
;   我们要的就是「给当前这个用户装」，不给这个选项。
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}
; ★ 装之前先请正在跑的林离退出（外壳会创建 LinliLetters.App 这个互斥量）。
;   它是托盘程序，没有窗口，用户自己不会想到要先退 —— 不请它退就会撞上被占用的文件。
AppMutex=LinliLetters.App
CloseApplications=yes
RestartApplications=no
; 卸载同理：不在卸载后自作主张重启（Inno 6 没有 UninstallRestartApplications 这个指令）

[Languages]
; ★ 原来这行写的是 MessagesFile: "compiler:Default.isl" —— 名字叫 chinesesimp，
;   实际加载的是**英文**包。中文化全靠下面 [Messages] 逐条打补丁，没有任何兜底：
;   凡是没覆盖到的字符串都会漏出英文（用户截图里那段 PrivilegesRequiredOverride
;   就是漏网的）。本机 Inno 的 Languages\ 目录里确实没有中文包，所以把第三方汉化
;   收编进仓库（installer\ChineseSimplified.isl），改成引用它 —— 有兜底，漏网也是中文。
;   下面那些 [Messages] 仍然保留：它们是我们自己写的口语化文案，会盖在语言包之上。
Name: "chinesesimp"; MessagesFile: "installer\ChineseSimplified.isl"

; ---- 向导文案中文化 -------------------------------------------------------
[Messages]
; 通用按钮
ButtonBack=< 上一步
ButtonNext=下一步 >
ButtonCancel=取消
ButtonFinish=完成
ButtonInstall=安装
ButtonBrowse=浏览(&B)...
ButtonYes=是(&Y)
ButtonNo=否(&N)
ButtonOK=确定
; 欢迎页
WelcomeLabel1=欢迎安装 [name]
WelcomeLabel2=本机优先的一封信箱。信件、设置、账本全部存在你自己机器上。%n%n建议在安装前关掉其他程序。
; 协议页
LicenseLabel=请读完下面的协议，再决定要不要装。
LicenseAccepted=我同意这份协议(&A)
LicenseNotAccepted=我不同意(&D)
LicenseLabel3=请读完这份使用协议。必须勾选「我同意」才能继续安装。
; 选目录页（消息名以 Default.isl 为准：只有 SelectDirDesc / SelectDirLabel3 / SelectDirBrowseLabel）
SelectDirDesc=装到哪个文件夹？
SelectDirLabel3=OliviaSoul-community独立版会装进下面这个文件夹。
SelectDirBrowseLabel=点「下一步」继续；想换位置就点「浏览」。
DiskSpaceGBLabel=所需空间：约 [gb] GB
DiskSpaceMBLabel=所需空间：约 [mb] MB
; 选任务页
SelectTasksDesc=还有两件事要你定
SelectTasksLabel2=勾好这两项，然后点「下一步」。两件装完都能再改。
; 就绪页
ReadyLabel1=可以装了
ReadyLabel2a=点「安装」开始，或点「上一步」回去改。
ReadyLabel2b=点「安装」开始。
ReadyMemoDir=安装位置
ReadyMemoType=安装方式
ReadyMemoComponents=组件
ReadyMemoGroup=开始菜单文件夹
ReadyMemoTasks=附加任务
; 安装中
InstallingLabel=正在安装 [name]，请等一会儿。
; 完成页
FinishedHeadingLabel=[name] 装好了
FinishedLabel=[name] 已安装到你的电脑上。%n%n点「完成」退出安装程序。
FinishedLabelNoIcons=点「完成」退出安装程序。
FinishedRestartLabel=要不要现在重启电脑？
FinishedRestartMessage=装完了，需要重启才能用。%n%n现在重启吗？
ClickFinish=点「完成」退出安装程序。
; 卸载
ConfirmUninstall=确定要把 [name] 从这台电脑上卸掉吗？%n%n你的信件与设置会**保留**在 %APPDATA%\LinliLetters，卸载不会动它们。
UninstalledAll=[name] 已卸载。%n%n你的信件与设置保留在 %APPDATA%\LinliLetters。
UninstalledMost=[name] 已卸载。有少数文件没能删掉，可以自己手动清理。
UninstalledAndNeedsRestart=卸载完成，需要重启电脑才能删干净。%n%n现在重启吗？
; 放弃 / 出错
ExitSetupTitle=退出安装
ExitSetupMessage=安装还没完成，现在退出的话 [name] 就装不上了。%n%n可以再点一次「取消」继续安装。
AboutSetupMenuItem=关于安装程序...

[CustomMessages]
ErrMutexTitle=已经有一个安装在跑了
ErrMutexBody=检测到另一个安装程序正在运行（或上一次安装没退出干净）。%n%n请先把它关掉再重试。%n%n错误代号：%1
ErrPathTitle=这个位置不能装
PathRoot=不能装在盘符根目录（比如 C:\）下，请选一个具体的文件夹。%n%n错误代号：%1
PathSystem=不能装进 Windows 系统目录，请换一个位置。%n%n错误代号：%1
PathChars=路径里有不能用的字符（< > : " | ? * 或控制字符），请换一个。%n%n错误代号：%1
PathJunction=这条路经过一个「链接文件夹」（junction 或符号链接）。%n装在那上面，以后卸载时会顺着链接删到别的地方去。%n%n请换一个真实的文件夹。%n%n错误代号：%1
PathOverlap=这个位置跟已经装着的 [name] 是同一个地方，会被覆盖。%n%n请换一个位置，或者先卸掉旧的。%n%n错误代号：%1

[Tasks]
; ★ 桌面快捷方式：**默认勾选**，用户想不要可以自己取消。
;   checkedonce = 第一次装默认勾，以后升级时记住用户上次的选择，不强行改回来。
Name: "desktopicon"; Description: "在桌面创建快捷方式"; GroupDescription: "快捷方式:"; Flags: checkedonce
; ★ 开机自启动：**默认不勾选**。它会在后台常驻，这该由用户自己决定，不能替他勾。
Name: "autostart"; Description: "开机时自动启动（会常驻在托盘里）"; GroupDescription: "启动:"; Flags: unchecked

[Files]
Source: "dist\package\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\package\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "dist\package\runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "协议.txt"; DestDir: "{app}"; Flags: ignoreversion
; ★ 开源组件声明：随包带了 Node.js 与 .NET 两个运行时，分发二进制就得把许可一并带上。
Source: "THIRD-PARTY-NOTICES.txt"; DestDir: "{app}"; Flags: ignoreversion
; ★ 2026-10-17 补（审核）：项目自身的 LICENSE（MIT）必须随包 —— MIT 要求随附许可文本，
;   而之前只带了 THIRD-PARTY-NOTICES.txt（那是**第三方**的声明，不是本项目的许可）。
Source: "LICENSE"; DestDir: "{app}"; Flags: ignoreversion

; ---- 安装动画的 48 帧（tools\make-install-frames.mjs 用无头 Edge 从
;      design-preview.html 第①节渲出来的，656×1256、共约 2.2MB）----
; dontcopy = 只随安装包带着、按需解到 {tmp} 供 [Code] 轮流贴到向导图位上，
;            **不会**装进目标机 —— 用户目录里不该多出 48 张图。
; 通配符一行就是这 48 个文件（frame-00.png .. frame-47.png），
; ExtractTemporaryFile 按文件名逐张解，跟一条一条写等价。
Source: "installer\frames\frame-*.png"; Flags: dontcopy
; 播完收尾用：把向导图位换回品牌图（最后一帧是"飞机飞走了"的空画面，
; 完成页不能停在一张空黑图上）。这张 WizardImageFile 本来就带着，这里只是
; 再挂一份 dontcopy 供运行时读。
Source: "installer\wizard-panel.png"; Flags: dontcopy

[Registry]
; 开机自启动：值直接是 exe 本体，不挂任何脚本（见文件头第 2 条坑）。
; --startup 是给外壳的暗号：这次是开机自启拉起来的，只进托盘、不弹窗口。
; uninsdeletevalue ⇒ 卸载时（或用户在设置页取消勾选后重装时）这一项会被清掉，不留尾巴。
Root: HKCU; Subkey: "SOFTWARE\Microsoft\Windows\CurrentVersion\Run"; \
    ValueType: string; ValueName: "{#MyAppName}"; \
    ValueData: """{app}\{#MyAppExeName}"" --startup"; \
    Flags: uninsdeletevalue; Tasks: autostart

[Icons]
; 直接指 exe，不走脚本中转
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
; 装完问一句要不要立刻打开。postinstall + skipifsilent ⇒ 用户自己决定，静默安装时不自作主张。
Filename: "{app}\{#MyAppExeName}"; Description: "现在打开 {#MyAppName}"; Flags: nowait postinstall skipifsilent

; ★ 2026-10-16 加（全面检查 §2）：覆盖安装时旧文件永远留着 —— 实证是
;   dist\package\app\public\fonts\SentyTEA.ttf（5.4 MB）：源码里早就删了，
;   装上去的包里还在，因为 Inno 只往里加、不删多余的。
; ⇒ 装之前先把整个 app\ 清掉。用户数据在 %APPDATA%\LinliLetters，不在这里，一个字节都不碰。
[InstallDelete]
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\runtime"

[UninstallDelete]
; ★ 只删运行时。用户数据（%APPDATA%\LinliLetters）一个字节都不碰。
Type: filesandordirs; Name: "{app}\runtime"

; ================================ [Code] ================================
; 借鉴竞品 Install.ps1：安装锁 + 路径体检 + 结构化错误码。
; 每一步失败都有一个固定代号，用户报过来就能对上号，不用猜。

[Code]
const
  { 不加 Global\ 前缀：Global 命名空间的互斥量在**非提权**安装下会创建失败
    （返回 0，GetLastError 给 access denied），那样这把锁就等于没有。
    不带前缀落在会话命名空间里，正好够挡"同时开两个安装程序"。 }
  SETUP_MUTEX   = 'LinliLetters.Setup';
  { FILE_ATTRIBUTE_REPARSE_POINT Inno 6 自己就定义了，重复声明会编不过 }
  ERROR_ALREADY_EXISTS = $000000B7;
  ERR_MUTEX     = 'E-SETUP-ALREADY-RUNNING';
  ERR_ROOT      = 'E-PATH-IS-DRIVE-ROOT';
  ERR_SYSTEM    = 'E-PATH-UNDER-SYSTEM';
  ERR_CHARS     = 'E-PATH-ILLEGAL-CHARS';
  ERR_JUNCTION  = 'E-PATH-IS-REPARSE-POINT';
  ERR_OVERLAP   = 'E-PATH-OVERLAPS-EXISTING';

var
  SetupMutex: THandle;

function CreateMutex(lpMutexAttributes: LongInt; bInitialOwner: BOOL; lpName: string): THandle;
  external 'CreateMutexW@kernel32.dll stdcall';

function GetFileAttributes(lpFileName: string): LongInt;
  external 'GetFileAttributesW@kernel32.dll stdcall';

function GetLastError(): LongInt;
  external 'GetLastError@kernel32.dll stdcall';

{ 去掉末尾反斜杠（"C:\" 这种盘符根保持原样） }
function NoTrail(const P: string): string;
begin
  Result := P;
  if (Length(Result) > 3) and (Result[Length(Result)] = '\') then
    Result := Copy(Result, 1, Length(Result) - 1);
end;

{ 盘符根，比如 "C:\" }
function DriveRoot(const P: string): string;
begin
  Result := Copy(P, 1, 3);
end;

function HasIllegalChars(const P: string): Boolean;
var
  I: Integer;
  C: Char;
begin
  Result := False;
  for I := 1 to Length(P) do
  begin
    C := P[I];
    if (C = '<') or (C = '>') or (C = '"') or (C = '|') or (C = '?') or (C = '*') or (Ord(C) < 32) then
    begin
      Result := True;
      Exit;
    end;
  end;
end;

function IsDriveRoot(const P: string): Boolean;
begin
  Result := (Length(P) = 3) and (P[2] = ':') and (P[3] = '\');
end;

{ 装进系统目录：Windows、System32，或 Program Files / Program Files (x86) 根本身 }
function IsSystemDir(const P: string): Boolean;
var
  U, WinDir, SysDir, Pf32, Pf64: string;
begin
  U := Uppercase(AddBackslash(P));
  WinDir := Uppercase(AddBackslash(ExpandConstant('{win}')));
  SysDir := Uppercase(AddBackslash(ExpandConstant('{sys}')));
  Pf32 := Uppercase(AddBackslash(ExpandConstant('{pf32}')));
  Pf64 := Uppercase(AddBackslash(ExpandConstant('{pf64}')));
  Result := (Pos(WinDir, U) = 1) or (Pos(SysDir, U) = 1) or (U = Pf32) or (U = Pf64);
end;

{ ★ 重解析点检查（对位竞品 Assert-NoReparsePointsInPath）：
  从所选目录往上逐级查到盘符根，任何一级是 junction / 符号链接就拒绝。
  装在链接上，卸载时的删除会**顺着链接删到别的地方去** —— 这是会真删错东西的一类坑。
  只查已经存在的那几级（目录还没建时，查它最近的已存在祖先）。 }
function PathHasReparsePoint(const P: string): Boolean;
var
  Cur, Root: string;
  Attr: LongInt;
begin
  Result := False;
  Cur := NoTrail(P);
  Root := DriveRoot(Cur);
  while Length(Cur) > Length(Root) do
  begin
    if DirExists(Cur) then
    begin
      Attr := GetFileAttributes(Cur);
      if (Attr <> -1) and ((Attr and FILE_ATTRIBUTE_REPARSE_POINT) <> 0) then
      begin
        Result := True;
        Exit;
      end;
    end;
    Cur := NoTrail(ExtractFilePath(Cur));
    if Length(Cur) <= Length(Root) then Break;
  end;
end;

{ 已经装着的那一实例在哪（读卸载项的 InstallLocation）；没装过返回 '' }
function ExistingInstallDir(): string;
var
  Key, Prev: string;
begin
  Result := '';
  Key := ExpandConstant('SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{#SetupSetting('AppId')}_is1');
  if RegQueryStringValue(HKCU, Key, 'InstallLocation', Prev) and (Prev <> '') then
  begin
    Result := Prev;
    Exit;
  end;
  if RegQueryStringValue(HKLM32, Key, 'InstallLocation', Prev) and (Prev <> '') then
  begin
    Result := Prev;
    Exit;
  end;
  if RegQueryStringValue(HKLM64, Key, 'InstallLocation', Prev) and (Prev <> '') then
    Result := Prev;
end;

{ ★ 与已有实例"嵌套"，不是"同一个位置"：
  装到**同一个**目录是正常的覆盖升级，Inno 处理得很好，不能拦；
  真正要拦的是把新实例装进旧实例的**子目录**，或把新实例装在旧实例的**父目录**
  —— 那样两份文件会互相掺在一起，卸载时谁也说不清哪些属于谁。 }
function NestsWithExistingInstall(const P: string): Boolean;
var
  A, B: string;
begin
  Result := False;
  B := NoTrail(ExistingInstallDir());
  if B = '' then Exit;
  A := Uppercase(NoTrail(P));
  B := Uppercase(B);
  Result := (A <> B) and ((Pos(B + '\', A) = 1) or (Pos(A + '\', B) = 1));
end;

function ValidateDir(const P: string; out Code: string): Boolean;
begin
  Result := False;
  Code := '';
  if HasIllegalChars(P) then begin Code := ERR_CHARS; Exit; end;
  if IsDriveRoot(P) then begin Code := ERR_ROOT; Exit; end;
  if IsSystemDir(P) then begin Code := ERR_SYSTEM; Exit; end;
  if PathHasReparsePoint(P) then begin Code := ERR_JUNCTION; Exit; end;
  if NestsWithExistingInstall(P) then begin Code := ERR_OVERLAP; Exit; end;
  Result := True;
end;

procedure Fail(const Code: string);
begin
  if Code = ERR_ROOT then
    MsgBox(FmtMessage(CustomMessage('PathRoot'), [Code]), mbError, MB_OK)
  else if Code = ERR_SYSTEM then
    MsgBox(FmtMessage(CustomMessage('PathSystem'), [Code]), mbError, MB_OK)
  else if Code = ERR_CHARS then
    MsgBox(FmtMessage(CustomMessage('PathChars'), [Code]), mbError, MB_OK)
  else if Code = ERR_JUNCTION then
    MsgBox(FmtMessage(CustomMessage('PathJunction'), [Code]), mbError, MB_OK)
  else if Code = ERR_OVERLAP then
    MsgBox(FmtMessage(CustomMessage('PathOverlap'), [Code]), mbError, MB_OK);
end;

{ 安装锁：同时跑两个安装会互相踩文件。互斥量已经存在 ⇒ 有一个在跑了。 }
function InitializeSetup(): Boolean;
begin
  Result := True;
  SetupMutex := CreateMutex(0, True, SETUP_MUTEX);
  if GetLastError() = ERROR_ALREADY_EXISTS then
  begin
    MsgBox(FmtMessage(CustomMessage('ErrMutexBody'), [ERR_MUTEX]), mbError, MB_OK);
    Result := False;
  end;
end;

{ 互斥量不显式释放：进程一退，Windows 自己收回去。
  显式 CloseHandle 反而容易在异常退出路径上被跳过。 }

{ 选目录那一点「下一步」时体检一次，不通过就不让走 }
function NextButtonClick(CurPageID: Integer): Boolean;
var
  Code: string;
begin
  Result := True;
  if CurPageID = wpSelectDir then
  begin
    if not ValidateDir(WizardDirValue, Code) then
    begin
      Fail(Code);
      Result := False;
    end;
  end;
end;

{ ======================= 安装动画：纸质信封逐帧播放 =======================
  用户在意的「安装动画」：design-preview.html 第①节那套
    牛皮纸信封 → 开盖 → 抽信纸 → 摊开 → 落墨写「—— 林离」→ 盖火漆印「离」
    → 折成纸飞机 → 飞向远方（半路变成玻璃飞机），共 48 帧、7500ms 一轮。

  为什么走 [Code]：WizardImageFile 不支持逐帧动画 —— 逗号分隔的多张图是
    **按 DPI 挑尺寸**用的（官方文档："Setup will automatically select the one
    that best matches the size of the image area"），不是逐帧。
    所以把 48 帧以 dontcopy 带在包里，用 SetTimer 每 156ms 往向导图位上贴一张。
  帧间隔：7500ms / 48 ≈ 156ms，跟 design-preview-安装动画.gif 的播放速度一致
    （tools\make-install-frames.mjs 也是按这条时间轴采样的，两边必须对上）。

  ★ 显示位置（查证过的事实，不是猜的）：
    WizardImageFile 只出现在「欢迎页」和「完成页」的左侧大图位 ——
    WizardBitmapImage = 欢迎页那张、WizardBitmapImage2 = 完成页那张，两个都要换。
    DisableWelcomePage 在 Inno 6 里默认是 yes（欢迎页不显示），本脚本已在 [Setup] 里
    显式写了 DisableWelcomePage=no ⇒ 欢迎页是显示的，
    ⇒ 这套动画从向导开头（欢迎页）就开始播，装完的完成页上同样播（两块图位都换了图）。 }

const
  ANIM_FRAME_COUNT = 48;
  ANIM_INTERVAL    = 156;   { 7500ms / 48 帧 }

var
  AnimTimerID: Longword;
  AnimFrameIdx: Integer;
  AnimExtracted: Boolean;

function Anim_SetTimer(hWnd, nIDEvent, uElapse, lpTimerFunc: Longword): Longword;
  external 'SetTimer@user32.dll stdcall';

function Anim_KillTimer(hWnd, nIDEvent: Longword): Longword;
  external 'KillTimer@user32.dll stdcall';

{ frame-00.png .. frame-47.png。手动补零，不依赖 Format 的宽度语法 }
function AnimFrameName(Index: Integer): string;
begin
  Result := IntToStr(Index);
  if Length(Result) < 2 then Result := '0' + Result;
  Result := 'frame-' + Result + '.png';
end;

procedure AnimStop;
begin
  if AnimTimerID <> 0 then
  begin
    Anim_KillTimer(0, AnimTimerID);
    AnimTimerID := 0;
  end;
end;

{ SetTimer 的回调，参数个数/类型必须正好是这四个（CreateCallback 的硬要求） }
procedure AnimTick(Arg1, Arg2, Arg3, Arg4: Longword);
var
  F: string;
begin
  if WizardForm = nil then Exit;
  F := ExpandConstant('{tmp}\') + AnimFrameName(AnimFrameIdx);
  try
    { ★ PNG 不能走 Bitmap.LoadFromFile：Pascal Script 的 TBitmap 只认 BMP，
      PNG 要走 TBitmapImage.PngImage（Inno 6.5.2 起新增的支持类，
      本机 Examples\CodeClasses.iss 第 381 行原话："Use ...PngImage.LoadFromFile
      to load .png files"）。
      WizardBitmapImage 是欢迎页那张、WizardBitmapImage2 是完成页那张，
      两张不同时显示 ⇒ 按当前页挑一张贴，一帧只解码一次，不给安装拖后腿。 }
    if WizardForm.CurPageID = wpFinished then
      WizardForm.WizardBitmapImage2.PngImage.LoadFromFile(F)
    else
      WizardForm.WizardBitmapImage.PngImage.LoadFromFile(F);
  except
    { 万一这份 Inno 的 PngImage 路子不通，退回 Bitmap 再试一次；
      还不行就把动画停掉 —— 装个程序不能为一张图弹运行时错误框。 }
    try
      if WizardForm.CurPageID = wpFinished then
        WizardForm.WizardBitmapImage2.Bitmap.LoadFromFile(F)
      else
        WizardForm.WizardBitmapImage.Bitmap.LoadFromFile(F);
    except
      AnimStop;
    end;
  end;
  AnimFrameIdx := (AnimFrameIdx + 1) mod ANIM_FRAME_COUNT;
end;

procedure AnimStart;
var
  I: Integer;
begin
  if AnimTimerID <> 0 then Exit;
  if not AnimExtracted then
  begin
    for I := 0 to ANIM_FRAME_COUNT - 1 do
      ExtractTemporaryFile(AnimFrameName(I));
    AnimExtracted := True;
  end;
  { 帧是 656×1256，向导图位只有 164:314 那么大 ⇒ 必须由控件缩放。
    WizardImageFile 静态图是 Inno 自己缩的；运行时换图得把这个开关打开。 }
  WizardForm.WizardBitmapImage.Stretch := True;
  WizardForm.WizardBitmapImage2.Stretch := True;
  AnimFrameIdx := 0;
  AnimTimerID := Anim_SetTimer(0, 0, ANIM_INTERVAL, CreateCallback(@AnimTick));
end;

procedure InitializeWizard;
begin
  AnimStart;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  { ssDone = 用户点了「完成」。定时器到这一步必须收掉，否则向导关了它还在跑。
    （安装过程中它由消息循环驱动，主线程忙于解包时自然停下，不会抢安装的 CPU。） }
  if CurStep = ssDone then
    AnimStop;
end;

procedure DeinitializeSetup;
begin
  { 兜底：取消安装 / 出错退出 / ssDone 没走到，都在这里收干净 ——
    定时器不收就是内存泄漏 + 向导销毁后还在访问已释放的控件。 }
  AnimStop;
end;
