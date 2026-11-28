// Receipt signing and verification, on WebCrypto only.
//
// The same file runs in three places: the desk signs with it (Worker or local Node),
// and both sites' reconciliation pages verify with it in the browser. No Node-only and
// no Worker-only API is used, so the bytes a page verifies are the bytes the desk signed.
//
// What a receipt attests is the booking, not the delivery: the job number, the parcel,
// the fee and the moment it was recorded. Status and updatedAt move as the run proceeds,
// so they are deliberately outside the signed payload — a receipt stays verifiable after
// the parcel is delivered. Visitor details are never in it.
//
// Keys: ECDSA on P-256 with SHA-256. The private half lives only in the desk's
// environment (locally .env, in M3 a wrangler secret) and is never committed. The public
// half is published at /api/pubkey. Every signature carries the kid of the key that made
// it, so rotating the signing key does not invalidate receipts already issued.

const ALG = "ECDSA-P256-SHA256";
const HASH = "SHA-256";
const CURVE = "P-256";

// Fixed order, fixed set. Both sides build the payload through this function, so the
// canonical bytes cannot drift between signing and verifying.
const SIGNED_FIELDS = [
  "jobId",
  "pizzaOrderRef",
  "dropZone",
  "parcelSize",
  "itemCount",
  "feeCents",
  "etaMinutes",
  "createdAt",
];

/**
 * The exact bytes a receipt is signed over.
 *
 * Only the booking facts, never the visitor's name, phone, address or note, and never
 * the mutable status. Numbers stay numbers so a fee cannot be re-read as a string.
 *
 * :param receipt: A job or a receipt carrying the signed fields.
 * :return: The canonical JSON string.
 */
export function receiptPayload(receipt) {
  const out = {};
  for (const field of SIGNED_FIELDS) {
    const value = receipt[field];
    if (field === "itemCount" || field === "feeCents" || field === "etaMinutes") {
      out[field] = Number(value);
    } else {
      out[field] = String(value ?? "");
    }
  }
  return JSON.stringify(out);
}

/**
 * Bytes as base64url, the form JWK and the wire both use.
 *
 * :param bytes: The bytes.
 * :return: The base64url string, unpadded.
 */
export function toBase64Url(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * base64url back to bytes.
 *
 * :param text: The base64url string, padded or not.
 * :return: The bytes.
 */
export function fromBase64Url(text) {
  const normal = String(text).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normal + "=".repeat((4 - (normal.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * The public half of a key, in the exact shape that is published and hashed.
 *
 * Keeping only these four members, in this order, is what makes the kid stable: an
 * exported JWK may carry extra fields (ext, key_ops) that differ between runtimes.
 *
 * :param jwk: An exported public JWK.
 * :return: {kty, crv, x, y}.
 */
export function publicJwkShape(jwk) {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

/**
 * Name a key by its own public material, so the id cannot be mistyped or reused.
 *
 * :param jwk: The public JWK.
 * :return: A promise of the kid, 16 lowercase alphanumeric characters.
 */
export async function kidOf(jwk) {
  const shape = publicJwkShape(jwk);
  const bytes = new TextEncoder().encode(JSON.stringify(shape));
  const digest = await crypto.subtle.digest(HASH, bytes);
  return toBase64Url(digest).replace(/[^a-zA-Z0-9]/g, "").slice(0, 16).toLowerCase();
}

/**
 * Import a private signing key from its JWK.
 *
 * :param jwk: The private JWK, with d.
 * :return: A promise of the CryptoKey.
 */
export function importPrivateKey(jwk) {
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: CURVE }, false, ["sign"]);
}

/**
 * Import a published public key for verification.
 *
 * :param jwk: The public JWK.
 * :return: A promise of the CryptoKey.
 */
export function importPublicKey(jwk) {
  return crypto.subtle.importKey("jwk", publicJwkShape(jwk), { name: "ECDSA", namedCurve: CURVE }, true, ["verify"]);
}

/**
 * Make a fresh key pair. Used to seed a local .env and by the tests, never in production.
 *
 * :return: A promise of {privateJwk, publicJwk}.
 */
export async function generateKeyPair() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: CURVE }, true, ["sign", "verify"]);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = publicJwkShape(await crypto.subtle.exportKey("jwk", pair.publicKey));
  return { privateJwk, publicJwk };
}

/**
 * Sign one receipt's canonical payload.
 *
 * :param key: The imported private CryptoKey.
 * :param receipt: The job or receipt.
 * :return: A promise of the signature, base64url.
 */
export async function signReceipt(key, receipt) {
  const bytes = new TextEncoder().encode(receiptPayload(receipt));
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: HASH }, key, bytes);
  return toBase64Url(signature);
}

/**
 * Verify one receipt against a published key.
 *
 * A malformed signature is a false, not a throw: the page shows "not verified" rather
 * than breaking the whole list because one row is damaged.
 *
 * :param jwk: The published public JWK for the receipt's kid.
 * :param receipt: The receipt as served, with its signature.
 * :return: A promise of true when the signature covers these exact booking facts.
 */
export async function verifyReceipt(jwk, receipt) {
  try {
    if (!receipt || !receipt.signature) return false;
    const key = await importPublicKey(jwk);
    const bytes = new TextEncoder().encode(receiptPayload(receipt));
    return await crypto.subtle.verify({ name: "ECDSA", hash: HASH }, key, fromBase64Url(receipt.signature), bytes);
  } catch {
    return false;
  }
}

export const RECEIPT_ALG = ALG;
export const RECEIPT_SIGNED_FIELDS = SIGNED_FIELDS;