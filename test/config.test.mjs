import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeConfig, DEFAULTS } from "../lib/index.js";

test("默认值：直连接管 opencode.ai、connect 30s、body 关闭", () => {
  const cfg = normalizeConfig({});
  assert.equal(cfg.enabled, true);
  assert.deepEqual([...cfg.hosts], ["opencode.ai"]);
  assert.equal(cfg.connectTimeoutMs, 30_000);
  assert.equal(cfg.bodyTimeoutMs, 0);
  assert.equal(cfg.delegateOnProxyEnv, true);
  assert.equal(cfg.family, 0);
  // undici 8 的 allowH2 默认是 true（会把出口悄悄换成 h2），我们显式关掉
  assert.equal(cfg.allowH2, false);
  assert.equal(cfg.routePath, "/_dsh/undici-timeout");
});

test("allowH2：只认布尔，其余回默认 false", () => {
  assert.equal(normalizeConfig({ allowH2: true }).allowH2, true);
  assert.equal(normalizeConfig({ allowH2: false }).allowH2, false);
  assert.equal(normalizeConfig({ allowH2: "yes" }).allowH2, false);
  assert.equal(normalizeConfig({ allowH2: 1 }).allowH2, false);
});

test("hosts：数组去空、字符串逗号切分、非法回退默认", () => {
  assert.deepEqual([...normalizeConfig({ hosts: ["a.com", "", " b.com "] }).hosts], ["a.com", "b.com"]);
  assert.deepEqual([...normalizeConfig({ hosts: "a.com, b.com" }).hosts], ["a.com", "b.com"]);
  assert.deepEqual([...normalizeConfig({ hosts: [] }).hosts], ["opencode.ai"]);
  assert.deepEqual([...normalizeConfig({ hosts: 42 }).hosts], ["opencode.ai"]);
});

test("数值：范围内接受，越界/非整数回退", () => {
  assert.equal(normalizeConfig({ connectTimeoutMs: 45_000 }).connectTimeoutMs, 45_000);
  assert.equal(normalizeConfig({ connectTimeoutMs: 10 }).connectTimeoutMs, 30_000);
  assert.equal(normalizeConfig({ connectTimeoutMs: 1_000_000 }).connectTimeoutMs, 30_000);
  assert.equal(normalizeConfig({ connectTimeoutMs: 1.5 }).connectTimeoutMs, 30_000);
  assert.equal(normalizeConfig({ headersTimeoutMs: 0 }).headersTimeoutMs, 0);
  assert.equal(normalizeConfig({ pipelining: 0 }).pipelining, DEFAULTS.pipelining);
  assert.equal(normalizeConfig({ bodyTimeoutMs: 120_000 }).bodyTimeoutMs, 120_000);
});

test("family 只认 4/6，其余回 0（跟随系统）", () => {
  assert.equal(normalizeConfig({ family: 4 }).family, 4);
  assert.equal(normalizeConfig({ family: 6 }).family, 6);
  assert.equal(normalizeConfig({ family: 5 }).family, 0);
  assert.equal(normalizeConfig({ family: "4" }).family, 0);
});

test("autoSelectFamilyAttemptTimeoutMs：范围内接受、越界回 0（Node 默认 250ms）", () => {
  assert.equal(normalizeConfig({ autoSelectFamilyAttemptTimeoutMs: 8000 }).autoSelectFamilyAttemptTimeoutMs, 8000);
  assert.equal(normalizeConfig({ autoSelectFamilyAttemptTimeoutMs: 0 }).autoSelectFamilyAttemptTimeoutMs, 0);
  assert.equal(normalizeConfig({ autoSelectFamilyAttemptTimeoutMs: -1 }).autoSelectFamilyAttemptTimeoutMs, 0);
  assert.equal(normalizeConfig({ autoSelectFamilyAttemptTimeoutMs: 1_000_000 }).autoSelectFamilyAttemptTimeoutMs, 0);
});

test("routePath 必须同源绝对路径；probeUrl 必须是 http(s)", () => {
  assert.equal(normalizeConfig({ routePath: "foo" }).routePath, "/_dsh/undici-timeout");
  assert.equal(normalizeConfig({ routePath: "/x" }).routePath, "/x");
  assert.equal(normalizeConfig({ probeUrl: "ftp://x" }).probeUrl, DEFAULTS.probeUrl);
});

test("归一化结果冻结（含 hosts）", () => {
  const cfg = normalizeConfig({});
  assert.ok(Object.isFrozen(cfg));
  assert.ok(Object.isFrozen(cfg.hosts));
});
