// The reconciliation ledger: what it says about each receipt, and what it refuses to say
// when it could not read the desk. Run: node --test "D:/Conveyor/courier-site/tests/*.test.mjs"
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { StubElement } from "./stub_element.mjs";
import { generateKeyPair, kidOf } from "../receipt-crypto.js";
import { createSigner } from "../worker/receipt-signer.mjs";
import { readLedger, checkReceipt, renderLedger, tamperCheck, VERDICTS } from "../receipt-ledger.js";

globalThis.document = { createElement: (tag) => new StubElement(tag) };

/**
 * A receipt as the desk serves it. Visitor details are not in one, and must never appear.
 *
 * :param over: Fields to change.
 * :return: The receipt.
 */
function receipt(over = {}) {
  return {
    jobId: "J-ledger-1",
    pizzaOrderRef: "DEMO-1795410453238",
    dropZone: "north",
    parcelSize: "small",
    itemCount: 2,
    feeCents: 450,
    etaMinutes: 18,
    status: "assigned",
    createdAt: "2026-11-28T12:00:00.000Z",
    updatedAt: "2026-11-28T12:00:00.000Z",
    ...over,
  };
}

/**
 * A desk that answers the two reads the ledger makes.
 *
 * :param keys: The published keys.
 * :param jobs: The receipts to serve.
 * :param fail: Which read fails, as "keys" or "jobs", or null.
 * :return: The fetch stand-in and the urls it was asked for.
 */
function fakeDesk(keys, jobs, fail = null) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.endsWith("/api/pubkey")) {
      if (fail === "keys") throw new Error("connection refused");
      return { ok: true, status: 200, json: async () => ({ ok: true, keys }) };
    }
    if (fail === "jobs") return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ ok: true, jobs }) };
  };
  return { fetchImpl, urls };
}

test("the ledger keeps verified, changed, unpublished-key and unsigned apart", async () => {
  const pair = await generateKeyPair();
  const signer = await createSigner({ privateJwk: pair.privateJwk });
  const keys = signer.publicKeys();
  const good = receipt();
  const signed = { ...good, ...(await signer.sign(good)) };
  // The same signature over a different fee: what a tampered row looks like.
  const raised = { ...signed, jobId: "J-ledger-2", feeCents: 999 };
  const foreign = { ...signed, jobId: "J-ledger-3", kid: "0000000000000000" };
  const plain = receipt({ jobId: "J-ledger-4" });
  const desk = fakeDesk(keys, [signed, raised, foreign, plain]);
  const ledger = await readLedger({ fetchImpl: desk.fetchImpl });

  assert.deepEqual(ledger.rows.map((row) => row.verdict), ["verified", "changed", "no-key", "unsigned"]);
  assert.deepEqual(ledger.counts, { verified: 1, changed: 1, "no-key": 1, unsigned: 1 });
  assert.equal(ledger.rows[0].kid, await kidOf(pair.publicJwk));
  assert.equal(desk.urls.length, 2, "One read of the keys and one of the jobs, nothing else.");
  assert.ok(desk.urls[0].endsWith("/api/pubkey"));
});

test("an unreadable desk is an error, never a verdict on a receipt", async () => {
  const pair = await generateKeyPair();
  const signer = await createSigner({ privateJwk: pair.privateJwk });
  const good = receipt();
  const signed = { ...good, ...(await signer.sign(good)) };
  // Without the key channel nothing may be called verified, and nothing may be called
  // tampered either: the page simply could not check.
  const noKeys = await readLedger({ fetchImpl: fakeDesk(signer.publicKeys(), [signed], "keys").fetchImpl });
  assert.ok(noKeys.error);
  assert.equal(noKeys.rows, undefined);
  const noJobs = await readLedger({ fetchImpl: fakeDesk(signer.publicKeys(), [signed], "jobs").fetchImpl });
  assert.ok(noJobs.error);
  assert.equal(noJobs.rows, undefined);
});

test("a desk with no signing key says so instead of implying the receipts are bad", async () => {
  const ledger = await readLedger({ fetchImpl: fakeDesk([], [receipt()]).fetchImpl });
  assert.equal(ledger.rows[0].verdict, "unsigned");
  const root = new StubElement("div");
  renderLedger(root, ledger);
  const text = root.querySelectorAll("p").map((node) => node.textContent).join("\n");
  assert.match(text, /publishes no signing key/);
  assert.doesNotMatch(text, /Does not match/);
});

test("the drawn ledger shows the booking and the verdict, and no visitor detail", async () => {
  const pair = await generateKeyPair();
  const signer = await createSigner({ privateJwk: pair.privateJwk });
  const good = receipt();
  const signed = { ...good, ...(await signer.sign(good)) };
  const ledger = await readLedger({ fetchImpl: fakeDesk(signer.publicKeys(), [signed, receipt({ jobId: "J-old" })]).fetchImpl });
  const root = new StubElement("div");
  renderLedger(root, ledger);

  const rows = root.querySelectorAll("tr").filter((row) => row.dataset.jobId);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].dataset.verdict, "verified");
  assert.equal(rows[1].dataset.verdict, "unsigned");
  const cells = rows[0].querySelectorAll("td").map((cell) => cell.textContent);
  assert.equal(cells[0], signed.jobId);
  assert.equal(cells[1], signed.pizzaOrderRef);
  assert.equal(cells[2], "$4.50");
  assert.equal(cells[3], signed.createdAt);
  assert.equal(cells[4], signer.kid);
  const headings = root.querySelectorAll("th").map((cell) => cell.textContent);
  assert.deepEqual(headings, ["Job number", "Order reference", "Fee", "Recorded at", "Key", "Signature"]);

  // Nothing a visitor typed may be drawn, even though the desk holds it.
  const drawn = JSON.stringify(root, (key, value) => (key === "provided" ? undefined : value));
  for (const secret of ["Sam Lee", "555-0142", "Harbor Rd", "blue door"]) {
    assert.equal(drawn.includes(secret), false, `${secret} must not be drawn.`);
  }
  assert.match(drawn, /never appear here/);
});

test("an unreadable desk is drawn as an alert, not as an empty table", async () => {
  const root = new StubElement("div");
  renderLedger(root, { error: "The desk could not be read: connection refused" });
  assert.equal(root.querySelectorAll("table").length, 0);
  const alert = root.querySelectorAll("p")[0];
  assert.equal(alert.attributes.role, "alert");
  assert.match(alert.textContent, /could not be read/);
});

test("the changed-amount check is local and never writes to the desk", async () => {
  const pair = await generateKeyPair();
  const signer = await createSigner({ privateJwk: pair.privateJwk });
  const good = receipt();
  const signed = { ...good, ...(await signer.sign(good)) };
  const desk = fakeDesk(signer.publicKeys(), [signed]);
  const ledger = await readLedger({ fetchImpl: desk.fetchImpl });
  const before = desk.urls.length;
  const answer = await tamperCheck(ledger.rows[0].receipt, ledger.keys);
  assert.equal(answer.verdict, "changed");
  assert.equal(desk.urls.length, before, "The what-if must not call the desk.");
  assert.equal(ledger.rows[0].receipt.feeCents, 450, "The row itself must not be changed.");
  assert.equal((await checkReceipt(ledger.rows[0].receipt, ledger.keys)).verdict, "verified");
});

test("every verdict the ledger can return has wording on the page", () => {
  for (const verdict of ["verified", "changed", "no-key", "unsigned"]) {
    assert.ok(VERDICTS[verdict].label);
    assert.ok(VERDICTS[verdict].note);
  }
  assert.deepEqual(Object.keys(VERDICTS).sort(), ["changed", "no-key", "unsigned", "verified"]);
});

test("the courier page mounts the ledger with the ids the shared script looks for", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /id="receipts-ledger"/);
  assert.match(html, /id="refresh-receipts"/);
  assert.match(html, /src="receipt-page\.js"/);
  assert.match(html, /href="receipt-ledger\.css"/);
  assert.match(html, /href="#receipts"/);
});