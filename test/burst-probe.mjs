// 并发压力对照：同一条连接上并发打，看 h2 会不会被 Cloudflare 用
// NGHTTP2_ENHANCE_YOUR_CALM 掐掉；h1 作为对照。
//   node test/burst-probe.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const undici = require("/home/mqnu/.nvm/versions/node/v22.22.3/lib/node_modules/@deepseek-ai/dsh/node_modules/undici/index.js");

const URL_ = "https://opencode.ai/zen/go/v1/models";
const CONC = Number(process.argv[2] || 12);
const ROUNDS = Number(process.argv[3] || 3);

async function burst(tag, opts) {
  const agent = new undici.Agent({
    connect: { timeout: 30_000, family: 4 },
    allowH2: opts.allowH2,
    headersTimeout: 300_000, bodyTimeout: 0,
    keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000, pipelining: 1,
  });
  const errs = {};
  let ok = 0;
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = performance.now();
    const results = await Promise.allSettled(
      Array.from({ length: CONC }, () => undici.fetch(URL_, { dispatcher: agent, headers: { "user-agent": "burst-probe" } })
        .then(async (res) => { try { await res.body?.cancel?.(); } catch {} return res.status; })),
    );
    for (const x of results) {
      if (x.status === "fulfilled") ok++;
      else {
        const c = x.reason?.cause || {};
        const k = `${c.code || x.reason?.code || x.reason?.name}`;
        errs[k] = (errs[k] || 0) + 1;
      }
    }
    console.log(`  [${tag}] 第 ${r + 1} 轮 并发${CONC}: 成功 ${results.filter((x) => x.status === "fulfilled").length}  用时 ${Math.round(performance.now() - t0)}ms`);
  }
  console.log(`  [${tag}] 合计 成功 ${ok}/${CONC * ROUNDS} 失败 ${JSON.stringify(errs)}`);
  await agent.close();
}

await burst("h2 默认", { allowH2: true });
await burst("h1 强制", { allowH2: false });
process.exit(0);
