// Development-only LLM reverse proxy. NOT part of the production desk.
//
// The desk's own handler never sees these requests: local-server.mjs routes the
// /llm-proxy prefix here before it builds a desk Request. Nothing in index.js, the
// Worker, or the runtime is touched, so the M4 extraction stays clean. Same discipline
// as --drill: a local convenience with no production counterpart.
//
// Why it exists: a browser cannot call open.bigmodel.cn directly. The preflight fails
// (405 / no Access-Control-Allow-Origin), so the page never gets to send the request.
// This proxy answers the preflight itself and forwards the POST.
//
// It is also the local equivalent of the official publisher_funded shape — a
// key-holding proxy owned by the site. In M3 this becomes its own Worker with the key
// in `wrangler secret`, and the manifest points at it. Nothing else changes.
//
// Key handling, same rule as the receipt signing key:
//   - a visitor's own Authorization header is passed through untouched;
//   - the placeholder token `env` (or no header at all) means "use the server's key";
//   - the server's key is read from the environment at startup and never written to
//     disk, to the repo, or to any log line.
//
//   ZHIPU_API_KEY=... node courier-site/worker/local-server.mjs --port 8086
//
// Streaming is piped straight through, never buffered: the runtime always sends
// stream:true and reads SSE incrementally, so buffering here would stall the UI.
import { request as httpsRequest } from "node:https";

const UPSTREAM = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const PREFIX = "/llm-proxy";

// Deliberately separate from the desk's own CORS list. The desk only ever needs
// Content-Type; this route carries a Bearer token, which forces a preflight, so
// Authorization must be allowed explicitly or the browser blocks the call.
const ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:8084",
  "http://127.0.0.1:8085",
  "http://localhost:8084",
  "http://localhost:8085",
]);

// The runtime refuses to send an empty key, so the settings panel needs something in
// the field. This token means "the proxy holds the real key".
const ENV_TOKENS = new Set(["env", "use-env", "proxy"]);

export function isLlmProxyPath(path) {
  return path === PREFIX || path.startsWith(`${PREFIX}/`);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function json(res, status, payload, headers) {
  res.writeHead(status, { ...headers, "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

// A visitor's real key wins; the placeholder falls back to the server's.
function chooseKey(authorization, serverKey) {
  const raw = String(authorization || "").trim();
  const token = raw.replace(/^Bearer\s+/i, "").trim();
  if (token && !ENV_TOKENS.has(token.toLowerCase())) return { key: token, source: "visitor" };
  if (serverKey) return { key: serverKey, source: "server" };
  return { key: "", source: "none" };
}

export function handleLlmProxy(req, res, { serverKey = process.env.ZHIPU_API_KEY || "" } = {}) {
  const origin = String(req.headers.origin || "");
  // No wildcard: an unknown origin gets no CORS headers at all, so the browser blocks it.
  if (!ALLOWED_ORIGINS.has(origin)) {
    json(res, 403, { error: { message: "This origin may not use the development LLM proxy." } }, {});
    return;
  }
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.method !== "POST") {
    json(res, 405, { error: { message: "Use POST." } }, cors);
    return;
  }

  const { key, source } = chooseKey(req.headers.authorization, serverKey);
  if (!key) {
    json(res, 500, { error: { message: "The proxy has no provider key. Start the desk with ZHIPU_API_KEY set, or paste your own key in the settings panel." } }, cors);
    return;
  }

  // The provider rejects overlapping calls on this key with an instant 1305, and a
  // cross-site turn does fire two at once (the pizza agent and the courier agent it
  // runs locally). Queueing them costs latency but not correctness: each call is
  // independent, so nothing waits on another to finish. No request is altered and
  // nothing is retried — a refusal is passed straight back to the page.
  const run = () => forward(req, res, cors, key, source);
  queue = queue.then(run, run);
}

// One upstream call at a time. The request body is left untouched in the socket until
// its turn comes; nothing is buffered here.
let queue = Promise.resolve();
let lastFinished = 0;

// Even serialised, calls fired back to back draw an instant 1305 from this key. A
// minimum gap between them is pacing, not retrying: a refusal is still returned to the
// page as it stands, and no request is ever sent twice.
// Tunable without touching code: LLM_PROXY_MIN_GAP_MS=12000 node ... local-server.mjs
const MIN_GAP_MS = Number(process.env.LLM_PROXY_MIN_GAP_MS || 8000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function forward(req, res, cors, key, source) {
  const gap = MIN_GAP_MS - (Date.now() - lastFinished);
  if (lastFinished && gap > 0) await sleep(gap);
  return send(req, res, cors, key, source);
}

function send(req, res, cors, key, source) {
  return new Promise((done) => {
    const started = Date.now();
    const upstreamReq = httpsRequest(
      UPSTREAM,
      {
        method: "POST",
        headers: {
          "Content-Type": req.headers["content-type"] || "application/json",
          Accept: req.headers.accept || "text/event-stream",
          Authorization: `Bearer ${key}`,
          // Keep the body uncompressed so SSE reaches the browser as it is produced.
          "Accept-Encoding": "identity",
        },
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode || 502;
        console.log(`LLM proxy: <- ${status} after ${Date.now() - started}ms`);
        res.writeHead(status, {
          ...cors,
          "Content-Type": upstreamRes.headers["content-type"] || "application/json",
          "Cache-Control": "no-cache",
        });
        res.flushHeaders?.();
        upstreamRes.pipe(res);
      },
    );

    upstreamReq.on("error", (err) => {
      // The message can carry the URL, never the key: the key is only in a header.
      console.log(`LLM proxy upstream error: ${err.code || err.message}`);
      if (!res.headersSent) json(res, 502, { error: { message: `Upstream unreachable: ${err.code || "error"}` } }, cors);
      else res.end();
    });

    // A visitor who navigates away must not leave the upstream call running.
    res.on("close", () => {
      upstreamReq.destroy();
      lastFinished = Date.now();
      done();
    });

    const bytes = req.headers["content-length"] || "?";
    console.log(`LLM proxy ${new Date().toISOString()}: POST ${bytes}B -> bigmodel (key: ${source})`);
    req.pipe(upstreamReq);
  });
}