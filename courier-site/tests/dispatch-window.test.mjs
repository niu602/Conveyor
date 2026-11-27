// The dispatch window's failure branches, which are the point of the write: an answer
// that never arrived must be settled by reading, never by sending the parcel again.
//
// These drive submit() with the form already shown, so they need no browser. The desk is
// a fake that records every call, so a test can prove the write happened exactly once.
import assert from "node:assert/strict";
import test from "node:test";
import { StubElement } from "./stub_element.mjs";

// The window builds its notices with document.createElement and nothing else.
globalThis.document = { createElement: (tag) => new StubElement(tag) };

const { DispatchWindow } = await import("../bridge/dispatch-window.js");
const { DeskClient } = await import("../desk-client.js");

const QUOTE_ID = "Q-11112222-3333-4444-5555-666677778888";
const ORDER_REF = "DEMO-1";
const KEY = `dispatch:${ORDER_REF}:${QUOTE_ID}`;
const CALLER = "127.0.0.1:8084";

// What the visitor typed. It must reach the desk and the window, and nothing else.
const TYPED = {
  customerName: "  Sam Lee  ",
  phone: "555-0142",
  address: "  12 Harbor Rd, North town  ",
  note: "Leave at the blue door",
};

/**
 * The quote the desk's read-only check would return.
 *
 * The expiry is kept ahead of the real clock, because the window decides whether a retry
 * may be offered by comparing it with now.
 *
 * :return: The quote summary.
 */
function heldQuote() {
  return {
    ok: true,
    quoteId: QUOTE_ID,
    dropZone: "north",
    parcelSize: "small",
    itemCount: 2,
    feeCents: 450,
    feeText: "$4.50",
    etaMinutes: 18,
    expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
  };
}

/**
 * The job receipt the desk returns for an accepted run. It carries no visitor details.
 *
 * :return: The receipt.
 */
function receipt() {
  return {
    ok: true,
    jobId: "J-99998888-7777-6666-5555-444433332222",
    status: "assigned",
    dropZone: "north",
    parcelSize: "small",
    itemCount: 2,
    itemSummary: "2x Margherita",
    pizzaOrderRef: "DEMO-1",
    feeCents: 450,
    feeText: "$4.50",
    etaMinutes: 18,
    createdAt: "2026-11-25T18:30:00.000Z",
    updatedAt: "2026-11-25T18:30:00.000Z",
  };
}

/**
 * A desk that answers as the test scripts it to, and counts every call.
 *
 * :param dispatchAnswer: The receipt, a refusal, or an Error to throw. A list answers each
 *   send in turn, reusing the last entry.
 * :param outcomeAnswer: The outcome body, or an Error to throw. A list answers each read
 *   in turn, reusing the last entry.
 * :return: The fake desk, with its call counts.
 */
function fakeDesk(dispatchAnswer, outcomeAnswer) {
  const answer = (scripted, calls) => {
    if (!Array.isArray(scripted)) {
      return scripted;
    }
    return scripted[Math.min(calls, scripted.length - 1)];
  };
  return {
    dispatchCalls: [],
    outcomeCalls: [],
    async dispatch(args, details) {
      const given = answer(dispatchAnswer, this.dispatchCalls.length);
      this.dispatchCalls.push({ args, details });
      if (given instanceof Error) {
        throw given;
      }
      return given;
    },
    async outcome(key) {
      const given = answer(outcomeAnswer, this.outcomeCalls.length);
      this.outcomeCalls.push(key);
      if (given instanceof Error) {
        throw given;
      }
      return given;
    },
  };
}

/**
 * Build the window's state as showForm leaves it, with the form filled in.
 *
 * :param desk: The desk the window sends through.
 * :return: The state, the box it replaces, and a holder for what it resolves with.
 */
function shownForm(desk) {
  const form = new StubElement("form");
  const messages = { request: new StubElement("p") };
  for (const field of DispatchWindow.FIELDS) {
    const input = new StubElement("input");
    input.value = TYPED[field.name];
    form.elements[field.name] = input;
    messages[field.name] = new StubElement("p");
  }
  const answered = {};
  const waits = [];
  const state = {
    desk,
    request: {
      quoteId: QUOTE_ID,
      expectedFeeCents: 450,
      dropZone: "north",
      parcelSize: "small",
      itemCount: 2,
      itemSummary: "2x Margherita",
      pizzaOrderRef: ORDER_REF,
    },
    quote: heldQuote(),
    caller: CALLER,
    done: false,
    form,
    messages,
    confirmButton: new StubElement("button"),
    // The checking schedule is recorded instead of slept, so these tests stay instant.
    wait: async (ms) => { waits.push(ms); },
    resolve: (value) => { answered.value = value; },
  };
  return { state, box: new StubElement("main"), answered, waits };
}

/**
 * Submit the form as the visitor's click would.
 *
 * :param state: The window's state.
 * :param box: The window's content.
 * :return: A promise of nothing.
 */
function submit(state, box) {
  return DispatchWindow.submit(state, box, { preventDefault() {} });
}

/**
 * Read every text the window shows, so a test can scan it.
 *
 * :param node: The element to read.
 * :return: The joined text.
 */
function textOf(node) {
  if (!(node instanceof StubElement)) {
    return "";
  }
  return [node.textContent, ...node.children.map(textOf)].join(" ");
}

test("a lost answer that reads back as recorded settles as the job, sent once", async () => {
  const desk = fakeDesk(DeskClient.unknown("connection reset"), { ok: true, recorded: true, ...receipt(), events: [{ type: "assigned", at: "2026-11-25T18:30:00.000Z", detail: "north, 2 items" }] });
  const { state, box, answered } = shownForm(desk);
  await submit(state, box);

  assert.equal(desk.dispatchCalls.length, 1, "The write must never be sent a second time.");
  assert.deepEqual(desk.outcomeCalls, [KEY], "The read must use the same idempotency key.");
  assert.equal(desk.dispatchCalls[0].args.idempotencyKey, KEY);
  assert.equal(answered.value.ok, true);
  assert.equal(answered.value.settledBy, "read");
  assert.equal(answered.value.replayed, true);
  assert.equal(answered.value.jobId, receipt().jobId);
  assert.equal(answered.value.feeCents, 450);
  assert.equal(state.done, true, "The window is finished; it must not offer another send.");
  assert.equal(state.confirmButton.disabled, true);
  assert.match(textOf(box), /Already on the desk/);
});

test("a lost answer the desk twice reports as absent opens a retry on the same reference", async () => {
  const desk = fakeDesk(DeskClient.unknown("timeout"), { ok: true, recorded: false });
  const { state, box, answered, waits } = shownForm(desk);
  await submit(state, box);

  assert.equal(desk.dispatchCalls.length, 1);
  assert.deepEqual(desk.outcomeCalls, [KEY, KEY], "An absence must be read twice before it is believed.");
  assert.deepEqual(waits, [5000], "The second read comes after the first delay, not at once.");
  assert.equal(answered.value, undefined, "The window waits for the visitor instead of resolving.");
  assert.equal(state.done, false, "A confirmed absence is the one case that offers another send.");
  assert.equal(state.confirmButton.disabled, false);
  assert.equal(state.confirmButton.textContent, "Send this parcel again");
  const shown = textOf(box);
  assert.match(shown, /Nothing was recorded/);
  assert.match(shown, /same reference/);
  assert.equal(box.children.includes(state.form), true, "The form must be back for the retry.");
});

test("a retry after a confirmed absence sends the same key and takes the first job", async () => {
  // The first send's answer is lost and the desk says nothing landed; by the retry the
  // first write turns out to have landed after all. The key must make that a replay.
  const desk = fakeDesk(
    [DeskClient.unknown("timeout"), { ...receipt(), replayed: true }],
    { ok: true, recorded: false },
  );
  const { state, box, answered } = shownForm(desk);
  await submit(state, box);
  await submit(state, box);

  assert.equal(desk.dispatchCalls.length, 2);
  assert.equal(desk.dispatchCalls[0].args.idempotencyKey, KEY);
  assert.equal(desk.dispatchCalls[1].args.idempotencyKey, KEY, "A retry must not mint a new reference.");
  assert.equal(answered.value.ok, true);
  assert.equal(answered.value.replayed, true);
  assert.equal(answered.value.jobId, receipt().jobId);
  assert.equal(state.confirmButton.disabled, true);
  assert.match(textOf(box), /Already on the desk/);
});

test("a confirmed absence after the quote ran out closes the window instead of offering a retry", async () => {
  const desk = fakeDesk(DeskClient.unknown("timeout"), { ok: true, recorded: false });
  const { state, box, answered } = shownForm(desk);
  state.quote.expiresAt = new Date(Date.now() - 1000).toISOString();
  await submit(state, box);

  assert.equal(desk.dispatchCalls.length, 1);
  assert.equal(answered.value.ok, false);
  assert.equal(answered.value.settledBy, "read");
  assert.match(answered.value.reason, /quote has expired/);
  assert.equal(state.done, true);
  assert.equal(state.confirmButton.disabled, true, "The retry window is the quote's life, and it is over.");
  assert.equal(box.children.includes(state.form), false);
});

test("a lost answer the desk cannot read stays unknown after the whole checking budget", async () => {
  const desk = fakeDesk(DeskClient.unknown("offline"), DeskClient.unknown("still offline"));
  const { state, box, answered, waits } = shownForm(desk);
  await submit(state, box);

  assert.equal(desk.dispatchCalls.length, 1);
  assert.equal(desk.outcomeCalls.length, 5, "One read at once, then one after each delay.");
  assert.deepEqual(waits, [5000, 10000, 15000, 15000], "The schedule widens to a 45-second budget.");
  assert.equal(waits.reduce((sum, ms) => sum + ms, 0), 45000);
  assert.equal(answered.value.ok, false);
  assert.equal(answered.value.unknown, true);
  assert.match(answered.value.reason, /Do not dispatch again/);
  assert.match(answered.value.reason, /website_lookup_job/);
  assert.equal(state.done, true);
  assert.equal(state.confirmButton.disabled, true, "No send is offered while the outcome is open.");
  assert.equal(box.children.includes(state.form), false);
  const shown = textOf(box);
  assert.match(shown, /We could not confirm it/);
  assert.match(shown, /jobs on the desk/);
});

test("checking stops as soon as the desk says the job is there", async () => {
  const desk = fakeDesk(DeskClient.unknown("reset"), [
    DeskClient.unknown("offline"),
    { ok: true, recorded: false },
    { ok: true, recorded: true, ...receipt() },
  ]);
  const { state, box, answered, waits } = shownForm(desk);
  await submit(state, box);

  assert.equal(desk.outcomeCalls.length, 3);
  assert.deepEqual(waits, [5000, 10000], "It stops on the answer instead of running the budget out.");
  assert.equal(answered.value.ok, true);
  assert.equal(answered.value.settledBy, "read");
  assert.equal(state.confirmButton.disabled, true);
});

test("an absence only counts when the reads that say it are in a row", async () => {
  const desk = fakeDesk(DeskClient.unknown("reset"), [
    { ok: true, recorded: false },
    DeskClient.unknown("offline"),
    { ok: true, recorded: false },
    { ok: true, recorded: false },
  ]);
  const { state, box, waits } = shownForm(desk);
  await submit(state, box);

  assert.equal(desk.outcomeCalls.length, 4, "The unreadable read breaks the run of absences.");
  assert.deepEqual(waits, [5000, 10000, 15000]);
  assert.equal(state.done, false);
});

test("a refusal from the outcome read is not an answer about the job", async () => {
  const desk = fakeDesk(DeskClient.unknown("reset"), { ok: false, reason: "Reading an outcome needs the idempotency key.", field: "idempotencyKey" });
  const { state, box, answered } = shownForm(desk);
  await submit(state, box);

  assert.equal(desk.dispatchCalls.length, 1);
  assert.equal(answered.value.unknown, true, "A refused read settles nothing.");
  assert.equal(answered.value.settledBy, undefined);
  assert.equal(state.confirmButton.disabled, true);
});

test("a desk failure marked unknown is settled by reading, never treated as a refusal", async () => {
  // A 500 from the intake means the write may have landed. Treating it as a refusal would
  // show the desk's reason beside the form and skip the reads entirely.
  const desk = fakeDesk(DeskClient.unknown("The desk's intake failed with 500."), { ok: true, recorded: false });
  const { state, box } = shownForm(desk);
  await submit(state, box);

  assert.equal(desk.dispatchCalls.length, 1);
  assert.equal(desk.outcomeCalls.length, 2, "A 500 must go through the reads, not straight back to the form.");
  assert.equal(state.messages.request.hidden, true, "No refusal message belongs beside a lost answer.");
  assert.match(textOf(box), /Nothing was recorded/);
});

test("a reference that already names a different run ends the window instead of re-opening it", async () => {
  const desk = fakeDesk({
    ok: false,
    code: "idempotency_conflict",
    field: "idempotencyKey",
    jobId: "J-00001111-2222-3333-4444-555566667777",
    reason: "That reference already names job J-00001111-2222-3333-4444-555566667777 for $4.50, 2 item(s) to north.",
  }, { ok: true, recorded: false });
  const { state, box, answered } = shownForm(desk);
  await submit(state, box);

  assert.equal(desk.dispatchCalls.length, 1);
  assert.deepEqual(desk.outcomeCalls, [], "A conflict is a settled answer: read nothing.");
  assert.equal(answered.value.ok, false);
  assert.equal(answered.value.code, "idempotency_conflict");
  assert.equal(answered.value.jobId, "J-00001111-2222-3333-4444-555566667777");
  assert.equal(state.done, true);
  assert.equal(state.confirmButton.disabled, true);
  assert.match(textOf(box), /already used/);
});

test("the key is derived from the order and the quote, and never from the amount", () => {
  assert.equal(DispatchWindow.keyFor(QUOTE_ID, ORDER_REF), KEY);
  assert.equal(DispatchWindow.keyFor(QUOTE_ID, "  DEMO-1  "), KEY, "The reference is trimmed before it is used.");
  assert.equal(DispatchWindow.keyFor(QUOTE_ID, ""), `dispatch:${QUOTE_ID}`);
  assert.equal(DispatchWindow.keyFor(QUOTE_ID, undefined), `dispatch:${QUOTE_ID}`);
  // Both sites can work the key out again from what they already hold.
  assert.equal(DispatchWindow.keyFor(QUOTE_ID, ORDER_REF), DispatchWindow.keyFor(QUOTE_ID, ORDER_REF));
  assert.notEqual(DispatchWindow.keyFor(QUOTE_ID, "DEMO-2"), KEY);
  assert.equal(KEY.includes("450"), false, "The amount belongs in the digest, not in the key.");
});

test("a real refusal re-opens the form, and is not settled by a read", async () => {
  const desk = fakeDesk({ ok: false, reason: "The fee for this delivery is $6.50, not the amount given. Ask for a new quote.", field: "expectedFeeCents", code: "quote_changed" }, { ok: true, recorded: false });
  const { state, box, answered } = shownForm(desk);
  await submit(state, box);

  assert.equal(desk.dispatchCalls.length, 1);
  assert.deepEqual(desk.outcomeCalls, [], "A refusal is a settled answer already: read nothing.");
  assert.equal(answered.value, undefined, "The window waits for the visitor instead of resolving.");
  assert.equal(state.done, false);
  assert.equal(state.confirmButton.disabled, false);
  assert.match(state.messages.request.textContent, /\$6\.50/);
});

test("bad details never reach the desk, and the window stays open", async () => {
  const desk = fakeDesk(receipt(), { ok: true, recorded: false });
  const { state, box, answered } = shownForm(desk);
  state.form.elements.phone.value = "call me";
  await submit(state, box);

  assert.deepEqual(desk.dispatchCalls, [], "Nothing is sent while the desk's own rules refuse a field.");
  assert.deepEqual(desk.outcomeCalls, []);
  assert.equal(answered.value, undefined);
  assert.equal(state.done, false);
  assert.match(state.messages.phone.textContent, /\S/);
});

test("settle keeps the three outcomes apart for every answer the desk can give", async () => {
  const job = { ok: true, recorded: true, ...receipt() };
  assert.deepEqual(await DispatchWindow.settle(fakeDesk(null, job), KEY), { outcome: "recorded", job });
  assert.deepEqual(await DispatchWindow.settle(fakeDesk(null, { ok: true, recorded: false }), KEY), { outcome: "absent" });
  assert.deepEqual(await DispatchWindow.settle(fakeDesk(null, DeskClient.unknown("offline")), KEY), { outcome: "unknown" });
  assert.deepEqual(await DispatchWindow.settle(fakeDesk(null, { ok: false, reason: "no key" }), KEY), { outcome: "unknown" });
  assert.deepEqual(await DispatchWindow.settle(fakeDesk(null, null), KEY), { outcome: "unknown" });
  // A body that claims success without saying whether it recorded is not an answer.
  assert.deepEqual(await DispatchWindow.settle(fakeDesk(null, { ok: true }), KEY), { outcome: "unknown" });
});

test("the settled result and the window's own notice carry no visitor details", async () => {
  const desk = fakeDesk(DeskClient.unknown("reset"), { ok: true, recorded: true, ...receipt() });
  const { state, box, answered } = shownForm(desk);
  await submit(state, box);

  // The desk gets what the visitor typed; the calling chat must not.
  assert.equal(desk.dispatchCalls[0].details.customerName, TYPED.customerName);
  const forChat = JSON.stringify(answered.value);
  for (const value of ["Sam", "Lee", "555-0142", "Harbor Rd", "blue door"]) {
    assert.equal(forChat.includes(value), false, `The chat result must not carry "${value}".`);
  }
  // The window itself shows them back to the visitor, which is where they belong.
  assert.match(textOf(box), /Sam Lee/);
});

test("the client marks a failed intake unknown and keeps a refusal as a refusal", async () => {
  const desk = new DeskClient("http://127.0.0.1:9");
  const answerWith = (response) => { globalThis.fetch = async () => response; };

  answerWith({ status: 422, json: async () => ({ ok: false, reason: "The parcel does not match the quote." }) });
  assert.deepEqual(await desk.outcome(KEY), { ok: false, reason: "The parcel does not match the quote." });

  for (const response of [
    { status: 500, json: async () => ({ ok: false, reason: "The desk could not complete that call." }) },
    { status: 503, json: async () => ({}) },
    { status: 200, json: async () => { throw new Error("Unexpected token <"); } },
  ]) {
    answerWith(response);
    await assert.rejects(() => desk.dispatch({}, {}), (error) => error.unknown === true, `Status ${response.status} must be unknown.`);
  }

  globalThis.fetch = async () => { throw new Error("fetch failed"); };
  await assert.rejects(() => desk.dispatch({}, {}), (error) => error.unknown === true);
});

test("the outcome read asks by key and writes nothing", async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, method: init.method, body: init.body });
    return { status: 200, json: async () => ({ ok: true, recorded: false }) };
  };
  const answer = await new DeskClient("http://127.0.0.1:9").outcome(KEY);
  assert.deepEqual(answer, { ok: true, recorded: false });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "GET", "Settling an outcome must be a read.");
  assert.equal(seen[0].body, undefined);
  assert.equal(seen[0].url, `http://127.0.0.1:9/api/dispatch/outcome?key=${encodeURIComponent(KEY)}`);
});