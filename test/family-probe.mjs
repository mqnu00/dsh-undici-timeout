// 四路对照：内置 fetch / undici8 family=0 / undici8 family=4 / undici8 family=4+HTTP1
//   node test/family-probe.mjs [每路轮数]
// 目的：定位「~1-2.5s 整轮失败」到底来自地址族（IPv6 无出口）还是别处。
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const undici = require("/home/mqnu/.nvm/versions/node/v22.22.3/lib/node_modules/@deepseek-ai/dsh/node_modules/undici/index.js");

const URL_ = "https://opencode.ai/zen/go/v1/models";
const N = Number(process.argv[2] || 6);

function mkAgent({ family = 0, allowH2 = true } = {}) {
  const connect = { timeout: 30_000 };
  if (family) connect.family = family;
  return new undici.Agent({
    connect, allowH2,
    headersTimeout: 300_000, bodyTimeout: 0,
    keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000, pipelining: 1,
  });
}

const modes = [
  { name: "builtin-fetch      ", run: () => fetch(URL_, { headers: { "user-agent": "family-probe" } }) },
  { name: "undici8 family=0   ", run: (() => { const a = mkAgent(); return () => undici.fetch(URL_, { dispatcher: a, headers: { "user-agent": "family-probe" } }); })() },
  { name: "undici8 family=4   ", run: (() => { const a = mkAgent({ family: 4 }); return () => undici.fetch(URL_, { dispatcher: a, headers: { "user-agent": "family-probe" } }); })() },
  { name: "undici8 f4 + http1 ", run: (() => { const a = mkAgent({ family: 4, allowH2: false }); return () => undici.fetch(URL_, { dispatcher: a, headers: { "user-agent": "family-probe" } }); })() },
];

const stats = modes.map(() => ({ ok: 0, err: 0, ms: [], errs: {} }));

for (let round = 0; round < N; round++) {
  for (let i = 0; i < modes.length; i++) {
    const t0 = performance.now();
    try {
      const res = await modes[i].run();
      const ms = Math.round(performance.now() - t0);
      try { await res.body?.cancel?.(); } catch {}
      stats[i].ok++; stats[i].ms.push(ms);
    } catch (error) {
      const c = error?.cause || {};
      const key = `${c.code || error?.code || error?.name || "?"}`;
      stats[i].err++; stats[i].errs[key] = (stats[i].errs[key] || 0) + 1;
      stats[i].ms.push(Math.round(performance.now() - t0));
    }
  }
}

console.log(`\n每路 ${N} 次：`);
for (let i = 0; i < modes.length; i++) {
  const s = stats[i];
  const med = s.ms.slice().sort((a, b) => a - b)[Math.floor(s.ms.length / 2)];
  console.log(`  ${modes[i].name} 成功 ${s.ok}/${N}  中位耗时 ${med}ms  失败: ${JSON.stringify(s.errs)}`);
}
for (const m of modes) if (m.run.close) await m.run.close();
process.exit(0);
