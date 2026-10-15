// 对照探针：同一份 undici 8.11.2，只差 allowH2，看失败形态。
//   node test/h2-probe.mjs [轮数]
// 结论用途：确认「HTTP2 默认开着」是不是 NGHTTP2_ENHANCE_YOUR_CALM 的来源。
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const undici = require("/home/mqnu/.nvm/versions/node/v22.22.3/lib/node_modules/@deepseek-ai/dsh/node_modules/undici/index.js");

const URL_ = "https://opencode.ai/zen/go/v1/models";
const N = Number(process.argv[2] || 8);

function summarize(tag, rows) {
  const ok = rows.filter((r) => r.status === 200).length;
  const errs = rows.filter((r) => r.error);
  const byErr = {};
  for (const r of errs) {
    const k = `${r.code || r.name || "?"} / ${r.msg || ""}`.slice(0, 90);
    byErr[k] = (byErr[k] || 0) + 1;
  }
  console.log(`\n[${tag}] ${ok}/${rows.length} HTTP 200`);
  for (const r of rows) {
    console.log(`  ${r.ms}ms  ${r.status ?? "-"}  proto=${r.proto ?? "?"}  ${r.error ? `${r.name}/${r.code} ${r.msg}` : ""}`);
  }
  if (Object.keys(byErr).length) console.log("  错误分布:", byErr);
}

async function run(tag, agentOpts) {
  const agent = new undici.Agent({
    connect: { timeout: 30_000, ...(agentOpts.connect || {}) },
    headersTimeout: 300_000,
    bodyTimeout: 0,
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 600_000,
    pipelining: 1,
    ...agentOpts.top,
  });
  const rows = [];
  let proto = null;
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    try {
      const res = await undici.fetch(URL_, { dispatcher: agent, headers: { "user-agent": "dsh-undici-timeout/h2-probe" } });
      proto = res.httpVersion ? `HTTP/${res.httpVersion}` : proto;
      await res.body?.cancel?.();
      rows.push({ ms: Math.round(performance.now() - t0), status: res.status, proto });
    } catch (error) {
      const c = error?.cause || {};
      rows.push({
        ms: Math.round(performance.now() - t0),
        status: null,
        proto,
        error: true,
        name: error?.name,
        code: c.code || error?.code,
        msg: String(c.message || error?.message || "").slice(0, 120),
      });
    }
  }
  summarize(tag, rows);
  await agent.close();
}

const which = process.argv[3] || "both";
if (which === "both" || which === "h2") await run("allowH2=默认(true)", {});
if (which === "both" || which === "h1") await run("allowH2=false", { top: { allowH2: false } });
