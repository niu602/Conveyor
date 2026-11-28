// Run the courier desk on this machine, with the same handler the Worker uses.
//
// The store is mirrored to a JSON file, so a job is still on the desk after a restart or a
// hard kill. The Worker itself is untouched: it uses D1. Pass --port 0 to take any free
// port, which the restart test does; the bound port is printed below.
//
//   node courier-site/worker/local-server.mjs --port 8086
//   node courier-site/worker/local-server.mjs --port 0 --data D:/tmp/desk.json
//
// --drill arms a one-shot fault on the next POST /api/dispatch, for the failure drills:
//   drop-response  record the job, then close the socket without answering
//   reject-write   close the socket before handling, so nothing is recorded
//   fail-write     answer 503 before handling, so nothing is recorded
// All three are real server-side faults, not a stubbed client. Development only: the
// Worker has no such flag.
//
// reject-write alone does not reliably produce "nothing recorded" in a browser: Chrome
// re-sends a POST whose reused keep-alive socket was reset before any response byte, so
// the one-shot fault is spent on the first try and the transparent retry lands the job.
// fail-write answers with a real status instead, which the browser does not retry, and
// the desk client still cannot tell whether the write landed — it throws `unknown`.
// Use fail-write for the absent branch and reject-write only to show that retry.
//
// /llm-proxy is a development-only LLM reverse proxy on this same port (see
// llm-proxy.mjs). It is routed before the desk handler and shares nothing with it.
// Set ZHIPU_API_KEY in the environment to let the proxy hold the provider key.
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { handle } from "./index.js";
import { FileStore } from "./file-store.mjs";
import { isLlmProxyPath, handleLlmProxy } from "./llm-proxy.mjs";
import { signerFromEnv } from "./receipt-signer.mjs";
import { seedDemoJob } from "../demo-job.js";

const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 8086;
const dataIndex = args.indexOf("--data");
// Kept under .local/, which .gitignore already excludes: the desk holds visitor details.
const dataFile = dataIndex >= 0 ? args[dataIndex + 1] : fileURLToPath(new URL("../.local/desk.json", import.meta.url));
const drillIndex = args.indexOf("--drill");
const drill = drillIndex >= 0 ? args[drillIndex + 1] : "";
let armed = drill === "drop-response" || drill === "reject-write" || drill === "fail-write";
const store = await FileStore.open(dataFile);
await seedDemoJob(store);
// Plan b: the signing key is read from the environment at startup and never written down.
const signer = await signerFromEnv(process.env);

const server = createServer(async (req, res) => {
  const path = String(req.url || "").split("?")[0].replace(/\/+$/, "");
  // Development LLM proxy: a different concern on the same port, handled before the
  // desk sees anything. It never reaches handle(), and the Worker has no such route.
  if (isLlmProxyPath(path)) {
    handleLlmProxy(req, res);
    return;
  }
  // One shot: the mode is taken off the shelf for this request only.
  let mode = "";
  if (armed && req.method === "POST" && path === "/api/dispatch") {
    mode = drill;
    armed = false;
  }
  if (mode === "reject-write") {
    console.log("DRILL reject-write: closing the socket before handling; nothing recorded.");
    req.socket.destroy();
    return;
  }
  if (mode === "fail-write") {
    // Nothing is recorded and the browser gets a real status, so it does not re-send.
    console.log("DRILL fail-write: answered 503 before handling; nothing recorded.");
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, reason: "The desk's intake is unavailable." }));
    return;
  }
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const request = new Request(`http://localhost:${port}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
  });
  const response = await handle(request, store, undefined, signer);
  const text = await response.text();
  if (mode === "drop-response") {
    // Whatever the desk decided is already recorded and flushed. The answer never arrives.
    console.log(`DRILL drop-response: desk answered ${response.status}, closing the socket without sending it.`);
    req.socket.destroy();
    return;
  }
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(text);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Courier desk (local, file-backed) on http://127.0.0.1:${server.address().port}`);
  console.log(`Data: ${dataFile}`);
  if (drill) {
    console.log(`Drill armed: ${drill} (one shot, on the next POST /api/dispatch)`);
  }
  console.log("Endpoints: POST /api/quote, POST /api/dispatch/check, POST /api/dispatch,");
  console.log("           GET /api/dispatch/outcome?key=..., GET /api/jobs, GET /api/jobs/:id,");
  console.log("           POST /api/jobs/:id/cancel, POST /api/jobs/:id/advance, GET /api/health");
  console.log(`Dev LLM proxy: POST /llm-proxy/chat/completions (server key ${process.env.ZHIPU_API_KEY ? "present" : "absent"})`);
  console.log(`Receipt signing: ${signer ? `on, kid ${signer.kid}` : "off (no RECEIPT_PRIVATE_KEY)"}`);
  console.log("Public keys: GET /api/pubkey");
});
