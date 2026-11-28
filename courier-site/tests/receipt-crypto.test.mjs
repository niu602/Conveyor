// Checks the receipt signature: what it covers, what it survives, and key rotation.
// Run: node --test "D:/Conveyor/courier-site/tests/*.test.mjs"
//
// Every key here is generated in-process and thrown away. No real key is read, and the
// desk's .env is never touched by a test.
import assert from "node:assert/strict";
import test from "node:test";
import {
  receiptPayload,
  toBase64Url,
  fromBase64Url,
  publicJwkShape,
  kidOf,
  generateKeyPair,
  verifyReceipt,
  RECEIPT_ALG,
  RECEIPT_SIGNED_FIELDS,
} from "../receipt-crypto.js";
import { createSigner, signerFromEnv } from "../worker/receipt-signer.mjs";

/**
 * A receipt as the desk serves it, with visitor details attached.
 *
 * :return: The receipt.
 */
function sampleReceipt() {
  return {
    jobId: "J-1a2b3c",
    pizzaOrderRef: "LO-77",
    dropZone: "north",
    parcelSize: "small",
    itemCount: 2,
    feeCents: 450,
    etaMinutes: 18,
    createdAt: "2026-11-28T09:00:00.000Z",
    status: "assigned",
    updatedAt: "2026-11-28T09:00:00.000Z",
    customerName: "Sam Lee",
    phone: "+1 555 0100",
    address: "12 Harbor Rd",
    note: "Ring twice",
  };
}

test("a signature covers the booking and verifies against the published key", async () => {
  const pair = await generateKeyPair();
  const signer = await createSigner({ privateJwk: pair.privateJwk });
  const receipt = { ...sampleReceipt(), ...(await signer.sign(sampleReceipt())) };
  assert.equal(receipt.alg, RECEIPT_ALG);
  assert.equal(receipt.kid, signer.kid);
  assert.equal(await verifyReceipt(pair.publicJwk, receipt), true);
});

test("changing any signed fact breaks the signature", async () => {
  const pair = await generateKeyPair();
  const signer = await createSigner({ privateJwk: pair.privateJwk });
  const base = sampleReceipt();
  const signed = { ...base, ...(await signer.sign(base)) };
  // Every field the receipt attests, tampered one at a time. The fee is the one that
  // matters most: a raised amount must not still read as verified.
  const edits = {
    jobId: "J-other",
    pizzaOrderRef: "LO-99",
    dropZone: "harbor",
    parcelSize: "large",
    itemCount: 3,
    feeCents: 4500,
    etaMinutes: 4,
    createdAt: "2026-11-28T09:00:01.000Z",
  };
  assert.deepEqual(Object.keys(edits), RECEIPT_SIGNED_FIELDS, "Every signed field must have a tamper case.");
  for (const [field, value] of Object.entries(edits)) {
    const changed = { ...signed, [field]: value };
    assert.equal(await verifyReceipt(pair.publicJwk, changed), false, `${field} must be covered.`);
  }
  // A number re-typed as a string is the same fact, so it still verifies: the payload
  // coerces the three numeric fields, which is what keeps the wire and the page agreeing.
  assert.equal(await verifyReceipt(pair.publicJwk, { ...signed, feeCents: "450" }), true);
});

test("the signature survives delivery and never carries visitor details", async () => {
  const pair = await generateKeyPair();
  const signer = await createSigner({ privateJwk: pair.privateJwk });
  const base = sampleReceipt();
  const signed = { ...base, ...(await signer.sign(base)) };
  // The run proceeds: status and updatedAt move, and the receipt must still verify.
  const delivered = { ...signed, status: "delivered", updatedAt: "2026-11-28T09:41:00.000Z" };
  assert.equal(await verifyReceipt(pair.publicJwk, delivered), true);
  // PII is outside the signed payload entirely, so it cannot be recovered from it.
  const payload = receiptPayload(signed);
  for (const secret of ["Sam Lee", "555 0100", "Harbor Rd", "Ring twice", "assigned"]) {
    assert.equal(payload.includes(secret), false, `${secret} must not be in the signed bytes.`);
  }
  assert.deepEqual(Object.keys(JSON.parse(payload)), RECEIPT_SIGNED_FIELDS);
});

test("a damaged or foreign signature reads as not verified, never as an error", async () => {
  const pair = await generateKeyPair();
  const other = await generateKeyPair();
  const signer = await createSigner({ privateJwk: pair.privateJwk });
  const base = sampleReceipt();
  const signed = { ...base, ...(await signer.sign(base)) };
  assert.equal(await verifyReceipt(other.publicJwk, signed), false, "Another key must not verify it.");
  assert.equal(await verifyReceipt(pair.publicJwk, { ...signed, signature: "not-base64!!" }), false);
  assert.equal(await verifyReceipt(pair.publicJwk, { ...signed, signature: "" }), false);
  assert.equal(await verifyReceipt(pair.publicJwk, { ...signed, signature: undefined }), false);
  assert.equal(await verifyReceipt(pair.publicJwk, null), false);
  assert.equal(await verifyReceipt({}, signed), false);
  // One flipped byte inside an otherwise well-formed signature.
  const bytes = fromBase64Url(signed.signature);
  bytes[0] ^= 0xff;
  assert.equal(await verifyReceipt(pair.publicJwk, { ...signed, signature: toBase64Url(bytes) }), false);
});

test("the kid comes from the public key alone, so extra JWK members cannot shift it", async () => {
  const pair = await generateKeyPair();
  const kid = await kidOf(pair.publicJwk);
  assert.match(kid, /^[a-z0-9]{16}$/);
  assert.equal(kid, await kidOf(pair.publicJwk), "The same key must always get the same id.");
  // An export from another runtime may carry ext and key_ops; the id must not move.
  assert.equal(await kidOf({ ...pair.publicJwk, ext: true, key_ops: ["verify"], alg: "ES256" }), kid);
  const other = await generateKeyPair();
  assert.notEqual(await kidOf(other.publicJwk), kid, "A new key must get a new id.");
});

test("rotating the signing key keeps older receipts verifiable by their own kid", async () => {
  const first = await generateKeyPair();
  const second = await generateKeyPair();
  const oldSigner = await createSigner({ privateJwk: first.privateJwk });
  const base = sampleReceipt();
  const oldReceipt = { ...base, ...(await oldSigner.sign(base)) };

  // The desk now signs with the new key and keeps publishing the retired public half.
  const signer = await createSigner({
    privateJwk: second.privateJwk,
    retiredPublicJwks: [first.publicJwk],
  });
  const keys = signer.publicKeys();
  assert.equal(keys.length, 2);
  assert.equal(keys[0].kid, await kidOf(second.publicJwk), "The active key comes first.");
  assert.deepEqual(keys.map((entry) => entry.kid), [signer.kid, oldReceipt.kid]);
  for (const entry of keys) {
    assert.equal("d" in entry, false, "A published key must never carry the private half.");
    assert.deepEqual(Object.keys(entry), ["kid", "alg", "kty", "crv", "x", "y"]);
  }
  // Each page picks the key by the receipt's kid, so both generations verify.
  const byKid = new Map(keys.map((entry) => [entry.kid, entry]));
  assert.equal(await verifyReceipt(byKid.get(oldReceipt.kid), oldReceipt), true);
  const newReceipt = { ...base, jobId: "J-new", ...(await signer.sign({ ...base, jobId: "J-new" })) };
  assert.equal(await verifyReceipt(byKid.get(newReceipt.kid), newReceipt), true);
  // The old key does not verify the new receipt: the kid is what prevents that mix-up.
  assert.equal(await verifyReceipt(byKid.get(oldReceipt.kid), newReceipt), false);
  // Re-publishing the active key as retired must not list it twice.
  const deduped = await createSigner({ privateJwk: second.privateJwk, retiredPublicJwks: [second.publicJwk] });
  assert.equal(deduped.publicKeys().length, 1);
});

test("publicJwkShape keeps only the four members that are published", async () => {
  const pair = await generateKeyPair();
  assert.deepEqual(publicJwkShape({ ...pair.privateJwk, ext: true, key_ops: ["sign"] }), pair.publicJwk);
  assert.equal("d" in publicJwkShape(pair.privateJwk), false);
});

test("the desk signs only when its environment holds a usable key", async () => {
  assert.equal(await signerFromEnv({}), null, "No key means unsigned receipts, not a broken desk.");
  assert.equal(await signerFromEnv({ RECEIPT_PRIVATE_KEY: "   " }), null);
  assert.equal(await signerFromEnv({ RECEIPT_PRIVATE_KEY: "{not json" }), null);
  assert.equal(await signerFromEnv({ RECEIPT_PRIVATE_KEY: '{"kty":"EC"}' }), null, "A JWK without d cannot sign.");
  assert.equal(await createSigner({}), null);

  const pair = await generateKeyPair();
  const signer = await signerFromEnv({ RECEIPT_PRIVATE_KEY: JSON.stringify(pair.privateJwk) });
  assert.ok(signer, "A well-formed key must produce a signer.");
  assert.equal(signer.kid, await kidOf(pair.publicJwk));
  // A malformed retired list is ignored rather than taking signing down with it.
  const withBadRetired = await signerFromEnv({
    RECEIPT_PRIVATE_KEY: JSON.stringify(pair.privateJwk),
    RECEIPT_RETIRED_PUBLIC_KEYS: "not an array",
  });
  assert.equal(withBadRetired.publicKeys().length, 1);
});