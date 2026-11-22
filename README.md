# CreeperUX Music

连接你自己的 **Navidrome**（或任何兼容 Subsonic 的服务器）的 Windows 音乐播放器。界面参考 Spotify 的布局，用 **WinUI 3 / .NET 10** 原生实现，支持 x64 和 ARM64。
曲库、歌单、喜欢、播放次数和“接着听”的队列都保存在服务器上，所有设备共用；手机可以用任何 Subsonic 客户端连同一个服务器。

## 先看演示

不需要服务器：项目自带一个演示服务器，曲库是虚构的（17 位艺人、34 张专辑、293 首），每首歌都有现场合成的音乐，能真正听到。

```bash
npm run demo             # 演示服务器 + Windows 程序（第一次会先编译，需要 .NET 10 SDK）
```

也可以双击 `演示 CreeperUX Music.cmd`。程序打开后点“使用本机的演示服务器”登录（账号 demo / demo）；关掉窗口，演示服务器也随之停止。

值得试的地方：

- 双击任意歌曲播放，拖进度条；一首播完会无缝接上下一首（下一首在 MediaPlaybackList 里提前载入）。
- 键盘上的播放、暂停、上一首、下一首键，以及音量浮窗里的媒体卡片都能控制它。
- 歌曲的“更多选项”→ **开始电台**：从这首歌开始，接着是相似的歌。
- 艺人页底部的**简介**；右栏的歌词卡片和“全屏查看歌词”。
- **换设备接着听**：播一会儿再暂停，然后用 `npm run demo:browser` 在浏览器里（网页版客户端）登录同一个演示服务器，会停在同一首歌的同一位置，并提示“接着播放”。

## 连接你自己的 Navidrome

登录页填服务器地址（如 `https://music.example.com` 或 `http://192.168.1.10:4533`）、用户名和密码。

- 密码不保存：只保存由它算出的登录令牌（Subsonic 的 token 认证，md5(密码 + salt)），存在 **Windows 凭据管理器**里（“控制面板 → 凭据管理器 → Windows 凭据”中的 `CreeperUXMusic:server`）。这个令牌对 Subsonic API 等同于密码。
- 外网访问请走 HTTPS。
- 歌曲电台和艺人简介需要在 Navidrome 里配置 Last.fm；没有时，电台改为同艺人、同流派的歌。
- Windows 解不了的格式（DSD、APE、WavPack、TTA 等）会请服务器转码成 MP3（Navidrome 默认就有 MP3 转码）。

## 服务器提供什么，程序做什么

| 功能 | 由谁负责 | Subsonic / OpenSubsonic 调用 |
| --- | --- | --- |
| 曲库、专辑、艺人 | 服务器 | `search3`（空查询分页取全部歌曲）、`getAlbumList2` |
| 播放 | 程序：Windows `MediaPlayer` + `MediaPlaybackList`（正在播放和下一首） | `stream`（必要时 `format=mp3`） |
| 系统媒体控制 | 程序：`MediaPlayer` 自带；上一首 / 下一首交给程序的队列 | — |
| 播放次数、最近播放 | 服务器 | `scrobble`：开始时“正在播放”，播过一半或 4 分钟时计一次 |
| 喜欢 | 服务器 | `star` / `unstar`；“我喜欢的音乐”就是收藏的歌 |
| 歌单 | 服务器 | `getPlaylists`、`createPlaylist`（新建，或整体覆盖用于排序）、`updatePlaylist`、`deletePlaylist`；别人的歌单只能播放 |
| 封面、歌词、搜索 | 服务器 | `getCoverArt`、`getLyricsBySongId`（同步歌词）/ `getLyrics`、`search3` |
| 换设备接着听 | 服务器存档 | 换歌、暂停、拖动、每 30 秒和关窗时 `savePlayQueue`；启动和窗口回到前台时 `getPlayQueue` |
| 歌曲电台、艺人简介 | 服务器 | `getSimilarSongs2`、`getArtistInfo2` |
| 队列、播放顺序、播完停止、回放增益、输出设备 | 程序 | — |
| 和其他设备同步 | — | 窗口回到前台（间隔一分钟以上）和每次刷新时重读歌单；歌曲数变了就重读曲库 |

## 结构

| 路径 | 内容 |
| --- | --- |
| `src/CreeperUX.Music.Core` | 不依赖界面的核心库：Subsonic 客户端、曲库分组、播放队列与播放顺序、歌词解析、文字格式 |
| `src/CreeperUX.Music` | WinUI 3 程序：`Services/MusicService.cs`（状态与操作）、`Playback/AudioEngine.cs`（MediaPlayer，全部在自己的线程上调用）、`MainWindow`（顶栏、三栏、播放条）、`Pages/`、`Controls/`、`Testing/E2EChannel.cs`（测试通道） |
| `tests/CreeperUX.Music.Core.Tests` | 核心库测试（xUnit）：单元测试 + 对演示服务器的集成测试 |
| `server/` | 演示服务器：`demo-server.mjs`（API）、`catalogue.mjs`（虚构曲库）、`synth.mjs`（合成音乐）、`covers/`（封面 JPEG） |
| `tools/e2e/` | 静默的端到端测试：`acceptance.mjs`（多轮验收）、`e2e.mjs`（测试实例、管道、截图） |
| `tools/demo.mjs` | 一键演示 |
| `web/` | 网页版客户端（同一套功能的浏览器版本，演示服务器在 `/` 提供它）；`tools/check-web.mjs` 是它的验收 |
| `assets/` | 图标（`tools/icon.mjs` 生成） |

## 编译

```bash
dotnet build src/CreeperUX.Music/CreeperUX.Music.csproj -p:Platform=x64     # 或 -p:Platform=ARM64
dotnet test tests/CreeperUX.Music.Core.Tests
```

程序是不打包、自带运行库的 WinUI 3 应用（与 Lumen 相同的设置），编译输出可以直接运行。数据目录是 `%LOCALAPPDATA%\CreeperUX Music`（设置、日志）。

## 验收

```bash
npm install
dotnet test tests/CreeperUX.Music.Core.Tests     # 35 项：队列逻辑、歌词、格式、令牌，以及对演示服务器的集成测试
npm run check                                   # Windows 程序的多轮验收（本机架构；--arch=x64|ARM64）
npm run check:web                               # 网页版客户端
```

`npm run check`（`tools/e2e/acceptance.mjs`）和 Lumen 的 tools/e2e 用同样的做法，**全程静默**：

- 测试实例有自己的数据目录和凭据条目 `CreeperUXMusic-test:server`，不碰你自己的程序和登录。
- 窗口被 DWM 隐藏（照常渲染，但不显示、不进任务栏、不抢焦点）。所有操作都通过命名管道走程序内的测试通道，按无障碍名称找控件，不移动鼠标、不按键盘。
- 截图由程序自己渲染（RenderTargetBitmap），保存在 `tools/e2e/.work/shots/acc-*.png`。每一轮结束都检查测试窗口仍然隐藏，并且没有成为前台窗口。

`node tools/e2e/stress-load.mjs` 连续切换 40 首歌，统计每首从载入到开始播放的时间。这项检查发现过一个真实的问题：旧歌曲的 HTTP 连接没有释放，连续切歌时会越积越多；现在中位数约 0.55 秒，最长不到 0.81 秒。

验收分十轮：首次启动与登录、每个页面（含可访问性审查和切换 60 次页面后的内存检查）、播放（暂停、拖动、计播放次数、无缝切歌、队列、电台、DSD 转码、错误、回放增益、歌词）、歌单增删改、搜索、第二台设备接着听、窄窗口、服务器断开与恢复、系统媒体控制、重启与退出登录。功能检查都会回读服务器状态来确认。
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
