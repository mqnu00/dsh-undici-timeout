// 真流式（SSE）对照：h2 默认 vs 强制 h1，含「读一半就 abort」（模拟 DSH 的重试/看门狗取消）。
// 目的：确认 Cloudflare 的 NGHTTP2_ENHANCE_YOUR_CALM 是否 h2 专属。
//   node test/sse-probe.mjs [每路轮数]
// 注意：会真的打 LLM 端点（max_tokens 很小），消耗可忽略。
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const undici = require("/home/mqnu/.nvm/versions/node/v22.22.3/lib/node_modules/@deepseek-ai/dsh/node_modules/undici/index.js");

const credPath = `${process.env.HOME}/.dsh/.credentials.yaml`;
const key = /OPENCODE_GO_API_KEY:\s*(\S+)/.exec(fs.readFileSync(credPath, "utf8"))?.[1];
if (!key) { console.error("拿不到 OPENCODE_GO_API_KEY"); process.exit(1); }
const URL_ = "https://opencode.ai/zen/go/v1/chat/completions";
const N = Number(process.argv[2] || 5);

async function one(agent, abortAfterChunks) {
  const ac = new AbortController();
  const t0 = performance.now();
  try {
    const res = await undici.fetch(URL_, {
      dispatcher: agent, method: "POST", signal: ac.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        "user-agent": "sse-probe",
        // 网关要求：缺这个头直接 400 MissingSessionID
        "x-opencode-session": `sse-probe-${process.pid}`,
      },
      body: JSON.stringify({ model: "deepseek-v4.1-flash", stream: true, max_tokens: 8, messages: [{ role: "user", content: "say hi" }] }),
    });
    let chunks = 0;
    for await (const c of res.body) {
      chunks++;
      if (abortAfterChunks && chunks >= 2) { ac.abort(); break; }
    }
    return { ms: Math.round(performance.now() - t0), status: res.status, chunks, aborted: Boolean(abortAfterChunks) };
  } catch (error) {
    const c = error?.cause || {};
    return { ms: Math.round(performance.now() - t0), status: null, err: `${error?.name}/${c.code || error?.code || ""}`, msg: String(c.message || error?.message || "").slice(0, 90) };
  }
}

async function run(tag, allowH2) {
  const agent = new undici.Agent({
    connect: { timeout: 30_000, family: 4 }, allowH2,
    headersTimeout: 300_000, bodyTimeout: 0, keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000, pipelining: 1,
  });
  console.log(`\n[${tag}]`);
  const errs = {};
  for (let i = 0; i < N; i++) {
    const abort = i % 2 === 1;
    const r = await one(agent, abort);
    if (r.err) { errs[r.msg.slice(0, 60)] = (errs[r.msg.slice(0, 60)] || 0) + 1; }
    console.log(`  #${i + 1}${abort ? "(中途abort)" : "          "} ${r.status ?? "-"} ${r.ms}ms ${r.chunks ? `chunks=${r.chunks}` : ""} ${r.err || ""} ${r.msg || ""}`);
  }
  console.log(`  [${tag}] 错误: ${JSON.stringify(errs)}`);
  await agent.close();
}

await run("h2 默认", true);
await run("h1 强制", false);
process.exit(0);
