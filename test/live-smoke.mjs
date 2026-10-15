// 实机冒烟：不经过 DSH，直接用「本机实际解析到的那份 undici」跑一次包装器。
//   node test/live-smoke.mjs
// 期望：/zen/go/v1/models 返回 200/403（都算通），stats.matched=1；若本机
// 直连正卡在 >30s 的握手上，这里会看到 connect 超时被我们放大的 30s 接住。
import {
  normalizeConfig,
  resolveUndici,
  createAgent,
  createFetchWrapper,
  readUndiciVersion,
} from "../lib/index.js";

const cfg = normalizeConfig({ probeOnStart: false, delegateOnProxyEnv: false });
const found = await resolveUndici(cfg);
if (!found.mod) {
  console.error("解析不到 undici：", found.attempts);
  process.exit(1);
}
console.log(`undici: ${readUndiciVersion(found.path) ?? "?"} （${found.via}: ${found.path}）`);

const agent = createAgent(found.mod, cfg);
const stats = { matched: 0, ok: 0, failed: 0, delegatedProxy: 0, passthrough: 0, byError: {}, lastRequests: [] };
const original = globalThis.fetch;
const { wrapped } = createFetchWrapper({
  undici: found.mod,
  agent,
  hosts: cfg.hosts,
  delegateOnProxyEnv: false,
  stats,
  log: (level, message) => console.log(`[${level}] ${message}`),
  logFailures: true,
});
globalThis.fetch = wrapped;

try {
  const t0 = Date.now();
  const res = await fetch(cfg.probeUrl, { headers: { "user-agent": "dsh-undici-timeout/smoke" } });
  const ms = Date.now() - t0;
  await res.text();
  console.log(`HTTP ${res.status}  总耗时 ${ms}ms`);
  console.log("stats:", JSON.stringify(stats));
  if (stats.matched !== 1 || !stats.ok) {
    console.error("冒烟失败：请求没有走包装器，或没有成功");
    process.exit(1);
  }
  if (res.status !== 200 && res.status !== 403) {
    console.error(`冒烟失败：意外状态码 ${res.status}`);
    process.exit(1);
  }
  console.log("冒烟通过 ✓（并留意：连续跑两次时第二次应显著更快——keep-alive 复用）");
} finally {
  globalThis.fetch = original;
  await agent.close?.();
}
