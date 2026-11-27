// Conveyor Courier's intake endpoint.
//
// Runs on Cloudflare Workers with a D1 binding, and unchanged on Node for local work
// (see local-server.mjs). The desk's rules live in ../courier-desk.js, so the Worker,
// the site's page and the tests all enforce the same ones.
//
// CORS is limited to the two demo origins. Business endpoints never send "*": only the
// public agentic files do, and those are served by the static host.
import { CourierDesk } from "../courier-desk.js";
import { D1Store } from "./d1-store.js";

/**
 * The origins allowed to call this intake, as exact origins with the port.
 */
export const ALLOWED_ORIGINS = [
  "http://localhost:8085",
  "http://127.0.0.1:8084",
];

/**
 * Handle one request to the desk.
 *
 * :param request: The incoming Request.
 * :param store: The store the desk uses.
 * :param now: An optional clock, for tests.
 * :return: A promise of the Response.
 */
export async function handle(request, store, now) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin") || "";
  const allowed = ALLOWED_ORIGINS.includes(origin);
  const headers = { "Content-Type": "application/json; charset=utf-8" };
  if (allowed) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
  }
  const send = (status, body) => new Response(JSON.stringify(body), { status, headers });

  if (request.method === "OPTIONS") {
    // A browser only preflights from an origin we serve; anything else gets no CORS
    // header, so the browser refuses it.
    return new Response(null, { status: allowed ? 204 : 403, headers });
  }
  if (origin && !allowed) {
    return send(403, { ok: false, reason: "This origin may not call the courier desk." });
  }

  const desk = new CourierDesk(store, now);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  try {
    if (request.method === "GET" && path === "/api/health") {
      return send(200, { ok: true, now: (now ? now() : new Date()).toISOString() });
    }
    if (request.method === "POST" && path === "/api/quote") {
      const body = await readJson(request);
      const quote = await desk.quote(body);
      return send(quote.ok ? 200 : 422, quote);
    }
    if (request.method === "POST" && path === "/api/dispatch/check") {
      // The read-only check the dispatch runs first. The window on this site calls it
      // before it shows a form, so a request the desk would refuse gets no form.
      const body = await readJson(request);
      const check = await desk.checkDispatch(body);
      if (!check.ok) {
        const status = check.code === "quote_expired" ? 410 : check.code === "quote_changed" || check.code === "quote_mismatch" ? 409 : 422;
        return send(status, check);
      }
      return send(200, {
        ok: true,
        quoteId: check.quote.quoteId,
        dropZone: check.quote.dropZone,
        parcelSize: check.quote.parcelSize,
        itemCount: check.quote.itemCount,
        feeCents: check.quote.feeCents,
        feeText: check.quote.feeText,
        etaMinutes: check.quote.etaMinutes,
        expiresAt: check.quote.expiresAt,
      });
    }
    if (request.method === "POST" && path === "/api/dispatch") {
      const body = await readJson(request);
      const details = {
        customerName: body.customerName,
        phone: body.phone,
        address: body.address,
        note: body.note,
      };
      const result = await desk.dispatch(body, details);
      if (result.ok) {
        return send(result.replayed ? 200 : 201, result);
      }
      const status = result.code === "quote_expired" ? 410 : result.code === "quote_changed" || result.code === "quote_mismatch" || result.code === "idempotency_conflict" ? 409 : 422;
      return send(status, result);
    }
    if (request.method === "GET" && path === "/api/dispatch/outcome") {
      // The read that settles an unknown dispatch. It records nothing: the caller lost
      // the answer to a write and asks whether it landed, by the same idempotency key.
      const result = await desk.outcome(url.searchParams.get("key"));
      return send(result.ok ? 200 : 422, result);
    }
    if (request.method === "GET" && path === "/api/jobs") {
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
      const jobs = await store.listJobs(limit);
      return send(200, { ok: true, jobs: jobs.map(CourierDesk.receipt) });
    }
    const jobMatch = /^\/api\/jobs\/([^/]+)$/.exec(path);
    if (request.method === "GET" && jobMatch) {
      const result = await desk.jobStatus(decodeURIComponent(jobMatch[1]));
      return send(result.ok ? 200 : 404, result);
    }
    const cancelMatch = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(path);
    if (request.method === "POST" && cancelMatch) {
      const body = await readJson(request);
      const result = await desk.cancel(decodeURIComponent(cancelMatch[1]), body.expectedStatus);
      return send(result.ok ? 200 : result.field === "jobId" && result.reason.startsWith("No job") ? 404 : 409, result);
    }
    const advanceMatch = /^\/api\/jobs\/([^/]+)\/advance$/.exec(path);
    if (request.method === "POST" && advanceMatch) {
      const body = await readJson(request);
      const result = await desk.advance(decodeURIComponent(advanceMatch[1]), body.status);
      return send(result.ok ? 200 : 409, result);
    }
    return send(404, { ok: false, reason: "No such endpoint on the courier desk." });
  } catch (error) {
    // An unexpected failure must not look like a refusal: the caller reports it as an
    // unknown outcome and checks the job instead of writing again.
    return send(500, { ok: false, reason: "The desk could not complete that call.", detail: String(error && error.message || error) });
  }
}

/**
 * Read a JSON body, refusing anything that is not an object.
 *
 * :param request: The incoming Request.
 * :return: A promise of the parsed object.
 * :raises Error: When the body is not a JSON object.
 */
async function readJson(request) {
  const text = await request.text();
  let body;
  try {
    body = JSON.parse(text || "{}");
  } catch {
    throw new Error("The request body is not JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("The request body must be a JSON object.");
  }
  return body;
}

/**
 * The Workers entry point.
 */
export default {
  /**
   * :param request: The incoming Request.
   * :param env: The bindings, with DB.
   * :return: A promise of the Response.
   */
  async fetch(request, env) {
    return handle(request, new D1Store(env.DB));
  },
};
