param([ValidateSet('x64', 'ARM64')][string[]]$Arch = @('x64', 'ARM64'), [switch]$Extract)
# Builds CreeperUX Music's installers, as Lumen's tools\package.ps1: dist\CreeperUX-Music-<version>-<arch>.msi
# (installer\Package.wxs, WiX v5 restored from nuget.org), and dist\CreeperUX-Music-<version>-<arch>-setup.exe, the
# installer people run (and the app's updates download): the setup window around that MSI (src\CreeperUX.Music.Setup,
# self-contained single file).
#   .\tools\package.ps1                 both architectures
#   .\tools\package.ps1 -Arch x64       one
#   -Extract                            also unpack each MSI (administrative install: files only, nothing registered or
#                                       installed) into installer\bin\<arch>\extract, to test what the package contains
#                                       (node tools/e2e/acceptance.mjs --arch=<arch> --exe=<the unpacked exe>)
# The version is <Version> in src\CreeperUX.Music\CreeperUX.Music.csproj. Nothing here installs anything or touches the
# user's own copy of the app.
$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path "$PSScriptRoot\..").Path
$Installer = "$RepoRoot\installer"
$Dist = "$RepoRoot\dist"
$AppProject = "$RepoRoot\src\CreeperUX.Music\CreeperUX.Music.csproj"
$version = ([xml](Get-Content $AppProject -Raw -Encoding utf8)).Project.PropertyGroup.Version | Where-Object { $_ } | Select-Object -First 1
if (-not $version) { throw "在 $AppProject 里找不到 <Version>" }

# Installer artwork from the app icon, for the MSI's own dialogs (double-clicked): the welcome / finish dialogs' left
# panel and the progress page's banner
function New-InstallerArt([string]$Dir) {
    Add-Type -AssemblyName System.Drawing
    New-Item -ItemType Directory -Force $Dir | Out-Null
    $icon = [Drawing.Image]::FromFile("$RepoRoot\assets\icon-256.png")
    try {
        # WixUI writes its text on the right of the dialog bitmap: art in the left 164 px, white elsewhere
        $dialog = New-Object Drawing.Bitmap 493, 312
        $g = [Drawing.Graphics]::FromImage($dialog)
        $g.InterpolationMode = 'HighQualityBicubic'
        $g.Clear([Drawing.Color]::White)
        $panel = New-Object Drawing.Rectangle 0, 0, 164, 312
        $fill = New-Object Drawing.Drawing2D.LinearGradientBrush($panel, [Drawing.Color]::FromArgb(0x1E, 0x26, 0x2B), [Drawing.Color]::FromArgb(0x0C, 0x10, 0x13), 90.0)
        $g.FillRectangle($fill, $panel)
        $g.DrawImage($icon, 34, 100, 96, 96)
        $g.Dispose()
        $dialog.Save("$Dir\dialog.bmp", [Drawing.Imaging.ImageFormat]::Bmp)
        $dialog.Dispose()

        # The banner's left part holds the page title: the icon goes on the right
        $banner = New-Object Drawing.Bitmap 493, 58
        $g = [Drawing.Graphics]::FromImage($banner)
        $g.InterpolationMode = 'HighQualityBicubic'
        $g.Clear([Drawing.Color]::White)
        $g.DrawImage($icon, 493 - 14 - 40, 9, 40, 40)
        $g.Dispose()
        $banner.Save("$Dir\banner.bmp", [Drawing.Imaging.ImageFormat]::Bmp)
        $banner.Dispose()
    }
    finally { $icon.Dispose() }
}

$art = "$Installer\obj\art"
New-InstallerArt $art
New-Item -ItemType Directory -Force $Dist | Out-Null

foreach ($a in $Arch) {
    $rid = "win-$($a.ToLowerInvariant())"
    $work = "$Installer\bin\$a"
    $publish = "$work\publish"
    Remove-Item -Recurse -Force $publish -ErrorAction SilentlyContinue

    # A trailing "/", not "\": a backslash before the closing quote would escape it.
    # Release, self-contained (.NET and the Windows App SDK inside); not trimmed: WinUI and the JSON settings use reflection
    $log = & dotnet publish $AppProject -c Release "-p:Platform=$a" -r $rid --self-contained `
        -p:PublishTrimmed=false "-p:PublishDir=$publish/" -nologo -v:q 2>&1
    if ($LASTEXITCODE -ne 0) { throw "发布 $a 失败：`n$(($log | Select-Object -Last 20) -join "`n")" }
    # the app's resource index (its compiled XAML) above all: without it the window cannot start
    foreach ($needed in 'CreeperUX Music.exe', 'CreeperUX Music.pri', 'Microsoft.UI.Xaml.dll','Assets\AppIcon.ico', 'Assets\Fonts\ChakraPetch-SemiBold.ttf', 'Assets\Fonts\OFL-Chakra-Petch.txt') {
        if (-not (Test-Path "$publish\$needed")) { throw "$publish 里没有 $needed" }
    }
    "PUBLISH $a ok：$((Get-ChildItem $publish -Recurse -File).Count) 个文件，$([math]::Round(((Get-ChildItem $publish -Recurse -File | Measure-Object Length -Sum).Sum) / 1MB)) MB"

    $log = & dotnet build "$Installer\CreeperUX.Music.Installer.wixproj" -c Release "-p:Platform=$a" "-p:PublishDir=$publish" `
        "-p:AppVersion=$version" "-p:ArtDir=$art" "-p:OutputPath=$work\msi/" -nologo -v:q 2>&1
    $code = $LASTEXITCODE
    $log | Select-String -Pattern '\b(error|warning) [A-Z]+\d+' | Select-Object -Unique -First 20 | ForEach-Object { $_.Line.Trim() }
    if ($code -ne 0) { throw "生成 $a 安装包失败：`n$(($log | Select-String 'error' | Select-Object -First 10) -join "`n")" }
    $msi = Get-ChildItem "$work\msi" -Recurse -Filter *.msi | Select-Object -First 1
    Copy-Item $msi.FullName $Dist -Force
    "MSI $a ok：dist\$($msi.Name)，$([math]::Round($msi.Length / 1MB)) MB"

    # The setup window with that MSI inside: one file, its own runtime (nothing to install first, as the app)
    $setupOut = "$work\setup"
    Remove-Item -Recurse -Force $setupOut -ErrorAction SilentlyContinue
    $log = & dotnet publish "$RepoRoot\src\CreeperUX.Music.Setup\CreeperUX.Music.Setup.csproj" -c Release -r $rid "-p:Version=$version" `
        "-p:MsiPath=$($msi.FullName)" "-p:PublishDir=$setupOut/" -p:DebugType=none -nologo -v:q 2>&1
    if ($LASTEXITCODE -ne 0) { throw "生成 $a 安装程序失败：`n$(($log | Select-Object -Last 20) -join "`n")" }
    $setup = "$Dist\CreeperUX-Music-$version-$a-setup.exe"
    Copy-Item "$setupOut\CreeperUX-Music-Setup.exe" $setup -Force
    "SETUP $a ok：dist\$(Split-Path $setup -Leaf)，$([math]::Round((Get-Item $setup).Length / 1MB)) MB"

    if ($Extract) {
        $target = "$work\extract"
        Remove-Item -Recurse -Force $target -ErrorAction SilentlyContinue
        $p = Start-Process msiexec.exe -ArgumentList '/a', "`"$Dist\$($msi.Name)`"", '/qn', "TARGETDIR=`"$target`"" -Wait -PassThru
        $exe = Get-ChildItem $target -Recurse -Filter 'CreeperUX Music.exe' | Select-Object -First 1
        if ($p.ExitCode -ne 0 -or -not $exe) { throw "解包 $a 失败（msiexec 退出码 $($p.ExitCode)）" }
        "EXTRACT $a ok：$($exe.FullName)"
    }
}
