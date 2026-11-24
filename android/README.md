# Sonus 安卓版

Sonus 的安卓客户端：连接你自己的 Sonus／Navidrome 服务器，浏览媒体库，后台播放。功能、行为和外观以 Windows 版（`src/Sonus`、`src/Sonus.Core`）为准。

- **最低系统**：Android 13（API 33）。编译目标为 Android 17（API 37.2）。
- **设备**：手机和平板各有一套布局。
  - 手机：底部三个标签（首页、搜索、音乐库），迷你播放条，全屏播放器（封面、歌词、队列）。
  - 平板：和 Windows 窗口相同的布局：顶栏，左侧音乐库，中间页面，右侧"正在播放"面板，底部播放栏。
  - 窄平板（600–860 dp）：音乐库收成一列封面；宽度不到 1100 dp 时不显示右侧面板。规则和 Windows 版的窗口宽度规则一致。
- **界面语言**：简体中文。代码注释为英文。

## 功能（第一版）

| 部分 | 内容 |
|---|---|
| 登录 | 两种方式，和 Windows 版相同。<br>① 用户名和密码：只保存服务器给的登录凭证（md5 token 和 salt），**不保存密码**。<br>② 在浏览器中登录（`sonusDeviceLogin`）：服务器发给这台设备一个专用 API 密钥；退出登录时把密钥交还服务器。<br>两种凭证都用 **Android Keystore** 里的 AES-256-GCM 密钥加密保存，并且不进入系统备份。<br>填写互联网上的 `http://` 地址时会给出提醒。 |
| 媒体库 | 用 `search3`（空查询，每页 500 首，三页并发）同步整个媒体库，用 `getAlbumList2` 读专辑，再读歌单，和 Windows 版的 `LibraryBuilder` 相同。<br>页面：首页（问候语、快捷入口、六个推荐栏）、音乐库（筛选、搜索、四种排序）、专辑、艺人（热门歌曲、唱片、简介、同流派艺人）、歌单（新建、重命名、删除、加歌、移除）、流派、搜索（最佳结果；歌曲、艺人、专辑、歌单）、设置。 |
| 播放 | 播放队列逐行移植自 Windows 版 `PlayQueue.cs`：手动加入的歌优先，支持随机（按曲目、专辑或文件夹）、列表循环、单曲循环、播完当前歌曲后停止。"上一首"在歌曲播放超过 3 秒时回到本曲开头。<br>Media3 ExoPlayer 运行在 `MediaSessionService` 里，提供后台播放、通知栏和锁屏控件，以及耳机、蓝牙和车机按键；这些按键也走同一个队列逻辑。<br>下一首会提前加载，实现无缝衔接。<br>回放增益只降低音量。<br>DSD、APE 等格式请服务器转码成 MP3。 |
| 封面 | 按屏幕实际像素向上取整到 64、128、256、512 或 1024 来请求，和 Windows 版相同；系统媒体控件用 512。<br>封面在内存缓存 64 MB，在磁盘缓存 256 MB。 |
| 歌词 | 优先使用 OpenSubsonic 的同步歌词，`offset` 为正数时歌词提前显示；没有时退回 `getLyrics`，按 LRC 解析。<br>当前行高亮并保持在视野内，点一行可以跳到那里。 |
| Scrobble | 歌曲真正开始播放时发送"正在播放"；播过一半或 4 分钟（取较早者）时记一次播放，和 Windows 版相同。 |
| 接着听 | 和 Windows 版一样用 `savePlayQueue` 保存队列：改动后 1.5 秒保存，暂停或换歌时立即保存，播放中每 30 秒保存一次。<br>启动时取回上次（或另一台设备）的队列，暂停在原来的位置，并提示"接着上次听"。 |

## 多设备同步（Sonus Connect v2）

服务器支持 Connect v2 时（`getOpenSubsonicExtensions` 里 `sonusConnect` 的版本包含 2），App 自动启用，规范见 `docs/protocol/connect.md`，行为和 Windows 版一致：

- **一个账号只有一个播放会话**，只有一台设备出声（"出声设备"）。所有设备都显示正在哪台设备上放什么，进度实时走。
- **命令都发给服务器**：在手机上点歌、加队列、切歌、拖进度、换播放顺序，都作用于出声设备。手机自己只在当前是出声设备时才出声，并把实际播放情况报告给服务器。
- **设备列表**：手机在全屏播放器底部，平板在播放栏右侧。列表里显示每台设备的状态（正在播放 / 已暂停 / 空闲），点一台就把播放切过去，原来的设备停下变成遥控器；每台设备都有音量条。
- **提示**：别的设备出声时，迷你播放条、全屏播放器、平板播放栏和右侧面板显示"正在「书房电脑」上播放"；都停下时显示"上次在「…」播放"。

你在设计时选定的三项：

| 项目 | 做法 |
|---|---|
| 音量 | 这台手机的音量就是系统媒体音量：别的设备调手机音量，等于调手机的媒体音量；手机上按音量键，别的设备也看得到变化。 |
| 后台连接 | App 在前台时保持连接。退到后台后，只要会话还在某台设备上播放（手机自己在放，或者锁屏上有遥控控件）就保持连接；会话停下一分钟后断开，回到 App 立刻重连。 |
| 遥控通知 | 别的设备在放歌时，手机的通知栏和锁屏显示那台设备的歌和进度，暂停、上一首、下一首、拖进度都发给那台设备。这时手机的音量键调的是那台设备的音量，系统音量面板显示为"Sonus 测试版"的远程音量，共 15 档。 |

代码位置：

- `core/.../connect/`：协议客户端 `SessionClient`（OkHttp WebSocket），以及会话、队列、设备的数据结构。
- `app/.../session/SessionLink.kt`：连接、命令、报告、音量和后台策略，对应 Windows 版的 `SessionService`。
- `LocalPlayback`：跟随会话，对应 Windows 版 `MusicService` 的同名逻辑。
- `QueuePlayer`：系统媒体控件的遥控模式。

服务器不支持 v2 时，App 照旧本机播放，并用 `savePlayQueue` 实现"接着上次听"。

## 目录

```
android/
  core/   纯 Kotlin：SubsonicClient、LibraryBuilder、PlayQueue、LyricsParser、DeviceLogin、Formats、HomeShelves
          （Sonus.Core 的移植；测试在电脑的 JVM 上运行，其中一组连接仓库里的演示服务器）
  app/    安卓 App：data（Keystore 加密保存登录、设置）、session（媒体库会话）、playback（Media3）、ui（Compose 界面）
  tools/  kit-icons.mjs（从 Windows 版生成图标）、test-device.ps1（一键运行设备测试）
```

## 开发环境（这台 Windows 11 ARM64 电脑）

全部装在用户文件夹，不需要管理员权限。

| 组件 | 位置 | 说明 |
|---|---|---|
| JDK 21 | `%LOCALAPPDATA%\Programs\jdk\jdk-21.0.13.1+2` | 微软 OpenJDK，ARM64 原生 |
| Android SDK | `%LOCALAPPDATA%\Android\Sdk` | 命令行工具、platform-tools、`platforms/android-37.2`、`build-tools/37.0.0` |
| 模拟器 | `%LOCALAPPDATA%\Android\Sdk\emulators\latest` | Google 官方 **预览版**（dev 渠道）ARM64 原生模拟器，需要 Windows 的"虚拟机监控程序平台"（WHPX，这台电脑已开启） |
| 系统镜像 | `system-images/android-37.0/default/arm64-v8a` | Android 17，AOSP 版（无 Google Play） |
| 虚拟设备 | `%USERPROFILE%\.android\avd\sonus-phone`、`sonus-tablet` | 手机 1080×2400、平板 2560×1600。配置文件是手写的：avdmanager 不认预览版模拟器 |

`android/local.properties`（不提交）写明 SDK 位置：

```
sdk.dir=C:/Users/<你>/AppData/Local/Android/Sdk
```

每个 PowerShell 窗口先设置一次环境变量：

```powershell
$env:JAVA_HOME = "$env:LOCALAPPDATA\Programs\jdk\jdk-21.0.13.1+2"; $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
```

## 构建

在 `android` 目录里：

```powershell
.\gradlew.bat :app:assembleDebug
```

测试版 APK 在 `app\build\outputs\apk\debug\app-debug.apk`。它的包名是 `com.creeperux.sonus.debug`，名字是"Sonus 测试版"，可以和正式版同时安装，数据互不相干。

```powershell
.\gradlew.bat :app:assembleRelease
```

正式版经过 R8 压缩，约 4.7 MB。目前没有签名（还没有发布密钥）。

## 运行（模拟器 + 演示服务器）

1. 启动演示服务器（仓库根目录）：

```powershell
node tools\demo-server\demo-server.mjs 4633
```

2. 启动模拟器（无窗口、静音，不打扰你）。想看画面就去掉 `-no-window`：

```powershell
& "$env:ANDROID_HOME\emulators\latest\emulator.exe" -avd sonus-phone -no-window -no-audio
```

3. 把模拟器的 `127.0.0.1:4633` 转到电脑上。**预览版模拟器里的 App 连不到 `10.0.2.2`**，所以用 `adb reverse`；真手机也用同样的办法：

```powershell
& "$env:ANDROID_HOME\platform-tools\adb.exe" reverse tcp:4633 tcp:4633
```

4. 安装并打开：

```powershell
& "$env:ANDROID_HOME\platform-tools\adb.exe" install -r app\build\outputs\apk\debug\app-debug.apk
```

5. 登录：服务器地址填 `127.0.0.1:4633`，账号 `demo`，密码 `demo`。

截图：

```powershell
& "$env:ANDROID_HOME\platform-tools\adb.exe" exec-out screencap -p > shot.png
```

## 测试

都不需要人去点屏幕。

**电脑上（不需要设备）**：核心库测试和 App 单元测试。

```powershell
.\gradlew.bat :core:test :app:testDebugUnitTest
```

- `core`：
  - 从 Windows 版 `tests/Sonus.Core.Tests` 逐条移植的单元测试：地址规范化、token、队列、歌词、格式等；
  - 用 MockWebServer 测客户端；
  - `DemoServerTest` 用 node 启动 `tools/demo-server`，测登录、分页同步、歌单、同步歌词、封面、音频流、scrobble、保存队列，以及浏览器登录的批准、拒绝和撤销。
- `app`（Robolectric）：
  - 登录凭证加密保存，偏好文件里看不到 token 或密钥；
  - 导航和返回键；
  - 封面尺寸档位；
  - 登录页的明文 HTTP 提醒。

**设备上**：端到端测试 `app/src/androidTest/.../DeviceTest.kt`。

```powershell
.\tools\test-device.ps1
```

脚本会：启动演示服务器；没有设备时无窗口、静音地启动模拟器；做 `adb reverse`；运行测试；把截图收集到 `android\screenshots\`（不提交）。测试内容：

- 登录，打开专辑并播放，确认服务器收到音频流请求和"正在播放"的 scrobble；
- 跳到歌曲一半处，确认记了一次播放；
- 回到桌面后音乐继续，系统媒体会话显示正确的歌名，通知栏出现媒体控件；
- 媒体键"下一首"和"暂停/继续"按队列执行；
- 同步歌词跟着走；
- 密码错误时给出提示；
- 浏览器登录拿到专用密钥（加密保存），退出登录后服务器立即拒绝这个密钥。

模拟器有手机（`sonus-phone`）和平板（`sonus-tablet`）两台。同时开着时，测试会在两台上都跑一遍：手机用 `demo` 账号，平板用 `friend` 账号。原因是一个账号只有一个播放会话，两台同时测会互相干扰。

**Connect v2 的测试**需要支持 v2 的演示服务器：

- `core` 的 `ConnectVectorsTest` 用协议的测试向量（`docs/protocol/connect-vectors.json`）逐步重放安卓版的队列，结果必须和服务器的参考逻辑一模一样；
- `ConnectDemoTest` 让两台设备连同一个演示服务器，测切歌、暂停、调对方音量、切换出声设备；
- 设备上的 `ConnectDeviceTest` 让测试程序扮演"测试电脑"：它放歌，App 显示并遥控它（App 按钮、系统媒体控件），它调 App 的音量，最后在设备列表里把播放切回 App。

演示服务器的 v2 还没合进主干时，用 `SONUS_DEMO_REPO` 指向带 v2 的检出（比如 Windows 会话的工作目录），没有 v2 时这几个测试会自动跳过：

```powershell
$env:SONUS_DEMO_REPO = "<带 Connect v2 演示服务器的检出目录>"; .\gradlew.bat :core:test; .\tools\test-device.ps1
```

## 在你自己的手机上试用

只在你同意的情况下做。装的是独立的测试版，不碰手机上的其他数据。

1. 手机上打开"开发者选项"里的"无线调试"，然后配对：

```powershell
& "$env:ANDROID_HOME\platform-tools\adb.exe" pair <手机显示的IP:端口>
```

2. 连接：

```powershell
& "$env:ANDROID_HOME\platform-tools\adb.exe" connect <IP:端口>
```

3. 安装测试版、做 `adb reverse`，步骤同上。手机就能通过 `127.0.0.1:4633` 用电脑上的演示服务器。
4. 卸载：

```powershell
& "$env:ANDROID_HOME\platform-tools\adb.exe" uninstall com.creeperux.sonus.debug
```

## 图标和字体

- **图标**：`app/.../ui/icons/KitIconData.kt` 由 `node android/tools/kit-icons.mjs` 从 Windows 版的 `src/Sonus/Controls/KitIcons.g.cs` 生成，来自 CreeperUX 设计套件的 77 个图标轮廓。不要手改。
- **字体**：标题字体 Chakra Petch SemiBold 和 Windows 版相同，依 SIL OFL 1.1 授权，许可证文本在 `app/src/main/assets/licenses/`。中文自动用系统字体，按粗体显示。
- **颜色**：深色取自 Windows 版 `App.xaml`，浅色取自 Web 版和设计套件。外观可以在设置里选：跟随系统、深色或浅色。

## 已知限制（第一版）

- 在 Connect v2 的通知栏里，系统输出切换标签仍写"This phone"。这是系统界面，App 改不了。
- 没有离线下载，没有媒体库本地缓存（每次启动都会从服务器读媒体库）。
- 正式版没有签名密钥，也没有自动发布或 CI。
- 平板在竖屏和横屏下都能用，但只在模拟器上看过横屏截图。
