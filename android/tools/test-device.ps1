<#
.SYNOPSIS
  Runs Sonus's device tests (app/src/androidTest) against the demo server, or a Sonus server, with no one at the screen.

.DESCRIPTION
  - Against the demo server (the default): starts it (tools/demo-server, accounts demo and friend) on port 4633 unless
    something answers there already.
  - Against another server (-Server with -Credentials): a Sonus server on this machine, as tools/server-library.mjs
    starts it, with the throwaway users of its credentials file (never printed).
  - Uses the connected devices (adb devices); with none, starts the -Avd emulators without a window and without
    sound, and stops them again at the end.
  - Forwards each device's 127.0.0.1:<port> to this PC's (adb reverse): the preview ARM64 emulator's apps cannot reach
    the PC at 10.0.2.2, and a phone reaches it the same way over USB or wireless debugging.
  - Runs gradlew :app:connectedDebugAndroidTest and copies the screenshots the tests took to android/screenshots.

  A phone is only used when it is connected and authorised for debugging; the tests install a separate test build
  (com.creeperux.sonus.debug) and remove it afterwards. The tests only ever talk to the server given here.

.PARAMETER Avd
  The emulators to start when no device is connected (sonus-phone, sonus-tablet, or both).

.PARAMETER DemoRepo
  The checkout whose demo server to start (default: SONUS_DEMO_REPO, else this repository): one whose demo server speaks
  Sonus Connect v2 for the Connect tests, which are skipped otherwise.

  On a phone the tests sign in as demo, on a tablet as friend: one account is one playback session, and the tests run on
  every connected device at once.

.PARAMETER Server
  Another server's address on this machine (http://127.0.0.1:<port>), instead of the demo server.

.PARAMETER Credentials
  With -Server: the credentials file tools/server-library.mjs wrote (users main, other and twoStep; manifest.missingFile).
  The phone signs in as main, the tablet as other.

.PARAMETER Only
  Runs only these tests: a class, or class#method (com.creeperux.sonus. may be left out); several separated by commas.
#>
param(
    [string[]]$Avd = @("sonus-phone"),
    [int]$Port = 4633,
    [string]$DemoRepo = $env:SONUS_DEMO_REPO,
    [string]$Server,
    [string]$Credentials,
    [string]$Only
)

# native tools (gradle, adb) write progress to stderr: Windows PowerShell must not take that for an error
$ErrorActionPreference = "Continue"
$android = Split-Path -Parent $PSScriptRoot
$repo = Split-Path -Parent $android
if (-not $DemoRepo) { $DemoRepo = $repo }
if (-not $env:JAVA_HOME) { $env:JAVA_HOME = Get-ChildItem "$env:LOCALAPPDATA\Programs\jdk" -Directory | Select-Object -First 1 -ExpandProperty FullName }
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk" }
$adb = Join-Path $env:ANDROID_HOME "platform-tools\adb.exe"
$emulator = @("$env:ANDROID_HOME\emulators\latest\emulator.exe", "$env:ANDROID_HOME\emulator\emulator.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1

$testArgs = @()
if ($Server) {
    if (-not $Credentials) { throw "-Server needs -Credentials (the file tools/server-library.mjs wrote)." }
    $Port = ([Uri]$Server).Port
    $c = Get-Content -Raw -Encoding UTF8 $Credentials | ConvertFrom-Json
    $prefix = "-Pandroid.testInstrumentationRunnerArguments"
    $testArgs += "$prefix.sonusUser=$($c.users.main.username)", "$prefix.sonusPassword=$($c.users.main.password)"
    $testArgs += "$prefix.sonusUser2=$($c.users.other.username)", "$prefix.sonusPassword2=$($c.users.other.password)"
    if ($c.users.twoStep) {
        $testArgs += "$prefix.sonusTwoStepUser=$($c.users.twoStep.username)", "$prefix.sonusTwoStepPassword=$($c.users.twoStep.password)", "$prefix.sonusTwoStepSecret=$($c.users.twoStep.secret)"
    }
    if ($c.manifest.missingFile) { $testArgs += "$prefix.sonusMissing=$($c.manifest.missingFile)" }
}

function Test-Server { try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$Port/rest/ping.view?f=json" | Out-Null; $true } catch { $false } }
function Get-Devices { & $adb devices | Select-String "^(\S+)\s+device$" | ForEach-Object { $_.Matches[0].Groups[1].Value } }

$demo = $null
if ($Only) {
    $classes = ($Only -split "," | ForEach-Object { $t = $_.Trim(); if ($t -notlike "*.*") { "com.creeperux.sonus.$t" } else { $t } }) -join ","
    $testArgs += "-Pandroid.testInstrumentationRunnerArguments.class=$classes"
}
if (-not $Server -and -not (Test-Server)) {
    Write-Host "Starting the demo server on port $Port"
    $demo = Start-Process node -ArgumentList "`"$DemoRepo\tools\demo-server\demo-server.mjs`"", $Port -PassThru -WindowStyle Hidden
    for ($i = 0; $i -lt 50 -and -not (Test-Server); $i++) { Start-Sleep -Milliseconds 200 }
}
if ($Server -and -not (Test-Server)) { throw "Nothing answers at $Server." }

$started = @()
& $adb start-server | Out-Null
if (-not (Get-Devices)) {
    if (-not $emulator) { throw "No device connected and no emulator installed." }
    $serial = 5554
    foreach ($name in $Avd) {
        Write-Host "Starting the $name emulator (no window, no sound) as emulator-$serial"
        $p = Start-Process $emulator -ArgumentList "-avd", $name, "-port", $serial, "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot-save" -PassThru -WindowStyle Hidden
        $started += [pscustomobject]@{ Process = $p; Serial = "emulator-$serial" }
        $serial += 2
    }
    foreach ($e in $started) {
        & $adb -s $e.Serial wait-for-device
        for ($i = 0; $i -lt 180; $i++) {
            if ((& $adb -s $e.Serial shell getprop sys.boot_completed 2>$null) -match "1") { break }
            Start-Sleep -Seconds 2
        }
    }
}

try {
    foreach ($d in Get-Devices) {
        & $adb -s $d reverse "tcp:$Port" "tcp:$Port" | Out-Null
        Write-Host "Device $d -> server at 127.0.0.1:$Port"
    }
    Push-Location $android
    try {
        & .\gradlew.bat ":app:connectedDebugAndroidTest" "-Psonus.testServer=http://127.0.0.1:$Port" @testArgs --console=plain
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
    foreach ($e in $started) {
        & $adb -s $e.Serial emu kill | Out-Null
        Start-Sleep -Seconds 3
        if (-not $e.Process.HasExited) { Stop-Process -Id $e.Process.Id -Force -ErrorAction SilentlyContinue }
    }
    if ($demo) { Stop-Process -Id $demo.Id -ErrorAction SilentlyContinue }
}
