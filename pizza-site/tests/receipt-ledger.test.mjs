// The pizza shop's side of the reconciliation: its own copy of the verification code must
// be the courier's copy, and must verify what the courier's desk actually signed.
// Run: node --test "D:/Conveyor/pizza-site/tests/*.test.mjs"
//
// The signing side is imported from the courier site on purpose. This is the one test
// that reaches across the two folders, because the point is that they agree.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StubElement } from "./stub_element.mjs";
import { readLedger, renderLedger } from "../receipt-ledger.js";
import { generateKeyPair } from "../receipt-crypto.js";
import { createSigner } from "../../courier-site/worker/receipt-signer.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PIZZA = path.join(HERE, "..");
const COURIER = path.join(HERE, "..", "..", "courier-site");

globalThis.document = { createElement: (tag) => new StubElement(tag) };

test("the shared verification files are byte-identical in both sites", async () => {
  // A copy that drifts would let one site verify bytes the other never signed.
  for (const file of ["receipt-crypto.js", "receipt-ledger.js", "receipt-page.js", "receipt-ledger.css"]) {
    const mine = await readFile(path.join(PIZZA, file));
    const theirs = await readFile(path.join(COURIER, file));
    assert.ok(mine.equals(theirs), `${file} has drifted. Run: node sync-shared.mjs`);
  }
});

test("this page verifies a receipt the courier's desk signed, and rejects a raised fee", async () => {
  const pair = await generateKeyPair();
  const signer = await createSigner({ privateJwk: pair.privateJwk });
  const booking = {
    jobId: "J-cross-1",
    pizzaOrderRef: "DEMO-1795410453238",
    dropZone: "north",
    parcelSize: "small",
    itemCount: 2,
    feeCents: 450,
    etaMinutes: 18,
    createdAt: "2026-11-28T12:00:00.000Z",
  };
  const signed = { ...booking, status: "assigned", updatedAt: booking.createdAt, ...(await signer.sign(booking)) };
  const fetchImpl = async (url) => {
    if (url.endsWith("/api/pubkey")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, keys: signer.publicKeys() }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, jobs: [signed] }) };
  };
  const ledger = await readLedger({ fetchImpl });
  assert.equal(ledger.rows[0].verdict, "verified");

  // The shop's own page must not accept a fee the desk never signed for.
  const raised = await readLedger({
    fetchImpl: async (url) => url.endsWith("/api/pubkey")
      ? { ok: true, status: 200, json: async () => ({ ok: true, keys: signer.publicKeys() }) }
      : { ok: true, status: 200, json: async () => ({ ok: true, jobs: [{ ...signed, feeCents: 4500 }] }) },
  });
  assert.equal(raised.rows[0].verdict, "changed");

  const root = new StubElement("div");
  renderLedger(root, ledger);
  const drawn = JSON.stringify(root, (key, value) => (key === "provided" ? undefined : value));
  assert.match(drawn, /Verified/);
  assert.match(drawn, /\$4\.50/);
  assert.equal(drawn.includes("customerName"), false);
});

test("the pizza page mounts the ledger with the ids the shared script looks for", async () => {
  const html = await readFile(path.join(PIZZA, "index.html"), "utf8");
  assert.match(html, /id="receipts-ledger"/);
  assert.match(html, /id="refresh-receipts"/);
  assert.match(html, /src="receipt-page\.js"/);
  assert.match(html, /href="receipt-ledger\.css"/);
  assert.match(html, /href="#receipts"/);
});