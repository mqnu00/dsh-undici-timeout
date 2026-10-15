// dsh-undici-timeout —— cordis 宿主半（刻意单文件，见 README「改代码」一节）
//
// 目的：给 LLM 出口（globalThis.fetch → Node 内置 undici）换一条「可配置超时 +
// 可保活复用」的直连通道。背景（本机实测，2026-10-13）：
//   - Node 内置 fetch 背后的 undici connectTimeout 固定 10s（DNS+TCP+TLS 都算）；
//   - 本机直连 opencode.ai 的新建握手实测出现过 11.6s，双栈探针也常整轮 AggregateError；
//   - pi-ai 每次重试都 new OpenAI(...) → shims.getDefaultFetch() 当场读 globalThis.fetch，
//     ⇒ 每次尝试都是新连接，被 10s 砍掉 → TIMEOUT/TRANSPORT → 重试又重连，空转。
//
// 做法：
//   1) 解析 harness 进程自己那份 undici（argv[1] → profile 扫描 → bare），建一个 Agent：
//      connect.timeout / headersTimeout / bodyTimeout / keepAlive* / 可选 family；
//   2) 包装 globalThis.fetch：命中 hosts 白名单且当前**没有**代理 env 时，改走
//      undici.fetch(input, { ...init, dispatcher: agent })；否则原样交给原 fetch。
//      （不碰 setGlobalDispatcher：那是 @deepseek-ai/dsh-http-proxy 的地盘，抢了会
//       把代理联动弄坏。本插件只接管「本来要走直连」的那部分流量。）
//   3) 只读状态路由 GET <routePath>；POST {action:"probeNow"} 需自定义头。
//
// 与 dsh-net-proxy 共存：它的 fetch 包装器只在「代理开」时上链，且闭包惰性读配置；
// 我们只在没有代理 env 时接管，两边互不拆台（细节见 README「与 net-proxy 的共存」）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const name = "undici-timeout";
export const inject = [];

export const VERSION = "0.1.1";

/** 进程级实例槽：HMR 重挂时旧 fiber 不一定被释放，靠它让新实例把前任挤下岗。 */
const INSTANCE_KEY = Symbol.for("dsh-undici-timeout.instance");
/** 打在包装函数上的标记（诊断/测试用）。 */
const WRAP_MARK = Symbol.for("dsh-undici-timeout.wrapper");

const MAX_LOG_BYTES = 1024 * 1024;
const POST_HEADER = "x-dsh-undici-timeout";
const MAX_POST_BODY = 8 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// 配置（不用 schemastery：本插件零 npm 依赖，file:// 直接可加载，校验自己写）
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULTS = Object.freeze({
  enabled: true,
  // 命中这些域名（含子域）才接管；"*" = 全部直连流量
  hosts: Object.freeze(["opencode.ai"]),
  // undici connect 超时：DNS + TCP + TLS 全算在内（内置 fetch 固定 10s）
  connectTimeoutMs: 30_000,
  headersTimeoutMs: 300_000,
  // 0 = 关闭（SSE 卡流交给 pi-ai 自己的 streamIdleTimeoutMs 看门狗，别打架）
  bodyTimeoutMs: 0,
  // 保活 = 连接复用；这是「不重握手」的关键
  keepAliveTimeoutMs: 60_000,
  keepAliveMaxTimeoutMs: 600_000,
  pipelining: 1,
  // 0 = 跟随系统；4/6 = 强制 IP 族（本机 IPv6 无出口时 4 很划算）
  family: 0,
  // 是否允许 HTTP/2。⚠️ 默认 false：undici 8 把 allowH2 的默认值翻成了 true，
  // 而 harness 内置 fetch（Node 22 自带的 undici 6.24.1）走的是 HTTP/1.1。
  // 用 undici 8 建 Agent 就会「顺手」把 LLM 出口换成 h2 —— 换协议不是本插件
  // 的目的，且实测 h2 上 SSE 长流会被边缘用 NGHTTP2_ENHANCE_YOUR_CALM 掐断
  // （见 README「h2 的坑」）。显式关掉 = 行为与内置 fetch 对齐，keep-alive 复用照旧。
  allowH2: false,
  // Node happy-eyeballs 的「下一个地址尝试」间隔（默认 250ms）：尝试是并行保留的，
  // 这个值只是轮换节奏，不是单地址的放弃窗口——改大反而拖慢地址轮换，一般别动。
  // 0 = 用 Node 默认值；实测（黑洞地址 4 连）默认与调大都会等到 connect 超时才死。
  autoSelectFamilyAttemptTimeoutMs: 0,
  // 代理 env 在场时让路给 harness 的代理层（net-proxy / dsh-http-proxy）
  delegateOnProxyEnv: true,
  // 显式指定 undici 入口（留空自动解析）
  undiciPath: "",
  probeOnStart: true,
  probeUrl: "https://opencode.ai/zen/go/v1/models",
  probeTimeoutMs: 15_000,
  // >0 时把达到该耗时的请求写日志（网络抖动期的耐心阈值，0=关闭）
  logSlowMs: 0,
  // 失败请求总是记日志（低频、含 cause；排障用）
  logFailures: true,
  routePath: "/_dsh/undici-timeout",
  logFile: "",
});

const INT_RANGES = Object.freeze({
  connectTimeoutMs: [1000, 600_000],
  headersTimeoutMs: [0, 600_000],
  bodyTimeoutMs: [0, 600_000],
  keepAliveTimeoutMs: [0, 600_000],
  keepAliveMaxTimeoutMs: [0, 3_600_000],
  pipelining: [1, 100],
  probeTimeoutMs: [1000, 600_000],
  logSlowMs: [0, 600_000],
  autoSelectFamilyAttemptTimeoutMs: [0, 600_000],
});

const STRING_KEYS = Object.freeze([
  "undiciPath",
  "probeUrl",
  "routePath",
  "logFile",
]);

/** 归一化配置：未知字段忽略，非法值回退默认；返回冻结对象。 */
export function normalizeConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const cfg = { ...DEFAULTS };

  if (typeof src.enabled === "boolean") cfg.enabled = src.enabled;

  if (Array.isArray(src.hosts)) {
    const hosts = src.hosts.map((x) => String(x ?? "").trim()).filter(Boolean);
    if (hosts.length > 0) cfg.hosts = hosts;
  } else if (typeof src.hosts === "string" && src.hosts.trim() !== "") {
    cfg.hosts = src.hosts.split(",").map((s) => s.trim()).filter(Boolean);
  }

  for (const [key, [min, max]] of Object.entries(INT_RANGES)) {
    const value = src[key];
    if (Number.isInteger(value) && value >= min && value <= max) cfg[key] = value;
  }

  if (src.family === 4 || src.family === 6) cfg.family = src.family;
  if (typeof src.allowH2 === "boolean") cfg.allowH2 = src.allowH2;

  if (typeof src.delegateOnProxyEnv === "boolean") cfg.delegateOnProxyEnv = src.delegateOnProxyEnv;
  if (typeof src.probeOnStart === "boolean") cfg.probeOnStart = src.probeOnStart;
  if (typeof src.logFailures === "boolean") cfg.logFailures = src.logFailures;

  for (const key of STRING_KEYS) {
    if (typeof src[key] === "string") cfg[key] = src[key].trim();
  }

  if (!cfg.routePath.startsWith("/")) cfg.routePath = DEFAULTS.routePath;
  if (!/^https?:\/\//i.test(cfg.probeUrl)) cfg.probeUrl = DEFAULTS.probeUrl;

  return Object.freeze({ ...cfg, hosts: Object.freeze([...cfg.hosts]) });
}

// ─────────────────────────────────────────────────────────────────────────────
// 纯工具（全部可单测：不碰全局状态）
// ─────────────────────────────────────────────────────────────────────────────

const PROXY_ENV_NAMES = Object.freeze([
  "http_proxy", "HTTP_PROXY",
  "https_proxy", "HTTPS_PROXY",
  "all_proxy", "ALL_PROXY",
]);

/** 当前环境里有没有「生效中」的代理配置（net-proxy 开关就是切这些变量）。 */
export function proxyEnvSet(env = process.env) {
  for (const name of PROXY_ENV_NAMES) {
    const value = env?.[name];
    if (typeof value === "string" && value.trim() !== "") return true;
  }
  return false;
}

/** input → URL；只认字符串与 URL 实例（Request 一类交给原 fetch，避免跨实例坑）。 */
export function parseUrl(input) {
  if (typeof input === "string") {
    try { return new URL(input); } catch { return null; }
  }
  if (input instanceof URL) return input;
  return null;
}

/** 域名白名单匹配：opencode.ai 命中 opencode.ai 与任意子域；"*" 命中一切。 */
export function hostAllowed(hostname, hosts) {
  const host = String(hostname || "").toLowerCase();
  if (host === "") return false;
  for (const raw of hosts) {
    const entry = String(raw ?? "").trim().toLowerCase().replace(/^\*\./, "");
    if (entry === "") continue;
    if (entry === "*") return true;
    if (host === entry || host.endsWith("." + entry)) return true;
  }
  return false;
}

/** fetch 失败 → 归一类（对齐 dsh-llm-retry-settings 的错误码口味，便于对照日志）。 */
export function classifyFetchError(error) {
  const cause = error?.cause;
  const text = [
    error?.name, error?.message, error?.code,
    cause?.name, cause?.message, cause?.code,
  ].filter(Boolean).join(" ");
  if (/timeout|ETIMEDOUT/i.test(text)) return "TIMEOUT";
  if (/ENOTFOUND|EAI_AGAIN/i.test(text)) return "DNS";
  if (/CERT|TLS|SSL/i.test(text)) return "TLS";
  if (/socket|ECONN|EPIPE|terminated|closed/i.test(text)) return "CONNECTION";
  return "OTHER";
}

/** 失败原因里最短的那个可读片段（日志用）。 */
export function shortCause(error) {
  const cause = error?.cause;
  if (cause) {
    const bits = [cause.name, cause.code, cause.message].filter(Boolean).join(" / ");
    if (bits) return bits;
  }
  return String(error?.message || error);
}

// ─────────────────────────────────────────────────────────────────────────────
// undici 解析 / Agent / fetch 包装
// ─────────────────────────────────────────────────────────────────────────────

function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  return fromEnv && fromEnv.trim() !== "" ? fromEnv : path.join(os.homedir(), ".dsh");
}

export function defaultLogFile() {
  return path.join(dshHome(), "logs", "dsh-undici-timeout", "host.log");
}

/** 读取 undici 包版本（从 index.js 旁边的 package.json；失败返回 null）。 */
export function readUndiciVersion(entryFile) {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(path.dirname(entryFile), "package.json"), "utf8"));
    return typeof pj.version === "string" ? pj.version : null;
  } catch {
    return null;
  }
}

async function tryLoadUndici(entryFile, via, attempts) {
  try {
    const mod = await import(pathToFileURL(entryFile).href);
    if (typeof mod.fetch !== "function" || typeof mod.Agent !== "function") {
      attempts.push(`${via}: ${entryFile} 不是 undici（缺 fetch/Agent 导出）`);
      return null;
    }
    return { mod, via, path: entryFile };
  } catch (error) {
    attempts.push(`${via}: ${String(error?.message || error)}`);
    return null;
  }
}

/**
 * 解析 harness 进程使用的那份 undici。
 * 顺序：config.undiciPath → argv[1]（dsh 主脚本）→ profile 扫描 → bare。
 * 用的是哪一份不重要（我们只借它建 Agent，不碰它的全局 dispatcher），
 * 但优先 argv[1] 能跟 harness 自己 import('undici') 命中同一棵树。
 */
export async function resolveUndici(cfg = DEFAULTS) {
  const attempts = [];

  if (cfg.undiciPath) {
    let candidate = path.resolve(cfg.undiciPath);
    try {
      if (fs.statSync(candidate).isDirectory()) candidate = path.join(candidate, "index.js");
    } catch {
      attempts.push(`config.undiciPath: 不存在 ${candidate}`);
    }
    const found = await tryLoadUndici(candidate, "config.undiciPath", attempts);
    if (found) return found;
  }

  const argv1 = process.argv?.[1];
  if (argv1 && path.isAbsolute(argv1)) {
    // dsh 的入口常是 bin 里的软链（…/bin/dsh → …/lib/…/bin.js），先原样再 realpath，
    // 这样能解析到 harness 自己那棵树里的 undici（与它 import('undici') 同版本）。
    const candidates = [argv1];
    try {
      const real = fs.realpathSync(argv1);
      if (real !== argv1) candidates.push(real);
    } catch { /* 软链坏了就算了 */ }
    for (const candidate of candidates) {
      try {
        const entry = createRequire(candidate).resolve("undici");
        const found = await tryLoadUndici(entry, "argv", attempts);
        if (found) return found;
      } catch (error) {
        attempts.push(`argv: ${String(error?.message || error)}`);
      }
    }
  }

  try {
    const profilesDir = path.join(dshHome(), "profiles");
    for (const profile of fs.readdirSync(profilesDir).sort()) {
      const entry = path.join(profilesDir, profile, "node_modules", "undici", "index.js");
      if (!fs.existsSync(entry)) continue;
      const found = await tryLoadUndici(entry, `profile:${profile}`, attempts);
      if (found) return found;
    }
  } catch (error) {
    attempts.push(`profiles: ${String(error?.message || error)}`);
  }

  try {
    const mod = await import("undici");
    if (typeof mod.fetch === "function" && typeof mod.Agent === "function") {
      return { mod, via: "bare", path: "(bare import)" };
    }
    attempts.push("bare: 模块缺 fetch/Agent 导出");
  } catch (error) {
    attempts.push(`bare: ${String(error?.message || error)}`);
  }

  return { mod: null, attempts };
}

/** 按配置建 Agent。connect.timeout 就是内置 fetch 那个固定 10s 的可配置版本。 */
export function createAgent(undici, cfg) {
  const connect = { timeout: cfg.connectTimeoutMs };
  if (cfg.family === 4 || cfg.family === 6) connect.family = cfg.family;
  if (cfg.autoSelectFamilyAttemptTimeoutMs > 0) {
    connect.autoSelectFamilyAttemptTimeout = cfg.autoSelectFamilyAttemptTimeoutMs;
  }
  return new undici.Agent({
    connect,
    // 显式传：undici 8 的默认值是 true，会把出口协议从 h1 换成 h2（见 DEFAULTS 注释）
    allowH2: cfg.allowH2 === true,
    headersTimeout: cfg.headersTimeoutMs,
    bodyTimeout: cfg.bodyTimeoutMs,
    keepAliveTimeout: cfg.keepAliveTimeoutMs,
    keepAliveMaxTimeout: cfg.keepAliveMaxTimeoutMs,
    pipelining: cfg.pipelining,
  });
}

/**
 * 造包装器。返回 { wrapped, previous }；调用方自己决定装/摘。
 * 关键行为：命中白名单 + 无代理 env → 走 undici.fetch(+dispatcher agent)；
 * 其余一律原样透传 previous（含 Request 输入、代理模式、非白名单域名）。
 */
export function createFetchWrapper({ undici, agent, hosts, delegateOnProxyEnv, stats, log, logSlowMs = 0, logFailures = true, env = () => process.env }) {
  const previous = globalThis.fetch;
  if (typeof previous !== "function") {
    throw new Error("globalThis.fetch 不存在，无法包装");
  }

  function record(url, startedAt, response, error) {
    const ms = Math.round(performance.now() - startedAt);
    const entry = {
      at: new Date().toISOString(),
      host: url.host,
      path: url.pathname,
      ms,
      status: response ? response.status : null,
      error: error ? classifyFetchError(error) : null,
    };
    stats.lastRequests.push(entry);
    if (stats.lastRequests.length > 10) stats.lastRequests.shift();
    if (response) {
      stats.ok += 1;
    } else {
      stats.failed += 1;
      stats.byError[entry.error] = (stats.byError[entry.error] || 0) + 1;
      if (logFailures) log("warn", `请求失败 ${entry.error}（${ms}ms）${url.href} :: ${shortCause(error)}`);
    }
    if (logSlowMs > 0 && ms >= logSlowMs) {
      log("warn", `慢请求 ${ms}ms ${entry.status ?? entry.error ?? "-"} ${url.href}`);
    }
  }

  const wrapped = function undiciTimeoutFetch(input, init) {
    let url = null;
    try { url = parseUrl(input); } catch { url = null; }

    if (url === null || !hostAllowed(url.hostname, hosts)) {
      stats.passthrough += 1;
      return previous(input, init);
    }
    if (delegateOnProxyEnv && proxyEnvSet(env())) {
      stats.delegatedProxy += 1;
      return previous(input, init);
    }

    stats.matched += 1;
    const startedAt = performance.now();
    const options = init && typeof init === "object" ? { ...init, dispatcher: agent } : { dispatcher: agent };
    return undici.fetch(input, options).then(
      (response) => {
        record(url, startedAt, response, null);
        return response;
      },
      (error) => {
        record(url, startedAt, null, error);
        throw error;
      },
    );
  };
  Object.defineProperty(wrapped, WRAP_MARK, { value: true });

  return { wrapped, previous };
}

// ─────────────────────────────────────────────────────────────────────────────
// 日志 / 状态路由（安全模型与 dsh-net-autoswitch 完全一致）
// ─────────────────────────────────────────────────────────────────────────────

function makeLogger(ctx, logFile) {
  let dirReady = false;
  return function log(level, message) {
    const lv = ["debug", "info", "warn", "error"].includes(level) ? level : "info";
    try {
      const fn = typeof ctx?.logger?.[lv] === "function" ? ctx.logger[lv].bind(ctx.logger) : ctx?.logger?.info?.bind(ctx?.logger);
      if (typeof fn === "function") fn(`[undici-timeout] ${message}`);
    } catch { /* 日志失败绝不能影响主流程 */ }
    try {
      if (!logFile) return;
      if (!dirReady) {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        dirReady = true;
      }
      try {
        if (fs.statSync(logFile).size > MAX_LOG_BYTES) fs.renameSync(logFile, `${logFile}.1`);
      } catch { /* 不存在 / 轮转失败都无所谓 */ }
      fs.appendFileSync(logFile, `${new Date().toISOString()} [${lv}] ${message}\n`, "utf8");
    } catch { /* 同上 */ }
  };
}

export function hostFromHeader(hostHeader) {
  if (!hostHeader) return "";
  let h = String(hostHeader).trim().toLowerCase();
  if (h.startsWith("[")) {
    const close = h.indexOf("]");
    return close === -1 ? h : h.slice(1, close);
  }
  const ci = h.lastIndexOf(":");
  if (ci !== -1 && h.indexOf(":") === ci && /^\d+$/.test(h.slice(ci + 1))) h = h.slice(0, ci);
  return h;
}

export function isAllowedHost(hostHeader, allowed) {
  const host = hostFromHeader(hostHeader);
  if (!host) return true;
  const list = Array.isArray(allowed) && allowed.length ? allowed : ["127.0.0.1", "localhost", "::1"];
  return list.map((x) => String(x).trim().toLowerCase()).includes(host);
}

export function originMatchesHost(origin, hostHeader) {
  try {
    const o = new URL(String(origin));
    const hh = String(hostHeader || "").trim().toLowerCase();
    if (!hh) return true;
    return o.host === hh || o.hostname === hostFromHeader(hh);
  } catch {
    return false;
  }
}

export function localHostAllowlist() {
  const names = new Set(["127.0.0.1", "localhost", "::1"]);
  try { if (os.hostname()) names.add(os.hostname().toLowerCase()); } catch { /* 取不到就算了 */ }
  try {
    for (const list of Object.values(os.networkInterfaces() || {})) {
      for (const it of list || []) {
        if (it && typeof it.address === "string") names.add(it.address.toLowerCase());
      }
    }
  } catch { /* 同上 */ }
  return [...names].filter(Boolean);
}

/**
 * 状态路由 handler：GET 读快照；POST {action:"probeNow"} 立刻跑一次探针。
 * @param {{ snapshot: () => object, probeNow: (reason: string) => unknown }} opts
 */
export function makeStatusHandler(opts) {
  const allowedHosts = opts.allowedHosts;
  return function statusHandler(req, res) {
    const send = (code, obj) => {
      const text = JSON.stringify(obj, null, 2);
      res.writeHead(code, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(text),
      });
      res.end(text);
    };
    const deny = (code, msg) => send(code, { ok: false, error: msg });
    const headers = req.headers || {};

    if (!isAllowedHost(headers.host, allowedHosts)) return deny(403, "forbidden host");

    if (req.method === "GET" || req.method === "HEAD") {
      return send(200, { ok: true, plugin: "undici-timeout", pid: process.pid, ...opts.snapshot() });
    }

    if (req.method === "POST") {
      if (String(headers[POST_HEADER] || "") !== "1") return deny(403, `missing ${POST_HEADER} header`);
      if (headers.origin && !originMatchesHost(headers.origin, headers.host)) return deny(403, "cross-origin request");
      let body = "";
      let overflow = false;
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > MAX_POST_BODY) {
          overflow = true;
          body = "";
          try { req.destroy(); } catch { /* 已断 */ }
        }
      });
      req.on("end", () => {
        if (overflow) return send(413, { ok: false, error: "payload too large" });
        let payload;
        try { payload = JSON.parse(body || "{}"); } catch { return send(400, { ok: false, error: "invalid json" }); }
        const action = payload && typeof payload.action === "string" ? payload.action : "";
        if (action === "probeNow") {
          void opts.probeNow("HTTP 手动触发");
          return send(202, { ok: true, accepted: action, lastProbe: opts.snapshot().lastProbe });
        }
        return deny(400, `unknown action: ${action || "(empty)"}`);
      });
      return undefined;
    }

    return deny(405, "method not allowed");
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 插件主体
// ─────────────────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const cfg = normalizeConfig(config);
  const logFile = cfg.logFile || defaultLogFile();
  const log = makeLogger(ctx, logFile);

  const stats = {
    matched: 0,
    ok: 0,
    failed: 0,
    delegatedProxy: 0,
    passthrough: 0,
    byError: {},
    lastRequests: [],
    lastProbe: null,
    installedAt: null,
    wrapper: false,
  };

  let undiciMod = null;
  let resolveInfo = null;
  let agent = null;
  let undo = null;
  let retired = false;
  let routeDispose = null;

  // ── 单实例认领（HMR 防僵尸：旧 fiber 的 disposer 实测不保证被调）──────────
  const instance = { id: Math.random().toString(36).slice(2, 8), createdAt: Date.now(), retire: null };
  const previousInstance = globalThis[INSTANCE_KEY];
  globalThis[INSTANCE_KEY] = instance;
  if (previousInstance && previousInstance !== instance && typeof previousInstance.retire === "function") {
    try { previousInstance.retire("被新实例接管"); } catch { /* 前任退位失败也不能拖住新的 */ }
  }
  const isCurrent = () => globalThis[INSTANCE_KEY] === instance;

  function retire(reason) {
    if (retired) return;
    retired = true;
    try { undo?.(); } catch { /* 已摘 */ }
    undo = null;
    stats.wrapper = false;
    try { routeDispose?.(); } catch { /* 已摘 */ }
    routeDispose = null;
    const dying = agent;
    agent = null;
    if (dying && typeof dying.close === "function") {
      try { void Promise.resolve(dying.close()).catch(() => { /* 关不掉也不阻塞退位 */ }); } catch { /* 同上 */ }
    }
    log("info", `本实例（${instance.id}）退位：${reason}`);
  }
  instance.retire = retire;

  async function probeNow(reason) {
    if (retired || !agent || !undiciMod) return stats.lastProbe;
    const startedAt = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`probe timeout after ${cfg.probeTimeoutMs}ms`)),
      cfg.probeTimeoutMs,
    );
    try {
      const res = await undiciMod.fetch(cfg.probeUrl, {
        dispatcher: agent,
        signal: controller.signal,
        headers: { "user-agent": `dsh-undici-timeout/${VERSION}` },
      });
      const ms = Math.round(performance.now() - startedAt);
      try { await res.body?.cancel?.(); } catch { /* 不要 body */ }
      stats.lastProbe = { at: new Date().toISOString(), reason, ok: true, status: res.status, ms };
      log("info", `探针（${reason}）：HTTP ${res.status} ${ms}ms ${cfg.probeUrl}`);
    } catch (error) {
      const ms = Math.round(performance.now() - startedAt);
      stats.lastProbe = {
        at: new Date().toISOString(),
        reason,
        ok: false,
        error: classifyFetchError(error),
        message: shortCause(error),
        ms,
      };
      log("warn", `探针（${reason}）失败：${stats.lastProbe.error}（${ms}ms）${stats.lastProbe.message}`);
    } finally {
      clearTimeout(timer);
    }
    return stats.lastProbe;
  }

  async function boot() {
    if (retired) return;
    const found = await resolveUndici(cfg);
    if (retired) return;
    if (!found.mod) {
      log("error", `解析不到 undici（尝试：${found.attempts.join("；") || "(无)"}）——fetch 保持原样`);
      return;
    }
    undiciMod = found.mod;
    resolveInfo = { via: found.via, path: found.path, version: readUndiciVersion(found.path) };

    let wrapped;
    let previous;
    try {
      agent = createAgent(undiciMod, cfg);
      ({ wrapped, previous } = createFetchWrapper({
        undici: undiciMod,
        agent,
        hosts: cfg.hosts,
        delegateOnProxyEnv: cfg.delegateOnProxyEnv,
        stats,
        log,
        logSlowMs: cfg.logSlowMs,
        logFailures: cfg.logFailures,
      }));
    } catch (error) {
      log("error", `安装失败（fetch 保持原样）：${String(error?.message || error)}`);
      return;
    }

    undo = () => {
      // 只在链顶还是自己时才摘（后装的其他包装器不能被我们撸掉）
      if (globalThis.fetch === wrapped) globalThis.fetch = previous;
    };
    globalThis.fetch = wrapped;
    stats.wrapper = true;
    stats.installedAt = new Date().toISOString();

    const bodyText = cfg.bodyTimeoutMs === 0 ? "off" : `${cfg.bodyTimeoutMs}ms`;
    log("info",
      `已接管 fetch（仅直连流量）：hosts=${cfg.hosts.join(",")}`
      + ` connect=${cfg.connectTimeoutMs}ms headers=${cfg.headersTimeoutMs}ms body=${bodyText}`
      + ` keepAlive=${cfg.keepAliveTimeoutMs}ms/${cfg.keepAliveMaxTimeoutMs}ms family=${cfg.family || "auto"}`
      + ` h2=${cfg.allowH2 ? "on" : "off"}`
      + ` attemptTimeout=${cfg.autoSelectFamilyAttemptTimeoutMs || "node-default"}`
      + ` undici=${resolveInfo.version || "?"}（${resolveInfo.via}: ${resolveInfo.path}）`);

    if (cfg.probeOnStart) void probeNow("启动探针");
  }

  if (cfg.enabled) void boot();
  else log("info", "enabled=false：不改 fetch（状态路由仍可用）");
  log("info", `配置文件：log=${logFile} undici=${cfg.undiciPath || "(自动解析)"}${cfg.enabled ? "" : " enabled=false"}`);

  // ── 状态路由 ─────────────────────────────────────────────────────────────
  function snapshot() {
    return {
      version: VERSION,
      instance: instance.id,
      retired,
      config: cfg,
      undici: resolveInfo ? { ...resolveInfo } : { via: null, path: null, version: null },
      proxyEnv: proxyEnvSet(),
      stats: {
        ...stats,
        byError: { ...stats.byError },
        lastRequests: [...stats.lastRequests],
      },
      lastProbe: stats.lastProbe,
    };
  }

  ctx.inject(["webServer"], (wctx) => {
    try {
      const ws = wctx?.webServer;
      if (!ws || typeof ws.register !== "function") {
        log("warn", "webServer 不可用：状态路由未注册（fetch 包装本身不受影响）");
        return;
      }
      const handler = makeStatusHandler({
        allowedHosts: localHostAllowlist(),
        snapshot,
        probeNow,
      });
      wctx.effect(() => {
        const dispose = ws.register({ kind: "exact", path: cfg.routePath, handler });
        routeDispose = () => { try { dispose?.(); } catch { /* 已摘除 */ } };
        log("info", `状态路由已注册：${cfg.routePath}（GET 读状态；POST 需 ${POST_HEADER}: 1）`);
        return routeDispose;
      }, "undici-timeout: status route");
    } catch (error) {
      log("warn", `状态路由注册失败：${String(error?.message || error)}`);
    }
  });

  log("info", `实例 ${instance.id} 已上岗（pid=${process.pid}）${isCurrent() ? "" : "（注意：已非当前实例）"}`);

  return () => retire("apply 的 disposer 被调用（正常卸载）");
}
