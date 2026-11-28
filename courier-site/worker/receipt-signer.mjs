// The desk's signing key, loaded from its environment and nowhere else.
//
// Plan b, settled 2026-11-25: locally the private JWK comes from RECEIPT_PRIVATE_KEY in
// .env (git-ignored); in M3 the same value arrives as a wrangler secret and this file does
// not change. Tests pass a throwaway pair. Nothing here writes a key to disk or to a log.
//
// Rotation: the active key signs new receipts, and retired public keys stay published so
// receipts signed before a rotation still verify. Each receipt carries its own kid, so a
// verifier picks the right key per row rather than assuming the newest one.
import { importPrivateKey, kidOf, publicJwkShape, signReceipt, RECEIPT_ALG } from "../receipt-crypto.js";

/**
 * Build a signer from key material.
 *
 * :param options: privateJwk (the active private key) and retiredPublicJwks (older ones).
 * :return: A promise of the signer, or null when no private key is configured.
 */
export async function createSigner({ privateJwk, retiredPublicJwks = [] } = {}) {
  if (!privateJwk || !privateJwk.d) return null;
  const key = await importPrivateKey(privateJwk);
  const publicJwk = publicJwkShape(privateJwk);
  const kid = await kidOf(publicJwk);
  const published = [{ kid, alg: RECEIPT_ALG, ...publicJwk }];
  for (const old of retiredPublicJwks) {
    if (!old || !old.x || !old.y) continue;
    const shape = publicJwkShape(old);
    const oldKid = await kidOf(shape);
    if (oldKid === kid) continue;
    published.push({ kid: oldKid, alg: RECEIPT_ALG, ...shape });
  }
  return {
    kid,
    alg: RECEIPT_ALG,
    /**
     * :param receipt: The job being recorded.
     * :return: A promise of {kid, alg, signature}.
     */
    async sign(receipt) {
      return { kid, alg: RECEIPT_ALG, signature: await signReceipt(key, receipt) };
    },
    /**
     * :return: The published keys, active first. Never contains d.
     */
    publicKeys() {
      return published.map((entry) => ({ ...entry }));
    },
  };
}

/**
 * Read the signing material from an environment object.
 *
 * A malformed value is treated as "no key": the desk then serves unsigned receipts rather
 * than refusing to take deliveries. The reason is logged without echoing the value.
 *
 * :param env: process.env locally, the Worker bindings in M3.
 * :return: A promise of the signer, or null.
 */
export async function signerFromEnv(env = {}) {
  const raw = String(env.RECEIPT_PRIVATE_KEY || "").trim();
  if (!raw) return null;
  let privateJwk;
  try {
    privateJwk = JSON.parse(raw);
  } catch {
    console.log("Receipt signing is off: RECEIPT_PRIVATE_KEY is not JSON.");
    return null;
  }
  let retired = [];
  try {
    const parsed = JSON.parse(String(env.RECEIPT_RETIRED_PUBLIC_KEYS || "[]"));
    if (Array.isArray(parsed)) retired = parsed;
  } catch {
    console.log("Ignoring RECEIPT_RETIRED_PUBLIC_KEYS: not a JSON array.");
  }
  try {
    return await createSigner({ privateJwk, retiredPublicJwks: retired });
  } catch {
    console.log("Receipt signing is off: RECEIPT_PRIVATE_KEY is not a P-256 private JWK.");
    return null;
  }
}