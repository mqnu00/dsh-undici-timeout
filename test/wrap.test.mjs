import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  hostAllowed,
  parseUrl,
  proxyEnvSet,
  classifyFetchError,
  createAgent,
  createFetchWrapper,
  makeStatusHandler,
  normalizeConfig,
} from "../lib/index.js";

// ── 纯函数 ──────────────────────────────────────────────────────────────────

test("hostAllowed：精确 / 子域 / 通配 / 非命中", () => {
  const hosts = ["opencode.ai"];
  assert.equal(hostAllowed("opencode.ai", hosts), true);
  assert.equal(hostAllowed("api.opencode.ai", hosts), true);
  assert.equal(hostAllowed("OPENCODE.AI", hosts), true);
  assert.equal(hostAllowed("notopencode.ai", hosts), false);
  assert.equal(hostAllowed("opencode.ai.evil.com", hosts), false);
  assert.equal(hostAllowed("anything", ["*"]), true);
  assert.equal(hostAllowed("a.foo.com", ["*.foo.com"]), true);
});

test("parseUrl：字符串/URL 认，Request 一类不认（交给原 fetch）", () => {
  assert.equal(parseUrl("https://a.com/x")?.hostname, "a.com");
  assert.equal(parseUrl(new URL("https://a.com/x"))?.hostname, "a.com");
  assert.equal(parseUrl("not a url"), null);
  assert.equal(parseUrl({ url: "https://a.com/x" }), null);
  assert.equal(parseUrl(undefined), null);
});

test("proxyEnvSet：任一大小写代理变量非空即为真", () => {
  assert.equal(proxyEnvSet({}), false);
  assert.equal(proxyEnvSet({ https_proxy: "  " }), false);
  assert.equal(proxyEnvSet({ HTTP_PROXY: "http://127.0.0.1:10808" }), true);
  assert.equal(proxyEnvSet({ all_proxy: "socks5://127.0.0.1:1080" }), true);
});

test("classifyFetchError：timeout/连接/DNS 分类", () => {
  assert.equal(classifyFetchError(new TypeError("fetch failed", { cause: { name: "ConnectTimeoutError", code: "UND_ERR_CONNECT_TIMEOUT", message: "Connect Timeout Error" } })), "TIMEOUT");
  assert.equal(classifyFetchError(new TypeError("fetch failed", { cause: { name: "AggregateError", code: "ETIMEDOUT", message: "ETIMEDOUT" } })), "TIMEOUT");
  assert.equal(classifyFetchError(new TypeError("fetch failed", { cause: { code: "ECONNRESET", message: "socket hang up" } })), "CONNECTION");
  assert.equal(classifyFetchError(new TypeError("fetch failed", { cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND" } })), "DNS");
  assert.equal(classifyFetchError(new Error("weird")), "OTHER");
});

test("createAgent：connect/family/attemptTimeout/keepAlive 映射正确", () => {
  class FakeAgent {
    constructor(options) { this.options = options; }
  }
  const undici = { Agent: FakeAgent };
  const cfg = normalizeConfig({
    connectTimeoutMs: 45000,
    family: 4,
    autoSelectFamilyAttemptTimeoutMs: 8000,
    bodyTimeoutMs: 0,
    headersTimeoutMs: 120000,
    keepAliveTimeoutMs: 30000,
    keepAliveMaxTimeoutMs: 300000,
    pipelining: 3,
  });
  const agent = createAgent(undici, cfg);
  assert.deepEqual(agent.options.connect, { timeout: 45000, family: 4, autoSelectFamilyAttemptTimeout: 8000 });
  assert.equal(agent.options.headersTimeout, 120000);
  assert.equal(agent.options.bodyTimeout, 0);
  assert.equal(agent.options.keepAliveTimeout, 30000);
  assert.equal(agent.options.keepAliveMaxTimeout, 300000);
  assert.equal(agent.options.pipelining, 3);
  assert.equal(agent.options.allowH2, false); // 默认关 h2（undici 8 的默认是开）

  const h2on = createAgent(undici, normalizeConfig({ allowH2: true }));
  assert.equal(h2on.options.allowH2, true);

  const plain = createAgent(undici, normalizeConfig({}));
  assert.deepEqual(plain.options.connect, { timeout: 30000 });
  assert.equal(plain.options.allowH2, false);
});

// ── fetch 包装器 ────────────────────────────────────────────────────────────

function makeStats() {
  return { matched: 0, ok: 0, failed: 0, delegatedProxy: 0, passthrough: 0, byError: {}, lastRequests: [] };
}

function withGlobalFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return Promise.resolve()
    .then(run)
    .finally(() => { globalThis.fetch = original; });
}

test("包装器：命中白名单 + 无代理 → 走 undici.fetch，且带上 dispatcher", async () => {
  const calls = [];
  const agent = { name: "fake-agent" };
  const fakeUndici = {
    fetch: async (input, init) => {
      calls.push({ input, init });
      return new Response("agent-body", { status: 200 });
    },
  };
  const previousCalls = [];
  const previous = async (input) => { previousCalls.push(input); return new Response("prev-body"); };

  await withGlobalFetch(previous, async () => {
    const stats = makeStats();
    const { wrapped, previous: captured } = createFetchWrapper({
      undici: fakeUndici,
      agent,
      hosts: ["opencode.ai"],
      delegateOnProxyEnv: true,
      stats,
      log: () => {},
      env: () => ({}),
    });
    assert.equal(captured, previous);

    const res = await wrapped("https://opencode.ai/zen/go/v1/models", { signal: undefined, headers: { a: "b" } });
    assert.equal(await res.text(), "agent-body");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.dispatcher, agent);
    assert.equal(calls[0].init.headers.a, "b");
    assert.equal(previousCalls.length, 0);
    assert.equal(stats.matched, 1);
    assert.equal(stats.ok, 1);
    assert.equal(stats.lastRequests[0].host, "opencode.ai");
  });
});

test("包装器：有代理 env → 原样让路", async () => {
  const calls = [];
  const fakeUndici = { fetch: async () => { calls.push("undici"); return new Response("x"); } };
  const previousCalls = [];
  const previous = async () => { previousCalls.push("prev"); return new Response("prev"); };

  await withGlobalFetch(previous, async () => {
    const stats = makeStats();
    const { wrapped } = createFetchWrapper({
      undici: fakeUndici,
      agent: {},
      hosts: ["opencode.ai"],
      delegateOnProxyEnv: true,
      stats,
      log: () => {},
      env: () => ({ https_proxy: "http://127.0.0.1:10808" }),
    });
    await wrapped("https://opencode.ai/zen/go/v1/models");
    assert.equal(calls.length, 0);
    assert.equal(previousCalls.length, 1);
    assert.equal(stats.delegatedProxy, 1);
  });
});

test("包装器：非白名单域名 / 不可解析输入 → 透传", async () => {
  const calls = [];
  const fakeUndici = { fetch: async () => { calls.push("undici"); return new Response("x"); } };
  const previousCalls = [];
  const previous = async () => { previousCalls.push("prev"); return new Response("prev"); };

  await withGlobalFetch(previous, async () => {
    const stats = makeStats();
    const { wrapped } = createFetchWrapper({
      undici: fakeUndici,
      agent: {},
      hosts: ["opencode.ai"],
      delegateOnProxyEnv: true,
      stats,
      log: () => {},
      env: () => ({}),
    });
    await wrapped("https://example.com/");
    await wrapped({ url: "https://opencode.ai/" });
    assert.equal(calls.length, 0);
    assert.equal(previousCalls.length, 2);
    assert.equal(stats.passthrough, 2);
  });
});

test("包装器：失败分类进统计，且异常原样抛出", async () => {
  const boom = new TypeError("fetch failed", {
    cause: { name: "ConnectTimeoutError", code: "UND_ERR_CONNECT_TIMEOUT", message: "Connect Timeout Error" },
  });
  const fakeUndici = { fetch: async () => { throw boom; } };
  const previous = async () => new Response("prev");

  await withGlobalFetch(previous, async () => {
    const stats = makeStats();
    const { wrapped } = createFetchWrapper({
      undici: fakeUndici,
      agent: {},
      hosts: ["opencode.ai"],
      delegateOnProxyEnv: true,
      stats,
      log: () => {},
      env: () => ({}),
    });
    await assert.rejects(() => wrapped("https://opencode.ai/x"), (e) => e === boom);
    assert.equal(stats.failed, 1);
    assert.equal(stats.byError.TIMEOUT, 1);
    assert.equal(stats.lastRequests.at(-1).error, "TIMEOUT");
  });
});

// ── 状态路由 ────────────────────────────────────────────────────────────────

function fakeRes() {
  return {
    code: 0,
    headers: null,
    body: "",
    writeHead(code, headers) { this.code = code; this.headers = headers; },
    end(text) { this.body = text; },
  };
}

function fakeReq({ method = "GET", headers = {}, body = "" } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;
  req.on("error", () => {});
  process.nextTick(() => {
    if (body) req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

test("状态路由：GET 读快照 / 非白名单 Host 403 / POST 头校验 / probeNow", async () => {
  const probes = [];
  const handler = makeStatusHandler({
    allowedHosts: ["127.0.0.1", "localhost"],
    snapshot: () => ({ version: "0.1.0", stats: { matched: 3 } }),
    probeNow: (reason) => { probes.push(reason); },
  });

  {
    const res = fakeRes();
    handler(fakeReq({ headers: { host: "127.0.0.1:3080" } }), res);
    const parsed = JSON.parse(res.body);
    assert.equal(res.code, 200);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.plugin, "undici-timeout");
    assert.equal(parsed.stats.matched, 3);
  }
  {
    const res = fakeRes();
    handler(fakeReq({ headers: { host: "evil.example.com" } }), res);
    assert.equal(res.code, 403);
  }
  {
    const res = fakeRes();
    handler(fakeReq({ method: "POST", headers: { host: "127.0.0.1:3080" }, body: "{}" }), res);
    assert.equal(res.code, 403); // 缺自定义头
  }
  {
    const res = fakeRes();
    handler(fakeReq({
      method: "POST",
      headers: { host: "127.0.0.1:3080", "x-dsh-undici-timeout": "1" },
      body: JSON.stringify({ action: "probeNow" }),
    }), res);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(res.code, 202);
    assert.deepEqual(probes, ["HTTP 手动触发"]);
  }
});
