// Checks the desk's intake: the one place a cross-site dispatch lands.
// Run: node --test "D:/Conveyor/courier-site/tests/*.test.mjs"
//
// These call the Worker's own handler with Request objects, on an in-memory store with
// the same shape as D1. No server and no network are involved.
import assert from "node:assert/strict";
import test from "node:test";
import { handle, ALLOWED_ORIGINS } from "../worker/index.js";
import { MemoryStore } from "../courier-desk.js";
import { D1Store } from "../worker/d1-store.js";
import { CourierData } from "../courier-data.js";

const CALLER = "http://127.0.0.1:8084";
const DESK = "http://localhost:8085";
const NOW = "2026-11-25T18:30:00.000Z";

/**
 * Send one call to the desk's handler.
 *
 * :param store: The store the desk uses.
 * :param method: The HTTP method.
 * :param path: The endpoint's path.
 * :param body: The JSON body, or null.
 * :param origin: The calling page's origin.
 * :param clock: A fixed clock, as an ISO string.
 * :return: A promise of the status, the body and the CORS header.
 */
async function send(store, method, path, body, origin = CALLER, clock = NOW) {
  const request = new Request(`http://localhost:8086${path}`, {
    method,
    headers: origin === null ? { "Content-Type": "application/json" } : { "Content-Type": "application/json", Origin: origin },
    body: body === null ? undefined : JSON.stringify(body),
  });
  const response = await handle(request, store, () => new Date(clock));
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    acao: response.headers.get("Access-Control-Allow-Origin"),
  };
}

/**
 * Make a quote on the desk.
 *
 * :param store: The store.
 * :param request: The parcel to quote.
 * :param clock: A fixed clock.
 * :return: A promise of the quote.
 */
async function quote(store, request, clock = NOW) {
  const answer = await send(store, "POST", "/api/quote", request, CALLER, clock);
  assert.equal(answer.body.ok, true, answer.body.reason);
  return answer.body;
}

/**
 * The dispatch facts for a quote.
 *
 * :param held: The quote.
 * :param key: The idempotency key.
 * :return: The body a caller sends.
 */
function dispatchBody(held, key) {
  return {
    quoteId: held.quoteId,
    expectedFeeCents: held.feeCents,
    dropZone: held.dropZone,
    parcelSize: held.parcelSize,
    itemCount: held.itemCount,
    itemSummary: "2x Margherita",
    pizzaOrderRef: "LO-77",
    idempotencyKey: key,
    customerName: "  Sam Lee  ",
    phone: "+1 555 0100",
    address: "  12 Harbor Rd  ",
    note: "Ring twice",
  };
}

test("the intake answers only the origins it serves", async () => {
  const store = new MemoryStore();
  assert.deepEqual(ALLOWED_ORIGINS, [DESK, CALLER]);
  for (const origin of ALLOWED_ORIGINS) {
    const answer = await send(store, "POST", "/api/quote", { dropZone: "harbor", parcelSize: "small", itemCount: 1 }, origin);
    assert.equal(answer.status, 200);
    assert.equal(answer.acao, origin, "An allowed origin must get its own origin back, never *.");
  }
  const stranger = await send(store, "POST", "/api/quote", { dropZone: "harbor", parcelSize: "small", itemCount: 1 }, "http://evil.example");
  assert.equal(stranger.status, 403);
  assert.equal(stranger.acao, null, "A refused origin must get no CORS header.");
  const preflight = await send(store, "OPTIONS", "/api/dispatch", null, "http://evil.example");
  assert.equal(preflight.status, 403);
  assert.equal(preflight.acao, null);
  const allowedPreflight = await send(store, "OPTIONS", "/api/dispatch", null, CALLER);
  assert.equal(allowedPreflight.status, 204);
  assert.equal(allowedPreflight.acao, CALLER);
});

test("a quote prices the parcel and holds it for fifteen minutes", async () => {
  const store = new MemoryStore();
  const held = await quote(store, { dropZone: "north", parcelSize: "medium", itemCount: 3 });
  assert.equal(held.feeCents, 700);
  assert.equal(held.feeText, "$7.00");
  assert.equal(held.etaMinutes, 22);
  assert.equal(held.expiresAt, "2026-11-25T18:45:00.000Z");
  const refused = await send(store, "POST", "/api/quote", { dropZone: "outside", parcelSize: "small", itemCount: 1 });
  assert.equal(refused.status, 422);
  assert.equal(refused.body.ok, false);
});

test("the same idempotency key lands one job, however often it is sent", async () => {
  const store = new MemoryStore();
  const held = await quote(store, { dropZone: "north", parcelSize: "medium", itemCount: 3 });
  const body = dispatchBody(held, "key-once");
  const first = await send(store, "POST", "/api/dispatch", body);
  assert.equal(first.status, 201);
  assert.equal(first.body.replayed, false);
  // A retry, and a retry with different details, must both return the first job.
  for (const attempt of [body, { ...body, customerName: "Someone Else", address: "9 Other Road" }]) {
    const again = await send(store, "POST", "/api/dispatch", attempt);
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.jobId, first.body.jobId);
    assert.equal(again.body.feeCents, first.body.feeCents);
  }
  const jobs = await store.listJobs(50);
  assert.equal(jobs.length, 1, "A replay made a second job.");
  assert.equal(jobs[0].customerName, "Sam Lee", "A replay overwrote the first visitor's details.");
  // A different key is a different run, even on the same quote.
  const other = await send(store, "POST", "/api/dispatch", { ...body, idempotencyKey: "key-twice" });
  assert.equal(other.status, 201);
  assert.notEqual(other.body.jobId, first.body.jobId);
});

test("the same key with a different amount is refused, not answered with the first job", async () => {
  const store = new MemoryStore();
  const held = await quote(store, { dropZone: "north", parcelSize: "medium", itemCount: 3 });
  const body = dispatchBody(held, "key-amount");
  const first = await send(store, "POST", "/api/dispatch", body);
  assert.equal(first.status, 201);

  // The fee is not in the key, so this reaches the same row. It must be an explicit error:
  // silently returning the first job would hide that the caller asked for another amount.
  const conflict = await send(store, "POST", "/api/dispatch", { ...body, expectedFeeCents: held.feeCents + 200 });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.ok, false);
  assert.equal(conflict.body.code, "idempotency_conflict");
  assert.equal(conflict.body.jobId, first.body.jobId);
  assert.equal(conflict.body.recordedFeeCents, held.feeCents);
  assert.match(conflict.body.reason, /\$7\.00/);

  const jobs = await store.listJobs(50);
  assert.equal(jobs.length, 1, "A conflicting replay made a second job.");
  assert.equal(jobs[0].feeCents, held.feeCents, "A conflicting replay changed what was accepted.");
  // The original transaction is still replayable, unchanged.
  const again = await send(store, "POST", "/api/dispatch", body);
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.jobId, first.body.jobId);
});

test("the same key with a different parcel is refused, and a different recipient is not", async () => {
  const store = new MemoryStore();
  const held = await quote(store, { dropZone: "north", parcelSize: "medium", itemCount: 3 });
  const body = dispatchBody(held, "key-parcel");
  const first = await send(store, "POST", "/api/dispatch", body);

  for (const change of [{ itemCount: 4 }, { dropZone: "harbor" }, { parcelSize: "small" }, { pizzaOrderRef: "LO-88" }]) {
    const answer = await send(store, "POST", "/api/dispatch", { ...body, ...change });
    assert.equal(answer.status, 409, JSON.stringify(change));
    assert.equal(answer.body.code, "idempotency_conflict");
  }
  // Who receives the parcel is not what was bought: a corrected name or address replays.
  const corrected = await send(store, "POST", "/api/dispatch", { ...body, customerName: "Other Person", phone: "+1 555 0199", address: "9 Other Road", note: "" });
  assert.equal(corrected.status, 200);
  assert.equal(corrected.body.replayed, true);
  assert.equal((await store.getJob(first.body.jobId)).customerName, "Sam Lee", "A replay overwrote the first recipient.");
  assert.equal((await store.listJobs(50)).length, 1);
});

test("the job keeps the digest of the transaction it accepted", async () => {
  const store = new MemoryStore();
  const held = await quote(store, { dropZone: "harbor", parcelSize: "small", itemCount: 2 });
  const body = dispatchBody(held, "key-digest");
  const answer = await send(store, "POST", "/api/dispatch", body);
  const stored = await store.getJob(answer.body.jobId);
  assert.equal(stored.requestDigest, [held.quoteId, "LO-77", "harbor", "small", "2", String(held.feeCents)].join("|"));
  // The digest is the desk's own bookkeeping: it is not in the receipt the chat gets.
  assert.equal(Object.hasOwn(answer.body, "requestDigest"), false);
  assert.equal(JSON.stringify(answer.body).includes("LO-77|"), false);

  // A row written before the digest existed is still compared, from the fields it holds.
  const legacy = { ...stored, requestDigest: "" };
  store.jobs.set(legacy.jobId, legacy);
  const conflict = await send(store, "POST", "/api/dispatch", { ...body, expectedFeeCents: 1 });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "idempotency_conflict");
});

test("an unknown dispatch is settled by reading its key, and the read records nothing", async () => {
  const store = new MemoryStore();
  const held = await quote(store, { dropZone: "north", parcelSize: "small", itemCount: 2 });
  const body = dispatchBody(held, "key-settle");

  // Before the write: the key names nothing, and asking does not create it.
  const before = await send(store, "GET", "/api/dispatch/outcome?key=key-settle", null);
  assert.equal(before.status, 200);
  assert.deepEqual(before.body, { ok: true, recorded: false });
  assert.equal((await store.listJobs(50)).length, 0, "The outcome read created a job.");

  const written = await send(store, "POST", "/api/dispatch", body);
  assert.equal(written.status, 201);
  const jobsAfterWrite = await store.listJobs(50);
  const eventsAfterWrite = await store.listEvents(written.body.jobId);

  // After the write: the same read settles it as recorded, with the same receipt.
  const after = await send(store, "GET", "/api/dispatch/outcome?key=key-settle", null);
  assert.equal(after.status, 200);
  assert.equal(after.body.ok, true);
  assert.equal(after.body.recorded, true);
  assert.equal(after.body.jobId, written.body.jobId);
  assert.equal(after.body.feeCents, held.feeCents);
  assert.equal(after.body.status, "assigned");
  assert.deepEqual(after.body.events, eventsAfterWrite);

  // Reading it again, and reading it many times, changes nothing at all.
  for (let i = 0; i < 3; i += 1) {
    await send(store, "GET", "/api/dispatch/outcome?key=key-settle", null);
  }
  assert.deepEqual(await store.listJobs(50), jobsAfterWrite, "The outcome read changed the jobs.");
  assert.deepEqual(await store.listEvents(written.body.jobId), eventsAfterWrite, "The outcome read added an event.");
});

test("settling by key leaves one job, and a replay after it still returns that job", async () => {
  const store = new MemoryStore();
  const held = await quote(store, { dropZone: "harbor", parcelSize: "small", itemCount: 1 });
  const body = dispatchBody(held, "key-replay-after-read");
  const first = await send(store, "POST", "/api/dispatch", body);
  const settled = await send(store, "GET", "/api/dispatch/outcome?key=key-replay-after-read", null);
  assert.equal(settled.body.jobId, first.body.jobId);

  // A caller that lost the answer and then sends again anyway must not get a second run.
  const again = await send(store, "POST", "/api/dispatch", body);
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.jobId, first.body.jobId);
  assert.equal((await store.listJobs(50)).length, 1, "A replay after the read made a second job.");
});

test("the outcome read needs a key, serves only its callers and carries no details", async () => {
  const store = new MemoryStore();
  const held = await quote(store, { dropZone: "north", parcelSize: "small", itemCount: 2 });
  const written = await send(store, "POST", "/api/dispatch", dispatchBody(held, "key-private"));

  for (const path of ["/api/dispatch/outcome", "/api/dispatch/outcome?key=", "/api/dispatch/outcome?key=%20%20"]) {
    const missing = await send(store, "GET", path, null);
    assert.equal(missing.status, 422, `${path} should refuse a missing key.`);
    assert.equal(missing.body.field, "idempotencyKey");
  }

  const stranger = await send(store, "GET", "/api/dispatch/outcome?key=key-private", null, "http://evil.example");
  assert.equal(stranger.status, 403);
  assert.equal(stranger.acao, null);

  const answer = await send(store, "GET", "/api/dispatch/outcome?key=key-private", null);
  const text = JSON.stringify(answer.body);
  for (const value of ["Sam", "Lee", "555 0100", "Harbor Rd", "Ring twice"]) {
    assert.equal(text.includes(value), false, `The outcome read leaked "${value}".`);
  }
  assert.equal(answer.body.jobId, written.body.jobId);

  // A key nothing was sent with is an answer, not an error: nothing was recorded.
  const unused = await send(store, "GET", "/api/dispatch/outcome?key=never-sent", null);
  assert.equal(unused.status, 200);
  assert.deepEqual(unused.body, { ok: true, recorded: false });
});

test("two writers racing on one key still leave one job", async () => {
  const store = new MemoryStore();
  const held = await quote(store, { dropZone: "harbor", parcelSize: "small", itemCount: 2 });
  const body = dispatchBody(held, "key-race");
  const [a, b] = await Promise.all([
    send(store, "POST", "/api/dispatch", body),
    send(store, "POST", "/api/dispatch", body),
  ]);
  assert.equal(a.body.jobId, b.body.jobId);
  assert.equal((await store.listJobs(50)).length, 1);
  assert.equal([a, b].filter((answer) => answer.status === 201).length, 1, "Both writers claimed a new job.");
});

test("the read-only check refuses what the dispatch would refuse, and records nothing", async () => {
  const store = new MemoryStore();
  const held = await quote(store, { dropZone: "north", parcelSize: "medium", itemCount: 3 });
  const body = dispatchBody(held, "key-check");
  const good = await send(store, "POST", "/api/dispatch/check", body);
  assert.equal(good.status, 200);
  assert.equal(good.body.feeCents, 700);
  assert.equal(good.body.expiresAt, held.expiresAt);
  // The check must not accept the run.
  assert.deepEqual(await store.listJobs(50), []);

  const wrongFee = await send(store, "POST", "/api/dispatch/check", { ...body, expectedFeeCents: 100 });
  assert.equal(wrongFee.status, 409);
  assert.equal(wrongFee.body.code, "quote_changed");
  assert.equal(wrongFee.body.currentFeeCents, 700);

  const wrongParcel = await send(store, "POST", "/api/dispatch/check", { ...body, itemCount: 4 });
  assert.equal(wrongParcel.status, 409);
  assert.equal(wrongParcel.body.code, "quote_mismatch");

  const missing = await send(store, "POST", "/api/dispatch/check", { ...body, quoteId: "Q-NOPE" });
  assert.equal(missing.status, 422);
  assert.equal(missing.body.code, "quote_missing");

  // One minute past the quote's life.
  const late = await send(store, "POST", "/api/dispatch/check", body, CALLER, "2026-11-25T18:45:00.000Z");
  assert.equal(late.status, 410);
  assert.equal(late.body.code, "quote_expired");
  assert.deepEqual(await store.listJobs(50), []);
});

test("the dispatch refuses a changed fee, an expired quote and bad details", async () => {
  const store = new MemoryStore();
  const held = await quote(store, { dropZone: "north", parcelSize: "medium", itemCount: 3 });
  const body = dispatchBody(held, "key-refusals");
  const cases = [
    [{ ...body, expectedFeeCents: 1 }, 409, "quote_changed"],
    [{ ...body, parcelSize: "large" }, 409, "quote_mismatch"],
    [{ ...body, quoteId: "Q-NOPE" }, 422, "quote_missing"],
    [{ ...body, idempotencyKey: "" }, 422, undefined],
    [{ ...body, phone: "555" }, 422, undefined],
    [{ ...body, customerName: "   " }, 422, undefined],
    [{ ...body, address: "" }, 422, undefined],
  ];
  for (const [attempt, status, code] of cases) {
    const answer = await send(store, "POST", "/api/dispatch", attempt);
    assert.equal(answer.status, status, JSON.stringify(attempt));
    assert.equal(answer.body.ok, false);
    if (code) {
      assert.equal(answer.body.code, code);
    }
  }
  const late = await send(store, "POST", "/api/dispatch", body, CALLER, "2026-11-25T18:46:00.000Z");
  assert.equal(late.status, 410);
  assert.equal(late.body.code, "quote_expired");
  assert.deepEqual(await store.listJobs(50), [], "A refused dispatch left a job behind.");
});

test("a job receipt carries no name, phone, address or note", async () => {
  const store = new MemoryStore();
  const held = await quote(store, { dropZone: "old_town", parcelSize: "large", itemCount: 5 });
  const answer = await send(store, "POST", "/api/dispatch", dispatchBody(held, "key-private"));
  const read = await send(store, "GET", `/api/jobs/${answer.body.jobId}`, null);
  const list = await send(store, "GET", "/api/jobs?limit=20", null);
  const haystack = JSON.stringify([answer.body, read.body, list.body]);
  for (const secret of ["Sam Lee", "555 0100", "12 Harbor Rd", "Ring twice"]) {
    assert.ok(!haystack.includes(secret), `The intake returned "${secret}".`);
  }
  // The desk itself keeps them, trimmed, so the courier can make the run.
  const stored = await store.getJob(answer.body.jobId);
  assert.equal(stored.customerName, "Sam Lee");
  assert.equal(stored.address, "12 Harbor Rd");
  assert.equal(stored.note, "Ring twice");
  assert.equal(read.body.events[0].type, "assigned");
});

test("a job moves forward one step and cancels only before pickup", async () => {
  const store = new MemoryStore();
  const held = await quote(store, { dropZone: "harbor", parcelSize: "small", itemCount: 2 });
  const job = (await send(store, "POST", "/api/dispatch", dispatchBody(held, "key-steps"))).body;
  const skip = await send(store, "POST", `/api/jobs/${job.jobId}/advance`, { status: "delivered" });
  assert.equal(skip.status, 409);
  const picked = await send(store, "POST", `/api/jobs/${job.jobId}/advance`, { status: "picked_up" });
  assert.equal(picked.status, 200);
  assert.equal(picked.body.status, "picked_up");
  const tooLate = await send(store, "POST", `/api/jobs/${job.jobId}/cancel`, { expectedStatus: "picked_up" });
  assert.equal(tooLate.status, 409);
  assert.match(tooLate.body.reason, /can no longer be cancelled/);
  const stale = await send(store, "POST", `/api/jobs/${job.jobId}/cancel`, { expectedStatus: "assigned" });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.field, "expectedStatus");
  const delivered = await send(store, "POST", `/api/jobs/${job.jobId}/advance`, { status: "delivered" });
  assert.equal(delivered.body.status, "delivered");
  const unknown = await send(store, "GET", "/api/jobs/J-NOPE", null);
  assert.equal(unknown.status, 404);
});

test("the D1 store enforces the key with the same shape as the memory store", async () => {
  // A stand-in for D1 that keeps rows and honours the UNIQUE index on idempotency_key.
  const rows = new Map();
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              return D1Fake.first(sql, values, rows);
            },
            async all() {
              return { results: D1Fake.all(sql, values, rows) };
            },
            async run() {
              D1Fake.run(sql, values, rows);
              return { success: true };
            },
          };
        },
      };
    },
    async batch(statements) {
      for (const statement of statements) {
        await statement.run();
      }
      return [];
    },
  };
  const store = new D1Store(db);
  const job = {
    jobId: "J-1", quoteId: "Q-1", idempotencyKey: "same", pizzaOrderRef: "", itemSummary: "",
    dropZone: "harbor", parcelSize: "small", itemCount: 2, customerName: "A", phone: "555-0100",
    address: "1 Road", note: "", feeCents: 300, etaMinutes: 14, status: "assigned",
    createdAt: NOW, updatedAt: NOW,
  };
  const first = await store.putJob(job);
  const second = await store.putJob({ ...job, jobId: "J-2", customerName: "B" });
  assert.equal(first.jobId, "J-1");
  assert.equal(second.jobId, "J-1", "The D1 store let a second job through on the same key.");
  assert.equal((await store.getJobByKey("same")).customerName, "A");
  assert.equal(await store.getJob("J-2"), null);
});

/**
 * A tiny stand-in for the D1 statements the store uses, so the SQL's intent is checked
 * without a Cloudflare account. It is not a SQL engine: it answers the exact statements
 * d1-store.js makes.
 */
class D1Fake {
  /**
   * Read one row.
   *
   * :param sql: The statement.
   * :param values: The bound values.
   * :param rows: The kept jobs, by id.
   * :return: The row, or null.
   */
  static first(sql, values, rows) {
    if (/FROM jobs WHERE idempotency_key/.test(sql)) {
      return [...rows.values()].find((row) => row.idempotency_key === values[0]) || null;
    }
    if (/FROM jobs WHERE id =/.test(sql)) {
      return rows.get(values[0]) || null;
    }
    return null;
  }

  /**
   * Read many rows.
   *
   * :param sql: The statement.
   * :param values: The bound values.
   * :param rows: The kept jobs, by id.
   * :return: The rows.
   */
  static all(sql, values, rows) {
    return [...rows.values()];
  }

  /**
   * Write one row, honouring the unique key.
   *
   * :param sql: The statement.
   * :param values: The bound values.
   * :param rows: The kept jobs, by id.
   */
  static run(sql, values, rows) {
    if (/INSERT INTO jobs/.test(sql)) {
      const existing = [...rows.values()].find((row) => row.idempotency_key === values[2]);
      if (existing && /ON CONFLICT\(idempotency_key\) DO NOTHING/.test(sql)) {
        return;
      }
      rows.set(values[0], D1Fake.row(values));
      return;
    }
    if (/UPDATE jobs SET/.test(sql)) {
      const id = values.at(-1);
      rows.set(id, { ...rows.get(id), status: values[0], updated_at: values[1] });
    }
  }

  /**
   * Name the columns the store's INSERT binds, in order.
   *
   * :param values: The bound values.
   * :return: The row.
   */
  static row(values) {
    const columns = ["id", "quote_id", "idempotency_key", "request_digest", "pizza_order_ref", "item_summary",
      "drop_zone", "parcel_size", "item_count", "customer_name", "phone", "address", "note",
      "fee_cents", "eta_minutes", "status", "created_at", "updated_at"];
    const row = {};
    columns.forEach((column, index) => {
      row[column] = values[index];
    });
    return row;
  }
}

test("the fee table's boundaries are the ones the desk publishes", () => {
  // The largest parcel the desk takes, priced by hand.
  const priced = CourierData.priceOf({ dropZone: "old_town", parcelSize: "large", itemCount: 12 });
  assert.equal(priced.feeCents, 550 + 450 + 10 * 50);
  assert.equal(priced.etaMinutes, 22 + 9);
  // The first item beyond the small bag's allowance is the first charged one.
  assert.equal(CourierData.priceOf({ dropZone: "harbor", parcelSize: "medium", itemCount: 2 }).feeCents, 500);
  assert.equal(CourierData.priceOf({ dropZone: "harbor", parcelSize: "medium", itemCount: 3 }).feeCents, 550);
  assert.equal(CourierData.openAt("10:00"), true);
  assert.equal(CourierData.openAt("21:59"), true);
  assert.equal(CourierData.openAt("22:00"), false);
  assert.equal(CourierData.openAt("09:59"), false);
});
