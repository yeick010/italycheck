#!/usr/bin/env node
// Usage: node --experimental-vm-modules eval-split.mjs <bundle.js>
// Splits module cost into compile (parse) vs top-level evaluation, for wrangler's single-module output.
import vm from "node:vm"; import { readFileSync } from "node:fs";
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
await new Response(new Request("https://x.invalid/", { method: "POST", body: "{}" }).body).text(); new Headers({a:"b"}); structuredClone({}); new URL("https://x/"); await crypto.subtle.digest("SHA-256", new Uint8Array(1));
const src = readFileSync(process.argv[2], "utf8");
const ctx = vm.createContext(globalThis);
let t = cpu(); const m = new vm.SourceTextModule(src, { context: ctx }); const compile = cpu() - t;
await m.link(async spec => { const ns = await import(spec.replace(/^(?!node:|cloudflare:)/, "node:")); const s = new vm.SyntheticModule(Object.keys(ns), function () { for (const k of Object.keys(ns)) this.setExport(k, ns[k]); }, { context: ctx }); return s; });
t = cpu(); await m.evaluate(); const evaluate = cpu() - t;
console.log(JSON.stringify({ compile_ms: +compile.toFixed(1), evaluate_ms: +evaluate.toFixed(1) }));
