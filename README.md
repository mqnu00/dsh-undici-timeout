# dsh-undici-timeout

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

DSH 插件：给 LLM 出口（`globalThis.fetch` → Node 内置 undici）换一条**可配置超时 + 可保活复用**的直连通道。

English: [README.en.md](README.en.md)　·　发布流程: [RELEASING.md](RELEASING.md)　·　收录条目: [`contrib/awesome-dsh-plugin/`](contrib/awesome-dsh-plugin/)

## 为什么需要它

- Node 内置 `fetch` 背后的 undici，`connectTimeout` 固定 **10s**（DNS+TCP+TLS 全算在内），
  没有环境变量/参数可调；
- 本机（WSL）直连 `opencode.ai` 的新建握手实测出现过 **11.6s**，双栈探测也常整轮
  `AggregateError`（IPv6 无出口 + IPv4 抖动）；
- pi-ai 每次重试都 `new OpenAI(...)` → `Shims.getDefaultFetch()` **当场读全局 fetch**，
  所以每次尝试都是新 TCP+TLS，被 10s 砍掉 → `TIMEOUT/TRANSPORT` → 重试又重连。
  今天（2026-10-13）的日志：87 次 TIMEOUT + 8 次 TRANSPORT，autoswitch 开代理 10 次。

对比：OpenCode（Go 客户端）全程复用一条已建立的 HTTP/2 连接，握手只发生一次，
所以同样的网络下它不超时。本插件就是把这套「长超时 + 保活复用」搬给 DSH。

## 这东西的寿命：它是一个补丁，不是一块功能

它存在的理由只有两条，而且两条都在**上游**，不是 DSH 的既定设计：

1. Node 内置 `fetch` 的 `connectTimeout` 固定 **10s** 且没有开关（Node/undici 上游行为）；
2. undici 8 把 `allowH2` 的默认值翻成 `true`，而 Cloudflare 边缘对 h2 上的 SSE 长流会
   回 `NGHTTP2_ENHANCE_YOUR_CALM`（上游默认值 × 边缘策略）。

这两条一旦在 DSH 侧被解决 —— 比如 LLM 层允许指定 dispatcher / 连接超时，或者换掉内置
fetch —— 本插件就**没有存在价值了**，直接卸掉：

```bash
dsh plugin --profile web remove dsh-undici-timeout   # 或者删掉 profile 里那条 insert
```

判断「可以卸了」的依据（任一条成立即可）：

- 状态路由 `stats` 长期没有 `TIMEOUT`，且直连握手不再接近 10s；
- DSH 的 LLM 层能自己配连接超时 / 强制复用连接（看 release notes，或
  `dsh --profile web --dump-config` 里出现了对应配置项）；
- 上游把内置 fetch 换成了自带 Agent 的实现。

在那之前它是**最小补丁**：单文件、零依赖、只接管白名单域名、随时可摘。
所以只从 GitHub 分发，不发 npm、不进插件市场。

## 原理

```
agent 回合
 └─ dsh-llm-retry（重试）→ dsh-llm-pi-ai → pi-ai → new OpenAI({ fetch: undefined })
      → openai/client.mjs: this.fetch = Shims.getDefaultFetch()   ← 每次尝试当场读全局
      → 【本插件包装过的 globalThis.fetch】
           ├─ 命中 hosts 白名单 且 无代理 env → undici.fetch(url, { dispatcher: 自建 Agent })
           └─ 其它（代理模式 / 非白名单 / Request 输入）→ 原样透传给原来的 fetch
```

- 用**解析到的那份 undici**（`argv[1]` → profile 扫描 → bare）自建 `Agent`：
  `connect.timeout`、`headersTimeout`、`bodyTimeout`、`keepAliveTimeout/MaxTimeout`、
  `pipelining`、可选 `family`。
- **不碰 `setGlobalDispatcher`**：那是 `@deepseek-ai/dsh-http-proxy` 的地盘（代理联动靠它），
  抢了会把 net-proxy 弄坏。本插件只接管「本来要走直连」的那部分流量。
- 代理 env（`http_proxy/https_proxy/ALL_PROXY` 任一大写或小写）在场时**自动让路**，
  由 harness 的代理层处理——所以能和 `dsh-net-proxy` / `dsh-net-autoswitch` 共存。

## 配置项（`cordis.patch.yml` 里本插件的 `config:`）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关。`false` 时不改 fetch，状态路由仍在。 |
| `hosts` | `["opencode.ai"]` | 命中这些域名（含子域）才接管；`"*"` = 全部直连流量。 |
| `connectTimeoutMs` | `30000` | **核心项**。DNS+TCP+TLS 的总预算（内置固定 10s）。范围 1000–600000。 |
| `headersTimeoutMs` | `300000` | 等响应头。 |
| `bodyTimeoutMs` | `0` | 相邻 body 块间隔；`0`=关闭，卡流交给 pi-ai 的 `streamIdleTimeoutMs` 看门狗。 |
| `keepAliveTimeoutMs` | `60000` | 空闲连接保留时长（复用 = 不重握手）。 |
| `keepAliveMaxTimeoutMs` | `600000` | 保活上限。 |
| `pipelining` | `1` | 每连接并发请求数。 |
| `family` | `0` | `0`=跟随系统；`4`/`6`=强制 IP 族（本机 IPv6 无出口时 `4` 很划算）。 |
| `allowH2` | `false` | **⚠️ 见下面「h2 的坑」**。undici 8 把 `allowH2` 的默认值翻成了 `true`，不显式关掉，本插件会顺手把 LLM 出口从 h1 换成 h2。 |
| `autoSelectFamilyAttemptTimeoutMs` | `0` | Node happy-eyeballs 的**地址轮换间隔**（默认 250ms）。注意：尝试是**并行保留**的，这个值不是单地址的放弃窗口——黑洞地址实测默认与调大都会等到 connect 超时才死，改大只会拖慢轮换，一般别动。保留它只为极端调优。 |
| `delegateOnProxyEnv` | `true` | 有代理 env 时让路。 |
| `undiciPath` | `""` | 留空自动解析；可显式指到某份 `undici/index.js`。 |
| `probeOnStart` | `true` | 启动时打一次探针（默认打 LLM 网关的 models 端点，不花 token）。 |
| `probeUrl` / `probeTimeoutMs` | `…/zen/go/v1/models` / `15000` | 探针目标与超时。 |
| `logSlowMs` | `0` | >0 时把达到该耗时的请求写日志。 |
| `logFailures` | `true` | 失败请求记日志（含 cause）。 |
| `routePath` | `/_dsh/undici-timeout` | 状态路由。 |
| `logFile` | `$DSH_HOME/logs/dsh-undici-timeout/host.log` | 日志落盘。 |

## 安装

**只从 GitHub 分发**（本插件是上游行为的补丁，不发 npm、不上市场）：

```bash
dsh plugin --profile web add github:mqnu00/dsh-undici-timeout
```

装完**重启 DSH** 生效。也可以钉住某个版本：

```bash
dsh plugin --profile web add github:mqnu00/dsh-undici-timeout#v0.1.1
```

零 npm 依赖、无构建步骤，所以 pnpm 不会弹 `allowBuilds` 授权（本插件没有任何
`prepare` / `install` 脚本）。⚠️ 别和下面路线 B 的 `file://` 直插**同时用**：
包内 `cordis.patch.yml` 的 insert id 也是 `undici-timeout`，同 id 冲突。

改完代码想知道「别人 clone 下来到底装不装得上」，本地跑一遍试装验证 —— 把包装进一个
临时 DSH_HOME 里的干净 profile、真启动一次、再请求插件自己的状态路由：

```bash
./scripts/trial-install.sh          # 走 tarball（等价于 GitHub Release 资产）
./scripts/trial-install.sh --git    # 走本地裸仓库 git+file://（等价于 github: 源）
./scripts/trial-install.sh --spec=github:mqnu00/dsh-undici-timeout   # 直接验真实远端
# 🎉 试装验证通过 = 组合成功 + 启动就绪 + 状态路由应答
```

打 tag / 建 Release 的步骤见 [RELEASING.md](RELEASING.md)。

### 路线 B：file:// 直插 profile 用户层（改代码时用这条）

`~/.dsh/profiles/web/cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: undici-timeout
      name: file:///home/mqnu/program/dsh/dsh-undici-timeout/lib/index.js?v=5
      config:
        enabled: true
        hosts: [opencode.ai]
        connectTimeoutMs: 30000
        # 本机 IPv6 无出口：别让地址族探测把预算烧在 10 个死地址上
        family: 4
        # undici 8 的 allowH2 默认是 true，不关掉就会把出口换成 h2（见「h2 的坑」）
        allowH2: false
        bodyTimeoutMs: 0
        keepAliveTimeoutMs: 60000
```

`dsh-hmr` 会监听该文件，**原地写** 2 秒内自动重挂（tmp+rename 会换 inode，收不到事件）。
⚠️ insert 行按 **id 幂等**：只改 `name`（换 `?v=`）或改 `config` 不会立刻重挂——要么**摘掉再插回**，
要么重启 DSH（HMR 的实测行为，和 dsh-net-autoswitch 一致）。
2026-10-15 复验：只把 `?v=4` 改成 `?v=5` 并加配置，HMR 确实重挂了（实例 id、`installedAt`
都换新），但**跑的还是旧模块代码** —— 日志里没有新加的 `h2=off` 字段，状态路由里也读不到
`allowH2`。原因就是同 id 的 entry 按**旧 URL** 重新 import。**摘掉（等 HMR 跑一轮）→ 再插回**，
这次 `?v=5` 才真正被 import，`h2=off` 出现在日志里。改代码务必按这个顺序。

## h2 的坑（2026-10-15 定位，`allowH2` 就是为它加的）

症状：插件明明在跑（`matched` 一直涨），却仍然「很频繁地失败」，重试日志里
`code=TRANSPORT` 暴涨。

根因是一条**静默换协议**：

| | 用的 undici | ALPN 实测 | 结果 |
|---|---|---|---|
| 内置 `fetch`（Node 22 自带） | 6.24.1 | `http/1.1` | h1 |
| 本插件（`argv` 解析到 harness 那份） | 8.11.2 | `h2` | **h2** |

undici 8 把 `allowH2` 的默认值从 `false` 翻成了 `true`
（`lib/core/connect.js`: `allowH2 = allowH2 != null ? allowH2 : true`，
`lib/dispatcher/client.js`: “enabled by default”）。我们用 undici 8 建 Agent，
于是 LLM 出口从 h1 变成了 h2 —— 这不是本插件想要的，却实实在在换了传输层。

代价：`opencode.ai` 前面是 Cloudflare，h2 上的 SSE 长流会被边缘掐：

```
请求失败 CONNECTION（2275ms）…/chat/completions :: ERR_HTTP2_STREAM_ERROR / Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM
```

- 2026-10-15 当天：插件记了 **85 次失败，其中 79 次是 nghttp2 流错误**（93%），
  全部落在 `/chat/completions`（长流），`/models`（短请求）一次都没有；
- 首次出现 `ERR_HTTP2` 是 **2026-10-14T07:00**，即代理被关掉、插件开始全量接管直连之后；
  重试日志里 `TRANSPORT` 从 ~10/天 → **201/天**（10-14），`TIMEOUT` 则从 238/天 → 4/天
  （**插件治超时的效果是真的**，只是换了个失败形态）。

修法：`allowH2: false`（已进 DEFAULTS）。关掉之后复用一点没少：

| 4 连发（读完 body） | 新建连接数 | 耗时 |
|---|---|---|
| `allowH2: false` | 1 | 924ms → 383 → 363 → 374ms |
| `allowH2: true` | 1 | 947ms → 340 → 350 → 349ms |

即 h1 + `keepAliveTimeout` 的复用与 h2 等价，「不重握手」的目标照旧达成，
而 Cloudflare 那套 h2 流控彻底不参与。

2026-10-15 03:31 热更后（`?v=5`，`family=4` + `allowH2:false`）现场复验：
**75 秒内 22 个请求（全是 `/chat/completions`）20 成功 0 失败，`ERR_HTTP2` 0 次** ——
同一台机器、同一分钟里，改之前是 85 次失败/天、其中 93% 是这个 h2 流错误。

## 直连失败的另一半：20 个地址里的 10 个是死的（2026-10-15 实测）

`opencode.ai` 的 DNS 一次回 **10 个 IPv4 + 10 个 IPv6**，本机 **IPv6 无出口**
（`curl -6` 秒失败）。地址族探测（happy eyeballs）会把预算烧在这 10 个死地址上：

| 同一分钟内的对照 | 结果 |
|---|---|
| 裸 TCP 连 10 个 IPv4 | 全部成功，245–1332ms |
| `curl`（双栈）/ `curl -4` | 8/8、5/5 成功，connect 0.27–0.46s |
| **内置 fetch**（undici 6） | **2/6 成功**，4 次 `UND_ERR_CONNECT_TIMEOUT`，~2511ms |
| **插件 Agent，family=0** | **6/6 成功**，中位 352ms |
| 插件 Agent，family=4 | 6/6 成功，中位 379ms |

所以「插件生效了吗」的答案是：**生效，而且比内置通道明显强**；
但 `connectTimeoutMs: 30000` 救不了这种形态 —— 整轮在 ~1.0s / ~2.5s 就死掉，
是地址族探测把整轮判死，不是 10s 的 connect 预算不够。`family: 4` 能把这半边也堵上。

WSL 里直连脆弱、本机代理（`127.0.0.1:10808`）实测 3/3 HTTP 200（~0.9s）——
代理开着时插件按设计让路，也就不会被 h2 那套流控碰到。

## 状态/排障

```bash
# 读状态（在机器上直接 curl；Host 白名单只放行回环/本机网卡）
curl -s http://127.0.0.1:3080/_dsh/undici-timeout | python3 -m json.tool

# 手动补一枪探针
curl -s -X POST http://127.0.0.1:3080/_dsh/undici-timeout \
  -H 'x-dsh-undici-timeout: 1' -H 'content-type: application/json' \
  -d '{"action":"probeNow"}'
```

- `stats.matched/ok/failed/byError`：接管了多少请求、失败怎么归类；
- `stats.delegatedProxy`：因代理 env 让路了多少（联动在工作就正常）；
- `stats.lastRequests`：最近 10 条（host/path/ms/status/error）；
- `lastProbe`：最近一次探针（启动探针也会写日志）。
- 日志：`~/.dsh/logs/dsh-undici-timeout/host.log`。

冒烟（不经过 DSH，验证解析与网络）：

```bash
node test/live-smoke.mjs        # 本机实测：HTTP 200，约 1.6s
node --test test/*.test.mjs     # 单测（18/18）
```

对照探针（2026-10-15 定位上述两个问题用的，都能单独跑）：

```bash
node test/h2-probe.mjs 8        # allowH2 默认 vs false：看 ALPN / 失败形态
node test/family-probe.mjs 6    # 内置 fetch / family=0 / family=4 / family=4+h1 四路对照
node test/burst-probe.mjs 12 3  # 同一条连接并发 12：h2 与 h1 是否被掐
node test/sse-probe.mjs 6       # 真 SSE（含中途 abort）：h2 与 h1 对照，需 ~/.dsh/.credentials.yaml
```

实测 keep-alive 复用（3 连发）：`2358ms → 416ms → 420ms`，后两次不再握手。

## 与 net-proxy 的共存

`dsh-net-proxy` 只在「代理开」时才包装 `globalThis.fetch`，且其包装器闭包**惰性**读配置；
本插件只在**没有代理 env** 时接管直连，两边互不拆台。开关顺序无论谁先上链都成立：

- 代理关：我们的包装器在链上；直连请求走长超时 Agent；
- 代理开：net-proxy 的包装器叠在上面，流量走它的中继；我们让路；
- 代理再关：net-proxy 还原到它上任时的 `originalFetch`（就是我们）。

## 改代码之后

本插件**刻意单文件**（`lib/index.js`，零相对导入、零 npm 依赖），因为 loader 按 URL
缓存 ESM：改代码只需把 patch 里的 `?v=N` 加 1（多文件时相对导入不跟随 query，
net-autoswitch 的 `runtime/vN` 复制目录就是为绕这条）。只改 `config:` 不用动代码，
原地保存即热更。

## 实测记录（2026-10-13，本机）

| 项目 | 结果 |
|---|---|
| 直连握手（裸 curl，含 IPv6 首试） | 11.6s（内置 fetch 的 10s 砍在这里） |
| `curl -4` / `curl -6` | 1.2s / 直接失败（本机无 IPv6 出口） |
| 自建 Agent，connect=3s，黑洞地址 | 3.5s `ConnectTimeoutError`（超时生效） |
| 自建 Agent，`family: 4` | 200 ✓ |
| keep-alive 复用 | 2358ms → 416ms → 420ms |
| 坏相位里的 ~1s 整轮失败 | 是 **OS/WSL 层的快速失败**（ETIMEDOUT 毫秒级返回，node:tls 裸探针同样 ~1s 全灭），**不是** undici/Node 的放弃计时器 |
| 黑洞地址 4 连 × 默认/5s/15s attemptTimeout | 三者都等到 connect 超时（12.5s）才死——尝试是并行保留的，attemptTimeout 只管轮换节奏 |
| 单测 | 18/18 通过（0.1.1） |

## 实测记录（2026-10-15，本机）—— 上面「h2 的坑」「20 个地址里的 10 个是死的」两节的原始数据

| 项目 | 结果 |
|---|---|
| `opencode.ai` 的 DNS | 一次回 **20 个地址**：10 个 IPv4 + 10 个 IPv6 |
| 裸 TCP 连这 10 个 IPv4 | 全部成功，245–1332ms |
| `curl -6` | 秒失败（本机无 IPv6 出口） |
| `curl`（双栈，默认 happy eyeballs） | 8/8 HTTP 200，connect 0.27–0.46s |
| **内置 fetch**（undici 6.24.1，ALPN=h1） | **2/6 成功**，4 次 `UND_ERR_CONNECT_TIMEOUT`，中位 2511ms |
| 插件 Agent，`family: 0` | 6/6 成功，中位 352ms |
| 插件 Agent，`family: 4` | 6/6 成功，中位 379ms |
| 插件 Agent，ALPN（`allowH2` 默认） | `h2` |
| 插件 Agent，`allowH2: false` | `http/1.1`，4 连发新建连接数 = **1**（复用不受影响） |
| 同一连接并发 12 × 3 轮（`/models`） | h2 36/36、h1 36/36 —— 简单并发压不出 `ENHANCE_YOUR_CALM`，它只在 SSE 长流上出现 |
| 本机代理 `127.0.0.1:10808` | 3/3 HTTP 200，~0.9s（代理开着时插件让路，也就碰不到 h2 那套流控） |
