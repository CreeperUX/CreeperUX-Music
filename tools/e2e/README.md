# 客户端测试指向任意服务器

Sonus 自己的三套客户端测试默认对着演示服务器（`tools/demo-server/`）跑，和以前完全一样；设置下面的环境变量后，同样的检查可以对着任何服务器跑：冻结的 Navidrome、Rust 写的 Sonus 服务器、网关后面的服务器。

| 测试 | 命令 |
|---|---|
| 单元测试和集成测试（xUnit） | `dotnet test tests/Sonus.Core.Tests` |
| Windows 程序的验收（14 轮，静默） | `node tools/e2e/acceptance.mjs --arch=ARM64` |
| 网页版的验收 | `node tools/check-web.mjs` |

## 选择服务器

| 环境变量 | 内容 |
|---|---|
| `SONUS_TEST_SERVER` | 服务器的地址，例如 `http://127.0.0.1:4640`。不设：启动演示服务器（默认）。 |
| `SONUS_TEST_CREDENTIALS` | 测试用户的 JSON 文件（格式见下）。设了 `SONUS_TEST_SERVER` 时必须有。 |
| `SONUS_TEST_MANIFEST` | 可选：JSON 文件，按名字给出测试要用的歌曲、专辑、歌单的 ID。没给的由测试通过 API 自己找。 |

```powershell
$env:SONUS_TEST_SERVER = 'http://127.0.0.1:4640'
$env:SONUS_TEST_CREDENTIALS = 'C:\path\credentials.json'
$env:SONUS_TEST_MANIFEST = 'C:\path\manifest.json'
dotnet test tests/Sonus.Core.Tests; node tools/e2e/acceptance.mjs --arch=ARM64; node tools/check-web.mjs
```

- 凭据文件里是一次性的测试账号，只放在本机、不进仓库（`tools/e2e/.work/` 已被忽略），测试不会把密码打印出来。
- 不要指向自己正在用的正式服务器：测试会建、改、删歌单，收藏和取消收藏，增加播放次数，保存播放队列。只读地看一眼正式服务器，用 `node tools/check-web.mjs --server=<地址>`（`MUSIC_USER`、`MUSIC_PASSWORD`），它不写任何东西。
- 两步验证：主测试用户要能用密码（或应用专用密码）通过 Subsonic 的令牌登录；“在浏览器中登录”那一轮还要用这个密码登录网页（`/auth/login`），所以服务器要么关掉两步验证（`ND_SONUS_TWOFACTOR=off`），要么这个用户没有启用。

### 凭据文件

```json
{
  "users": {
    "main":  { "username": "listener",  "password": "…" },
    "other": { "username": "neighbour", "password": "…" }
  }
}
```

`main` 是测试登录用的用户（相当于演示服务器的 demo）；`other` 可选，是另一个用户（相当于 friend），测试用它建一个公开歌单，检查“别人的歌单只能播放”。只有一个用户时也可以写成 `{ "username": "…", "password": "…" }`。用户也可以放在清单里（`users.main`、`users.other`）。

### 清单

层级随意，按“点分隔的键”读：`{ "track": { "syncedLyrics": "id" } }` 和 `{ "track.syncedLyrics": "id" }` 一样；外面再包一层 `ids` 或 `entities` 也可以。

| 键 | 是什么 | 没有时 | 演示服务器上对应 |
|---|---|---|---|
| `users.main` / `users.other` | 见上 | 读凭据文件 | demo / friend |
| `track.syncedLyrics` | 有同步歌词（至少 3 行）、长于 45 秒的歌 | 依次问前 120 首歌的 `getLyricsBySongId` | 夏夜电台的歌（第一行在 8 秒） |
| `track.missingFile` | 曲库里列着、但文件已经不在的歌（串流失败） | **找不到**：相关检查跳过 | `t57` |
| `track.dsd` | DSD 歌曲（`.dsf`/`.dff`），要请服务器转码 | 按后缀找 | Small Hours 专辑 |
| `album.playable` | 至少 4 首、每首至少 1 分钟、都能串流、不是 DSD、只有一张碟的专辑（播放那几轮用；网页版按行数点歌，碟片标题也算一行） | 按这个条件找第一张（找不到一张碟的，就用多张碟的） | `al3` 霓虹航线 |
| `album.multiDisc` | 歌分在两张以上碟片的专辑（检查碟片和音轨的顺序） | 找第一张 | 第一张超过 8 首的专辑 |
| `playlist.own` | 主用户自己的歌单 | 列表里找；没有就建一个“Sonus 测试歌单”，测试结束时删掉 | `pl1` 深夜写代码 |
| `playlist.otherPublic` | 另一个用户的公开歌单 | 列表里找；没有就用 `users.other` 建一个公开的，结束时删掉 | `pl5` 朋友的歌单 |

另外测试自己从 API 取：歌曲、专辑、歌单的数目（`search3` 空查询、`getAlbumList2`、`getPlaylists`），一张至少 5 首、每首至少半分钟的专辑（专辑页、“下一首播放”），歌最多的艺人（艺人页、搜索词），最常见的流派（流派页）。这些都在 `target.mjs` 的 `discover()` 里，演示服务器上的值在 `DEMO_CATALOGUE`。

## 对演示服务器严格，对别的服务器按它自己的数据

- 演示服务器上：所有断言和以前一样，包括确切的数目（293 首、34 张专辑、17 位艺人、5 个歌单）、名字、歌词第一行在 8 秒、电台只出相近的流派、艺人简介里的“演示数据”、DSD64 的位深、`type` 是 navidrome、串流是 WAV。
- 别的服务器上：同样的行为，用那台服务器自己报告的东西来比：数目和 `search3`/`getAlbumList2`/`getPlaylists` 对得上；歌词和服务器给的第一行时间（减去 offset）一致；电台里的歌都是服务器说相似的（服务器一首都不给时，程序用同一艺人或流派的歌）；有简介就显示、没有就不显示；回放增益按这首歌的增益（没有增益时音量不变）。
- 服务器的曲库给不出数据的检查报告为“跳过”，写明原因（没有 DSD、清单里没有丢失文件的歌、没有别人的公开歌单、没有同步歌词、没有流派；专辑太少，每张的大封面在前几轮都已取过）。演示服务器上不会跳过任何一项。

## 记录代理（`proxy.mjs`）

对别的服务器，测试连的是本机的一个代理，代理把每个请求原样转给服务器（双向流式，包括 Sonus Connect 的 WebSocket），并提供和演示服务器一样的两个测试钩子：

- `GET /__test/log`：看到的串流（格式、码率、Range）、计播放、保存队列、封面（尺寸）请求，当前打开的音频流数目，Connect 的 WebSocket（用什么方式登录、服务器是否接受、是否还开着），以及每次 `getSimilarSongs2` 回了哪些歌（Navidrome 没有 Last.fm 时每次随机挑，所以电台要和程序实际拿到的那次回应比）。不记录密码、令牌和 API 密钥。
- `GET /__test/offline?on=1|0`：打开时丢掉所有连接（不回应），并断开已经连着的 WebSocket，和演示服务器的钩子一样。

也可以单独运行：`node tools/e2e/proxy.mjs <服务器地址> [端口]`。

## 依赖演示服务器测试钩子的检查

| 检查 | 演示服务器上用的钩子 | 别的服务器上 |
|---|---|---|
| 单元测试：Connect 断线后重连并重新报告状态 | `/__test/offline` | 代理 |
| 验收第 3 轮：无缝切歌（下一首已请求） | `/__test/log` 的 streams | 代理 |
| 验收第 3 轮：播放时封面照样马上去取 | `/__test/log` 的 covers 和 open | 代理（按专辑的 `coverArt` 比对，演示服务器上它就是专辑 ID） |
| 验收第 3 轮：DSD 请服务器转成 MP3 | `/__test/log` 的 streams | 代理；服务器没有 DSD 歌曲时跳过 |
| 验收第 8 轮：服务器断开与恢复 | `/__test/offline` | 代理 |
| 验收第 13 轮：在浏览器中登录（等待中的请求、允许、拒绝、发出的密钥） | `/__test/device` | 服务器自己的路由，就是允许页调用的那些：`/auth/login` 拿到网页登录，`GET /auth/device/{code}`，`POST /auth/device/{code}/approve`、`/deny`，`GET /auth/app-passwords`（应用密钥就是其中一个应用专用密码）。只比较这一轮新出现的密钥。 |
| 验收第 13 轮：Connect 用应用密钥连上服务器 | `/__test/devices` | 代理记录的 Connect WebSocket：用 `apiKey` 登录、服务器回了 101、还开着 |
| 网页版：播过一半只计一次播放 | `/__test/log` 的 scrobbles | 代理 |
| 网页版：下一首在这首放完前就请求 | `/__test/log` 的 streams | 代理 |
| 网页版：DSD 请服务器转成 Opus | `/__test/log` 的 streams | 代理；没有 DSD 歌曲时跳过 |
| 网页版：服务器断开显示离线，再连上 | `/__test/offline` | 代理 |
| 验收第 1、10、13 轮：登录 | 登录页的“使用本机的演示服务器”按钮（`--demo`） | 登录表单（服务器地址、用户名、密码）；并检查登录页上没有演示服务器的按钮 |

还有一项始终用演示服务器：单元测试“服务器每页最多给 40 条时仍能拿到整个曲库”，它测的是客户端的分页，用一个限制了每页条数的演示服务器，和被测的服务器无关。
