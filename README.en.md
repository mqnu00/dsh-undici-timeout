# dsh-undici-timeout

**A configurable direct channel for the DeepSeek Harness LLM egress.**

Node's built-in `fetch` (the undici bundled with Node) hard-codes its connect timeout at
**10 s** — DNS + TCP + TLS all inside that budget — and gives you no knob. When the direct
handshake to your provider takes longer than that, every retry re-handshakes and gets cut
again: `TIMEOUT` / `TRANSPORT`, in a loop. This plugin hands the LLM egress a keep-alive
undici Agent whose timeouts you control, so the connection is established once and reused.

中文文档（含实测数据、h2 的坑、排障）：[README.md](README.md)

## Install

**GitHub only** — this is a patch for upstream behaviour, not an npm package:

```sh
dsh plugin --profile web add github:mqnu00/dsh-undici-timeout
# pin a version
dsh plugin --profile web add github:mqnu00/dsh-undici-timeout#v0.1.1
```

Then restart DSH. No npm dependencies and no build step, so pnpm never asks for an
`allowBuilds` approval (the package has no `prepare` / `install` script).

> ⚠️ Do not install it twice: the bundled patch registers the entry id `undici-timeout`.
> If your profile already has a hand-written `file://` insert with that id, remove it first.

## Lifespan

This plugin exists for exactly two upstream reasons:

1. Node's built-in `fetch` hard-codes its connect timeout at **10 s**, with no knob;
2. undici 8 flipped `allowH2` to `true`, and a Cloudflare edge cuts long SSE streams on
   HTTP/2 with `NGHTTP2_ENHANCE_YOUR_CALM`.

Once DSH can set the LLM egress connect timeout itself — or swaps out the built-in fetch —
this plugin has no reason to exist. Remove it:

```sh
dsh plugin --profile web remove dsh-undici-timeout
```

Until then it stays a minimal patch: one file, no dependencies, only the hosts you
whitelist, removable at any time.

## What it does

```
agent turn
 └─ dsh-llm-retry → dsh-llm-pi-ai → pi-ai → new OpenAI({...})
      → openai client reads globalThis.fetch at call time
      → [this plugin's wrapper]
           ├─ host whitelisted AND no proxy env → undici.fetch(url, { dispatcher: own Agent })
           └─ anything else (proxy mode / other host / Request input) → pass through untouched
```

- Builds an `Agent` from **the harness's own undici** and pins it per request as `dispatcher`.
- It deliberately does **not** call `setGlobalDispatcher` — that belongs to
  `dsh-net-proxy` / `dsh-http-proxy`; hijacking it breaks proxy switching.
- Any proxy env (`http_proxy` / `https_proxy` / `ALL_PROXY`, upper or lower case) makes it
  stand down and hand the request to the proxy layer, so it coexists with `dsh-net-proxy`
  and `dsh-net-autoswitch`.
- **HTTP/2 is off by default.** undici 8 flipped `allowH2` to `true`; adopting that by
  accident silently switches the egress from HTTP/1.1 to HTTP/2, where a Cloudflare-fronted
  gateway cuts long SSE streams with `NGHTTP2_ENHANCE_YOUR_CALM`. Keep-alive reuse is
  identical on HTTP/1.1, so nothing is lost. Details in the Chinese README.
- Read-only status route: `GET http://127.0.0.1:3080/_dsh/undici-timeout`
  (matched / ok / failed / error classes / last 10 requests / last probe).

## Config

Set under this plugin's `config:` in your profile patch
(`~/.dsh/profiles/web/cordis.patch.yml`), or edit the copy shipped in the package.

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | master switch (the status route still works when `false`) |
| `hosts` | `["opencode.ai"]` | hosts (and subdomains) to take over; `"*"` = all direct traffic |
| `connectTimeoutMs` | `30000` | **the core knob** — DNS + TCP + TLS budget (built-in fetch: fixed 10 s) |
| `headersTimeoutMs` | `300000` | wait for response headers |
| `bodyTimeoutMs` | `0` | gap between body chunks; `0` = off (the LLM layer's own stream watchdog handles stalls) |
| `keepAliveTimeoutMs` | `60000` | idle socket retention — reuse is what avoids re-handshaking |
| `keepAliveMaxTimeoutMs` | `600000` | keep-alive ceiling |
| `pipelining` | `1` | concurrent requests per connection |
| `family` | `0` | `0` = follow the system; `4` / `6` = force an address family |
| `allowH2` | `false` | allow HTTP/2 (see above) |
| `delegateOnProxyEnv` | `true` | stand down when a proxy env is set |
| `probeOnStart` / `probeUrl` / `probeTimeoutMs` | `true` / provider models endpoint / `15000` | one startup probe, no tokens spent |
| `logSlowMs` / `logFailures` | `0` / `true` | log requests at/above a duration; log failures with their cause |
| `routePath` / `logFile` | `/_dsh/undici-timeout` / `$DSH_HOME/logs/dsh-undici-timeout/host.log` | status route path / log file |

On a machine with no IPv6 egress (WSL and friends), `family: 4` is worth setting: DNS often
returns ten IPv4 plus ten dead IPv6 addresses, and address-family detection can fail the
whole round on the dead ones.

## Verify

```sh
curl -s http://127.0.0.1:3080/_dsh/undici-timeout | python3 -m json.tool
node --test test/*.test.mjs     # 18 unit tests
node test/live-smoke.mjs        # real request outside DSH
./scripts/trial-install.sh      # trial-install into a scratch DSH_HOME (tarball source)
./scripts/trial-install.sh --git  # same, installed from a local bare git remote (github: source)
./scripts/trial-install.sh --spec=github:mqnu00/dsh-undici-timeout   # the real remote
```

`test/family-probe.mjs`, `test/h2-probe.mjs`, `test/burst-probe.mjs` and `test/sse-probe.mjs`
are the comparison probes used to pin down the two problems described in the Chinese README
(built-in fetch vs this Agent; HTTP/2 vs HTTP/1.1).

## Scope and safety

The plugin only rewrites the transport for the hosts you whitelist. It reads no files, holds
no credentials, makes no requests of its own except the optional probe to `probeUrl`, and
writes only its own log file. The status route binds no extra port — it is a handler on the
harness's existing web server, restricted to loopback hosts by Host header.

## License

MIT
