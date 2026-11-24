# Sonus

连接你自己的 **Navidrome**（或任何兼容 Subsonic 的服务器）的 Windows 音乐播放器。界面参考 Spotify 的布局，用 **WinUI 3 / .NET 10** 原生实现，支持 x64 和 ARM64。
曲库、歌单、喜欢、播放次数和“接着听”的队列都保存在服务器上，所有设备共用；手机可以用任何 Subsonic 客户端连同一个服务器。
0.3 及更早的版本叫 CreeperUX Music，从 0.4 起改名为 Sonus。

## 安装与更新

从 GitHub 的 [Releases](https://github.com/CreeperUX/Sonus/releases) 下载这台电脑架构的安装程序（`Sonus-<版本>-x64-setup.exe` 或 `-ARM64-setup.exe`）运行即可：只为当前用户安装，不需要管理员权限，装在 `%LOCALAPPDATA%\Programs\Sonus`。升级时再运行新版本的安装程序，登录和设置保留。

程序自己会检查更新（和 Lumen 同样的做法）：启动后每天查一次 GitHub 的 Release，有新版本时右上角出现「新版本」，点它看版本说明，下载安装程序（按 GitHub 记录的 SHA-256 校验）后关闭程序、打开安装程序。仓库是公开的，检查和下载都不用登录，也不用填令牌（GitHub 对不登录的请求每个网络地址每小时限 60 次，每天查一次绰绰有余）。0.5.0 及更早的版本为私有仓库保存的 GitHub 令牌（凭据管理器里的 `Sonus:github`）在新版本第一次启动时删掉。

从 0.3（CreeperUX Music）升级：在旧版本里点「新版本」，或直接运行新的安装程序，都会替换旧版本（同一个 MSI 的升级）。Sonus 第一次启动时把旧的数据目录 `%LOCALAPPDATA%\CreeperUX Music` 搬到 `%LOCALAPPDATA%\Sonus`，把凭据管理器里的 `CreeperUXMusic:server` 改存为 `Sonus:server`，所以不用重新登录（旧的 `CreeperUXMusic:github` 令牌已经用不上，直接删掉）。开始菜单的快捷方式换成「Sonus」；固定在任务栏上的旧图标指向已删除的旧程序，需要重新固定。程序对服务器报的客户端名也从 `CreeperUX Music (<电脑名>)` 变成 `Sonus (<电脑名>)`，Navidrome 会把它记成一个新播放器（旧的那条可以在 Navidrome 的「播放器」里删掉）。

## 先看演示

不需要服务器：项目自带一个演示服务器，曲库是虚构的（17 位艺人、34 张专辑、293 首），每首歌都有现场合成的音乐，能真正听到。

```bash
npm run demo             # 演示服务器 + Windows 程序（第一次会先编译，需要 .NET 10 SDK）
```

也可以双击 `演示 Sonus.cmd`。程序打开后点“使用本机的演示服务器”登录（账号 demo / demo）；关掉窗口，演示服务器也随之停止。

值得试的地方：

- 双击任意歌曲播放，拖进度条；一首播完会无缝接上下一首（下一首在 MediaPlaybackList 里提前载入）。
- 放不出来的歌（比如服务器上文件丢了）会像 Spotify 一样跳过，并提示是哪一首；连续 5 首都放不出来才停下，播放键变成“重试”。
- 键盘上的播放、暂停、上一首、下一首键，以及音量浮窗里的媒体卡片都能控制它。
- 歌曲的“更多选项”→ **开始电台**：从这首歌开始，接着是相似的歌。
- 艺人页底部的**简介**；右栏的歌词卡片和“全屏查看歌词”。
- **界面缩放**：设置 → 显示（80%–125%），或 Ctrl + = / Ctrl + - / Ctrl + 0，像浏览器一样整窗重新排版。
- **换设备接着听**：播一会儿再暂停，然后用 `npm run demo:browser` 在浏览器里（网页版客户端）登录同一个演示服务器，会停在同一首歌的同一位置，并提示“接着播放”。

## 连接你自己的 Navidrome

登录页先填服务器地址（如 `https://music.example.com` 或 `http://192.168.1.10:4533`），然后二选一：

- **用户名和密码**：程序只保存由密码算出的登录令牌（Subsonic 的 token 认证，md5(密码 + salt)），这个令牌对 Subsonic API 等同于密码。服务器开了二步验证时账号密码在这里用不了，要在服务器网页的个人设置里生成一个“应用专用密码”填进密码栏，或者改用下面的方式。
- **在浏览器中登录**（需要 CreeperUX 改版的 Navidrome）：点“在浏览器中登录”，程序显示一个代码（如 `BCDF-GHJK`），并在浏览器里打开服务器的允许页。在网页上登录（开着二步验证时输验证码），确认网页上是同一个代码，点“允许”，程序就自动登录了。程序拿到的是服务器专门发给这台电脑的 API 密钥（OpenSubsonic 的 `apiKeyAuthentication`），从头到尾不经手账号密码；它列在网页个人设置的“应用专用密码”里，名为“Sonus · <电脑名>”，随时可以撤销。在 Sonus 里退出登录时会把密钥还给服务器，随即失效。服务器不支持时，程序会提示改用用户名和密码。
- 登录信息存在 **Windows 凭据管理器**里（“控制面板 → 凭据管理器 → Windows 凭据”中的 `Sonus:server`）：令牌或 API 密钥，都不含密码。设置页的“账号”一节写明用的是哪种登录方式。
- 地址不写 `http://` 或 `https://` 时：本机、局域网（10.x、172.16–31.x、192.168.x、不带点的主机名、`.local`、`.lan` 等）和 Tailscale（100.64–127.x、`.ts.net`）的地址先试 HTTP，连不上再试 HTTPS；其他地址用 HTTPS。
- 外网访问请走 HTTPS，或者通过 Tailscale 这类虚拟内网连接。令牌或 API 密钥在每个请求的网址里，明文 HTTP 会让它在网上可见；填了外网的 `http://` 地址时，登录页和设置页会提醒。
- 歌曲电台和艺人简介需要在 Navidrome 里配置 Last.fm；没有时，电台改为同艺人、同流派的歌。
- Windows 解不了的格式（DSD、APE、WavPack、TTA 等）会请服务器转码成 MP3（Navidrome 默认就有 MP3 转码）。

## 跨设备控制（Sonus Connect）

像 Spotify Connect 一样。服务器的 OpenSubsonic 扩展 `sonusConnect` 列出第 2 版时用第 2 版（协议见 `docs/protocol/connect.md`）；只列出第 1 版时（今天的改版 Navidrome）用第 1 版；都没有时只在本机播放，“设备”按钮不出现，其余功能不受影响。

### 第 2 版：一个账号一个播放会话，保存在服务器上

- 同一账号同时只有一台设备出声（正在出声的设备）。每台设备一打开就显示这个会话：放的哪首、进度实时走、在哪台放。播放条和右栏写着琥珀色的“正在「手机」上播放”；都不放时写“上次在「书房电脑」播放”。
- 在任何一台点歌、加队列、切歌、拖进度、改随机 / 循环、播完停止，都作用于这一个会话，正在出声的那台跟着变；队列只有一份。
- 只有播放条右侧的“设备”按钮能换出声的设备：选一台（包括“这台电脑”），播放从同一首、同一位置转过去，原来那台立刻停下，变成遥控器。
- 设备列表里每台设备下面有自己的音量条：音量属于每台设备，任何一台都能调任何一台的。播放条上的音量、静音和 Ctrl + ↑ ↓ 调的是正在出声的那台。
- 都关掉后会话留在服务器上：哪台按播放，就从原处接着放，并成为出声的设备。所以第 2 版不再有启动时的“接着上次听”提示，也不再用 `savePlayQueue` / `getPlayQueue`。
- 出声的设备断网时照样播放，自己重连（1 秒起，每次加倍，最多 30 秒）：10 秒内回来仍是出声的设备；更晚回来、而会话在这期间没变时，凭 `resume` 接着当出声的设备。服务器那边等满 10 秒就把会话停在断线时的位置。断网期间这台只能暂停、播放、拖进度，其余操作提示稍后再试。在出声的设备上关掉程序或退出登录不算断网（连接是正常关闭的）：会话立刻停在原处，别的设备马上就能接着放。
- 每台设备第一次连上时生成自己的设备 id，存在数据目录的 `settings.json` 里（`ConnectDeviceId`），重连、重启后还是同一台设备。
- 播放次数（scrobble）由出声的设备上报，和以前一样。
- 服务器端的会话逻辑先在演示服务器里写成参考实现：`tools/demo-server/connect-session.mjs`（队列与程序的 `PlayQueue.cs` 一致），它的测试和测试向量 `docs/protocol/connect-vectors.json` 以后同样用来检验 Rust 服务器。改版 Navidrome 还没有第 2 版。演示服务器在 `rest/connect?protocol=2` 提供它；环境变量 `SONUS_DEMO_CONNECT=1` 让演示服务器只列出第 1 版（程序就退回第 1 版），`SONUS_DEMO_CONNECT_STORE=<文件>` 让会话在演示服务器重启后还在。

### 第 1 版：遥控另一台设备

播放条右侧的“设备”按钮列出同一账号下在线的设备，以及它们各自在放什么。每台设备各放各的。

- 选中另一台设备后，播放条显示那台设备在放的歌（下面一行琥珀色的“正在「…」上播放”），播放、暂停、上一首、下一首、拖动进度、音量，以及空格和 Ctrl + 方向键，控制的都是那台设备。
- 选中时，如果当前这台正在播放，播放会转过去（对方从同一首歌、同一位置接着放，这边停下）；如果这台暂停着、对方又空闲，也会转过去（到对方那里同样是暂停）；其他情况只遥控，不打断对方正在放的东西。选回“这台电脑”时同理。
- 需要服务器支持：原版 Navidrome 没有这个功能，要用 CreeperUX 改版的 Navidrome（[CreeperUX/navidrome](https://github.com/CreeperUX/navidrome) 的 `creeperux` 分支，协议见那边的 `server/connect/README.md`）。演示服务器也实现了同一协议（`server/connect.mjs`）。服务器没有时，设备按钮不出现，其余功能不受影响。
- 改版从 2026-11-24 起冻结在 Navidrome 0.64.2，不再合并上游，独立开发；上游的安全修复由我们按需手动补上（见 fork 的 `SONUS.md`）。
- 改版的 Docker 镜像由 fork 的 GitHub Actions 在每次推送 `creeperux` 分支时、以及每周一自动构建（每周那次是为了带上 Alpine 系统包的安全更新）：`ghcr.io/creeperux/navidrome`（linux/amd64、linux/arm64；标签 `latest`、`0.64.2-sonus.<n>`，n 是冻结后的提交数，如 `0.64.2-sonus.9`，以及 `sha-<提交>`；更早的构建是 `0.64.2-sonus`、`0.64.2-creeperux`），公开可拉取。它的网页界面也换成了 Sonus 的名字、图标和默认的 Sonus 主题，接口仍报 `navidrome`，其他客户端照常能用。docker-compose 里只要把 `image: deluan/navidrome:latest` 换成 `image: ghcr.io/creeperux/navidrome:latest`，数据目录不变；改版不改数据库，换回原版镜像即可回退。Unraid 上开着自动更新（如 CA Auto Update Applications）时，推送后第二天就会装上新镜像。

## 服务器提供什么，程序做什么

| 功能 | 由谁负责 | Subsonic / OpenSubsonic 调用 |
| --- | --- | --- |
| 登录 | 服务器 | token 认证（`u`、`t`、`s`），或 API 密钥（`apiKey`，OpenSubsonic 的 `apiKeyAuthentication`）：在浏览器中登录时由改版的 `sonusDeviceLogin`（`/auth/device/start`、`poll`、`revoke`）发给程序 |
| 曲库、专辑、艺人 | 服务器 | `search3`（空查询分页取全部歌曲）、`getAlbumList2` |
| 播放 | 程序：Windows `MediaPlayer` + `MediaPlaybackList`（正在播放和下一首） | `stream`（必要时 `format=mp3`） |
| 系统媒体控制 | 程序：`MediaPlayer` 自带；上一首 / 下一首交给程序的队列 | — |
| 播放次数、最近播放 | 服务器 | `scrobble`：开始时“正在播放”，播过一半或 4 分钟时计一次 |
| 喜欢 | 服务器 | `star` / `unstar`；“我喜欢的音乐”就是收藏的歌 |
| 歌单 | 服务器 | `getPlaylists`、`createPlaylist`（新建，或整体覆盖用于排序）、`updatePlaylist`、`deletePlaylist`；别人的歌单只能播放 |
| 封面、歌词、搜索 | 服务器 | `getCoverArt`、`getLyricsBySongId`（同步歌词）/ `getLyrics`、`search3` |
| 换设备接着听 | 服务器存档 | Connect 第 2 版：会话本身就在服务器上。第 1 版和没有 Connect 时：换歌、暂停、拖动、每 30 秒和关窗时 `savePlayQueue`；启动和窗口回到前台时 `getPlayQueue` |
| 跨设备控制 | 服务器（OpenSubsonic 扩展 `sonusConnect`） | 第 2 版：`rest/connect?protocol=2`（WebSocket）：会话、队列、设备、命令、出声设备的报告（演示服务器；Rust 服务器以后实现）。第 1 版：`rest/connect`（CreeperUX 改版 Navidrome）：设备列表、播放状态、遥控命令、转移播放 |
| 歌曲电台、艺人简介 | 服务器 | `getSimilarSongs2`、`getArtistInfo2` |
| 队列、播放顺序、播完停止 | 程序；Connect 第 2 版时是服务器上的会话（逻辑和程序的 `PlayQueue` 一样） | — |
| 回放增益、输出设备 | 程序 | — |
| 和其他设备同步 | — | 窗口回到前台（间隔一分钟以上）和每次刷新时重读歌单；歌曲数变了就重读曲库 |

## 结构

| 路径 | 内容 |
| --- | --- |
| `src/Sonus.Core` | 不依赖界面的核心库：Subsonic 客户端、曲库分组、播放队列与播放顺序、歌词解析、文字格式 |
| `src/Sonus` | WinUI 3 程序：`Services/MusicService.cs`（状态与操作）、`Playback/AudioEngine.cs`（MediaPlayer，全部在自己的线程上调用）、`MainWindow`（顶栏、三栏、播放条）、`Pages/`、`Controls/`、`Testing/E2EChannel.cs`（测试通道） |
| `tests/Sonus.Core.Tests` | 核心库测试（xUnit）：单元测试 + 对演示服务器的集成测试 |
| `server/` | Sonus 服务器（Rust，AGPL-3.0，正在开发）：先作为网关挡在冻结版 Navidrome 前面，再逐块接管。见 `server/README.md` 和路线图 `docs/server-roadmap.md` |
| `tools/demo-server/` | 演示服务器：`demo-server.mjs`（API）、`catalogue.mjs`（虚构曲库）、`synth.mjs`（合成音乐）、`connect.mjs`（跨设备控制第 1 版）、`connect2.mjs` 和 `connect-session.mjs`（第 2 版：WebSocket 和会话逻辑）、`connect-vectors.mjs`（生成测试向量）、`covers/`（封面 JPEG） |
| `src/Sonus.Setup` | 安装程序窗口（WPF，和 Lumen 的一样）：里面带着 MSI，关掉 Windows Installer 自己的界面来运行它 |
| `installer/` | MSI（WiX v5，`Package.wxs`）：按用户安装、开始菜单快捷方式 |
| `docs/release-notes/` | 每个版本的说明，发布时作为 GitHub Release 的正文（程序的更新对话框也显示它） |
| `tools/e2e/` | 静默的端到端测试：`acceptance.mjs`（多轮验收）、`connect-v2.mjs`（两个测试实例之间的 Connect 第 2 版）、`e2e.mjs`（测试实例、管道、截图）、`fake-github.mjs`（检查更新用的假 GitHub） |
| `tools/demo.mjs` | 一键演示 |
| `web/` | 网页版客户端（同一套功能的浏览器版本，演示服务器在 `/` 提供它）；`tools/check-web.mjs` 是它的验收 |
| `assets/` | 图标（`tools/icon.mjs` 生成，与 foobar2k 同一款：深色底上的琥珀色圆环和播放符号）。`node tools/icon.mjs preview` 生成所有候选设计的对照图，`node tools/icon.mjs build <设计>` 换图标 |

## 编译

```bash
dotnet build src/Sonus/Sonus.csproj -p:Platform=x64     # 或 -p:Platform=ARM64
dotnet test tests/Sonus.Core.Tests
```

程序是不打包、自带运行库的 WinUI 3 应用（与 Lumen 相同的设置），编译输出可以直接运行。数据目录是 `%LOCALAPPDATA%\Sonus`（设置、日志）。

## 打包与发布

```powershell
npm run package                                        # 两个架构：dist\ 里的 MSI 和安装程序
powershell -File tools/package.ps1 -Arch x64 -Extract  # 一个架构，并把 MSI 解包出来测试
```

版本号在 `src/Sonus/Sonus.csproj` 的 `<Version>`。`tools/package.ps1` 先发布程序（Release、自带运行库），再用 WiX v5 生成 `Sonus-<版本>-<架构>.msi`，最后把它装进安装程序窗口，得到 `Sonus-<版本>-<架构>-setup.exe`。程序检查更新时按这个文件名找安装程序，所以不要改名。同一个安装程序还会复制一份 `CreeperUX-Music-<版本>-<架构>-setup.exe`：0.3 及更早的版本按这个旧名字找更新，发布时一并附上，等不再有人用 0.3 时就可以去掉。

- 测试安装包不要真的安装：`-Extract` 用 `msiexec /a` 只把文件解到 `installer\bin\<架构>\extract`（不注册、不安装），再用 `node tools/e2e/acceptance.mjs --arch=<架构> --exe=<解出的 Sonus.exe>` 跑验收。
- 安装程序也不真的运行：`Sonus-Setup.exe --shots <目录>` 把每一页画成 PNG，`--extract-msi <文件>` 写出内嵌的 MSI，和 `dist` 里的核对哈希。
- 发布：把版本说明写进 `docs/release-notes/v<版本>.md`，提交并推送后，`gh release create v<版本> dist/*-<版本>-*.exe dist/*-<版本>-*.msi --notes-file docs/release-notes/v<版本>.md`（只带这个版本的文件，`dist` 里可能还有旧版本的）。测试版加 `--prerelease`，标签写成 `v0.4.0-beta.1` 这样。

界面的颜色、字体和动效时长取自 foobar2k 用的 CreeperUX 设计令牌（`vendor/creeperux-gui/tokens.json`，深色模式），写在 `App.xaml` 和 `Controls/Motion.cs` 里。图标也是 foobar2k 那一套（CreeperUX 套件的 24 px 网格、1.6 px 圆头线条，播放控件实心）：`node tools/kit-icons.mjs` 从 fb2k 的 `vendor/creeperux-gui` 读出图标，再由 `tools/kit-outline`（调用 Windows 自带的 Direct2D）把 1.6 px 的圆头线条加粗成填充轮廓，和实心部分合并成一条路径，写进 `Controls/KitIcons.g.cs`。程序用 XAML 自带的 `PathIcon` 显示它们，颜色像文字一样从按钮继承，悬停、按下、选中都由框架处理；菜单里用的也是同一套图标。标题字体 Chakra Petch（SIL OFL 1.1，许可在 `Assets/Fonts/`）是用 Windows 自带的 DirectWrite 从 foobar2k 的 WOFF2 解包成 TTF 的；数字字体 Share Tech Mono 保留了字体名，转换后的版本不能沿用原名，所以这里仍用 Cascadia Mono。

## 验收

```bash
npm install
dotnet test tests/Sonus.Core.Tests     # 114 项：队列逻辑、歌词、格式、令牌、服务器地址、检查更新、跨设备控制（两版，含测试向量在 PlayQueue 上重放）、接手旧名字的数据，以及对演示服务器的集成测试
npm run check                                   # Windows 程序的多轮验收（本机架构；--arch=x64|ARM64）
node tools/e2e/connect-v2.mjs                   # Connect 第 2 版：两个静默的测试实例，截图在 tools/e2e/.work/shots/c2-*.png
node --test tools/demo-server/connect-session.test.mjs tools/demo-server/connect2.test.mjs   # 第 2 版的会话逻辑、测试向量和演示服务器
node tools/demo-server/connect-vectors.mjs --check                                           # 测试向量和会话逻辑一致
npm run check:web                               # 网页版客户端
```

`npm run check`（`tools/e2e/acceptance.mjs`）和 Lumen 的 tools/e2e 用同样的做法，**全程静默**：

- 测试实例有自己的数据目录和凭据条目 `Sonus-test:server`，不碰你自己的程序和登录。测试从旧名字升级时用的是 `CreeperUXMusic-test:*`，也不碰你自己的 `CreeperUXMusic:*`。
- 检查更新连的是本地的假 GitHub（`tools/e2e/fake-github.mjs`），测试实例只在点「检查更新」时才查（启动时不自动查），下载并校验安装程序后不会运行它。
- 窗口被 DWM 隐藏（照常渲染，但不显示、不进任务栏、不抢焦点）。所有操作都通过命名管道走程序内的测试通道，按无障碍名称找控件，不移动鼠标、不按键盘。
- 截图由程序自己渲染（RenderTargetBitmap），保存在 `tools/e2e/.work/shots/acc-*.png`。每一轮结束都检查测试窗口仍然隐藏，并且没有成为前台窗口。

`node tools/e2e/stress-load.mjs` 连续切换 40 首歌，统计每首从载入到开始播放的时间。这项检查发现过一个真实的问题：旧歌曲的 HTTP 连接没有释放，连续切歌时会越积越多；现在中位数约 0.55 秒，最长不到 0.81 秒。

`node tools/e2e/perf.mjs` 用 8 倍的演示曲库（2344 首、272 张专辑，接近真实曲库的规模）测界面线程被占住多久：每 50 毫秒发一次 ping，回得慢就是窗口卡住了。它发现过真实曲库上的卡顿：歌曲列表和音乐库侧栏一次建出所有行，打开“媒体库 · 全部歌曲”会卡 8 秒、内存涨到 1.2 GB；服务器的回应也在界面线程上解析。现在列表、卡片网格和侧栏只建出看得见的部分，解析放在后台线程，每一步最长卡顿在 0.3 秒以内（含约 40 毫秒的测量开销），内存约 370 MB。

验收里还有一项“播放时打开别的专辑，封面照样马上去取”：XAML 自带的图片下载走 WinINet，和从同一台服务器传来的音频流共用很少的几个连接，播放期间封面会一直加载不出来。现在封面由程序自己下载（`Controls/Covers.cs`，.NET HttpClient，同一地址只请求一次，最近用过的放在 48 MB 的内存缓存里），并按它在屏幕上实际占的像素（尺寸 × 显示缩放 × 界面缩放）向服务器要 64 / 128 / 256 / 512 / 1024 中够用的一档，不会把小图放大显示。

验收分十四轮：首次启动与登录、每个页面（含可访问性审查和切换 60 次页面后的内存检查）、播放（暂停、拖动、计播放次数、无缝切歌、队列、电台、DSD 转码、错误、回放增益、歌词）、歌单增删改、搜索、第二台设备接着听、跨设备控制（两台设备互相看见、遥控暂停和播放、把播放转过来）、窄窗口、服务器断开与恢复、系统媒体控制、重启与退出登录、检查更新（不用令牌、请求不带凭据，正式版和测试版，下载并校验安装程序）、从 CreeperUX Music 升级（旧名字下的登录搬过来，不用重新登录；用不上的 GitHub 令牌删掉）、在浏览器中登录（允许、拒绝、取消，重启后用保存的 API 密钥登录，退出时把密钥还给服务器）。功能检查都会回读服务器状态来确认。
演示服务器是按 Subsonic / OpenSubsonic 文档写的，**不是 Navidrome 本身**。

## 已知限制

- 回放增益只能降低音量，不能提高（Windows 播放器的音量上限是 100%）。
- 启动时整个曲库载入内存：几千首没有问题，几万首时首次载入会慢，需要改成分页加载。
- 智能歌单要在 Navidrome 的网页里创建；在程序里能播放，不能编辑。
- 还没有独占模式（WASAPI exclusive）和原生 DSD 输出；需要时可以像 Lumen 一样换成 libmpv 播放后端。
- 界面目前只有中文和深色主题（网页版有中英文和浅色主题）。
- 还没有安装包和代码签名。
- 只在演示服务器上验证过，还没有在真实的 Navidrome 上跑过（需要你的服务器和测试账号）。
- 媒体键和锁屏上的媒体卡片只用只读查询确认过（Windows 媒体会话里有这个程序和歌名），真正按键需要在真机上试。
- 测试截图由程序自己渲染，菜单的弹出动画、真实的鼠标悬停和键盘焦点效果需要在真机上看一遍。
- 动效（换页淡入、列表行和卡片依次上浮、页面颜色渐变、封面淡入和放大、卡片悬停抬起、播放按钮滑出和回弹、喜欢的弹跳、正在播放的跳动电平条、开关下的圆点、歌词当前行放大变亮）都在合成器上运行，截图只拍到结束状态，手感需要在真机上看。Windows 关闭“动画效果”时，这些都直接显示结果。
