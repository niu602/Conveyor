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
const KEY = `dispatch:${QUOTE_ID}`;
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
    expiresAt: "2026-11-25T18:45:00.000Z",
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
 * :param dispatchAnswer: The receipt, a refusal, or an Error to throw.
 * :param outcomeAnswer: The outcome body, or an Error to throw.
 * :return: The fake desk, with its call counts.
 */
function fakeDesk(dispatchAnswer, outcomeAnswer) {
  return {
    dispatchCalls: [],
    outcomeCalls: [],
    async dispatch(args, details) {
      this.dispatchCalls.push({ args, details });
      if (dispatchAnswer instanceof Error) {
        throw dispatchAnswer;
      }
      return dispatchAnswer;
    },
    async outcome(key) {
      this.outcomeCalls.push(key);
      if (outcomeAnswer instanceof Error) {
        throw outcomeAnswer;
      }
      return outcomeAnswer;
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
  const state = {
    desk,
    request: {
      quoteId: QUOTE_ID,
      expectedFeeCents: 450,
      dropZone: "north",
      parcelSize: "small",
      itemCount: 2,
      itemSummary: "2x Margherita",
      pizzaOrderRef: "DEMO-1",
    },
    quote: heldQuote(),
    caller: CALLER,
    done: false,
    form,
    messages,
    confirmButton: new StubElement("button"),
    resolve: (value) => { answered.value = value; },
  };
  return { state, box: new StubElement("main"), answered };
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

test("a lost answer that reads back as absent settles as nothing recorded", async () => {
  const desk = fakeDesk(DeskClient.unknown("timeout"), { ok: true, recorded: false });
  const { state, box, answered } = shownForm(desk);
  await submit(state, box);

  assert.equal(desk.dispatchCalls.length, 1);
  assert.deepEqual(desk.outcomeCalls, [KEY]);
  assert.equal(answered.value.ok, false);
  assert.equal(answered.value.settledBy, "read");
  assert.equal(answered.value.unknown, undefined, "A settled absence is not an unknown outcome.");
  assert.match(answered.value.reason, /no job recorded/);
  assert.equal(state.done, true);
  assert.equal(state.confirmButton.disabled, true);
  assert.match(textOf(box), /Nothing was recorded/);
});

test("a lost answer the desk cannot read either stays unknown, and isn't sent again", async () => {
  const desk = fakeDesk(DeskClient.unknown("offline"), DeskClient.unknown("still offline"));
  const { state, box, answered } = shownForm(desk);
  await submit(state, box);

  assert.equal(desk.dispatchCalls.length, 1);
  assert.equal(desk.outcomeCalls.length, 1, "The read is made once; the write is never repeated.");
  assert.equal(answered.value.ok, false);
  assert.equal(answered.value.unknown, true);
  assert.match(answered.value.reason, /Do not dispatch again/);
  assert.match(answered.value.reason, /website_lookup_job/);
  assert.equal(state.done, true);
  assert.equal(state.confirmButton.disabled, true);
  assert.match(textOf(box), /We could not check/);
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

test("a desk failure marked unknown is not a refusal the visitor may repeat", async () => {
  // A 500 from the intake means the write may have landed. Treating it as a refusal would
  // re-open the form and invite a second send.
  const desk = fakeDesk(DeskClient.unknown("The desk's intake failed with 500."), { ok: true, recorded: false });
  const { state, box, answered } = shownForm(desk);
  await submit(state, box);

  assert.equal(desk.dispatchCalls.length, 1);
  assert.equal(answered.value.settledBy, "read");
  assert.equal(state.confirmButton.disabled, true, "A 500 must not re-open the form.");
  assert.equal(state.messages.request.hidden, true, "No refusal message belongs beside a lost answer.");
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