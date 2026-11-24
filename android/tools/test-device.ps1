<#
.SYNOPSIS
  Runs Sonus's device tests (app/src/androidTest) against the demo server, with no one at the screen.

.DESCRIPTION
  - Starts the demo server (tools/demo-server, account demo/demo) on port 4633 unless something answers there already.
  - Uses the connected devices (adb devices); with none, starts the "sonus-phone" emulator without a window and
    without sound, and stops it again at the end.
  - Forwards each device's 127.0.0.1:4633 to this PC's (adb reverse): the preview ARM64 emulator's apps cannot reach
    the PC at 10.0.2.2, and a phone reaches it the same way over USB or wireless debugging.
  - Runs gradlew :app:connectedDebugAndroidTest and copies the screenshots the tests took to android/screenshots.

  A phone is only used when it is connected and authorised for debugging; the tests install a separate test build
  (com.creeperux.sonus.debug) and remove it afterwards. The tests only ever talk to the local demo server.

.PARAMETER Avd
  The emulator to start when no device is connected (sonus-phone or sonus-tablet).
#>
param(
    [string]$Avd = "sonus-phone",
    [int]$Port = 4633
)

# native tools (gradle, adb) write progress to stderr: Windows PowerShell must not take that for an error
$ErrorActionPreference = "Continue"
$android = Split-Path -Parent $PSScriptRoot
$repo = Split-Path -Parent $android
if (-not $env:JAVA_HOME) { $env:JAVA_HOME = Get-ChildItem "$env:LOCALAPPDATA\Programs\jdk" -Directory | Select-Object -First 1 -ExpandProperty FullName }
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk" }
$adb = Join-Path $env:ANDROID_HOME "platform-tools\adb.exe"
$emulator = @("$env:ANDROID_HOME\emulators\latest\emulator.exe", "$env:ANDROID_HOME\emulator\emulator.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1

function Test-Server { try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$Port/rest/ping.view?f=json" | Out-Null; $true } catch { $false } }
function Get-Devices { & $adb devices | Select-String "^(\S+)\s+device$" | ForEach-Object { $_.Matches[0].Groups[1].Value } }

$server = $null
if (-not (Test-Server)) {
    Write-Host "Starting the demo server on port $Port"
    $server = Start-Process node -ArgumentList "`"$repo\tools\demo-server\demo-server.mjs`"", $Port -PassThru -WindowStyle Hidden
    for ($i = 0; $i -lt 50 -and -not (Test-Server); $i++) { Start-Sleep -Milliseconds 200 }
}

$started = $null
& $adb start-server | Out-Null
if (-not (Get-Devices)) {
    if (-not $emulator) { throw "No device connected and no emulator installed." }
    Write-Host "Starting the $Avd emulator (no window, no sound)"
    $started = Start-Process $emulator -ArgumentList "-avd", $Avd, "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot-save" -PassThru -WindowStyle Hidden
    & $adb wait-for-device
    for ($i = 0; $i -lt 180; $i++) {
        if ((& $adb shell getprop sys.boot_completed 2>$null) -match "1") { break }
        Start-Sleep -Seconds 2
    }
}

try {
    foreach ($d in Get-Devices) {
        & $adb -s $d reverse "tcp:$Port" "tcp:$Port" | Out-Null
        Write-Host "Device $d -> demo server at 127.0.0.1:$Port"
    }
    Push-Location $android
    try {
        & .\gradlew.bat ":app:connectedDebugAndroidTest" "-Psonus.testServer=http://127.0.0.1:$Port" --console=plain
        $result = $LASTEXITCODE
    } finally { Pop-Location }

    $shots = Join-Path $android "screenshots"
    New-Item -ItemType Directory -Force $shots | Out-Null
    Get-ChildItem (Join-Path $android "app\build\outputs\connected_android_test_additional_output") -Recurse -Filter *.png -ErrorAction SilentlyContinue |
        Copy-Item -Destination $shots -Force
    Write-Host "Screenshots: $shots"
    Write-Host "Report: $(Join-Path $android 'app\build\reports\androidTests\connected\debug\index.html')"
    exit $result
} finally {
    if ($started) { & $adb emu kill | Out-Null }
    if ($server) { Stop-Process -Id $server.Id -ErrorAction SilentlyContinue }
}
