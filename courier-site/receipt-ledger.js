// The reconciliation ledger: read the desk's receipts and verify each one in this page.
//
// This file is shared by both sites. courier-site holds the canonical copy; pizza-site
// holds a byte-identical one, kept in step by sync-shared.mjs and checked by a test. Each
// site stays self-contained, which is what lets the two deploy as separate static sites.
//
// Verification happens here, in the visitor's browser, against the public key the desk
// publishes. It is deliberately not an agent action: a model must not be able to say a
// receipt is verified. The page does the arithmetic and shows what it found.
//
// Four outcomes, kept apart on purpose:
//   verified   — the signature covers these exact booking facts
//   changed    — a signature is present but does not match: do not trust this row
//   no-key     — the receipt names a key the desk does not publish
//   unsigned   — no signature at all, as issued before the desk held a signing key
// An unreachable desk or key channel is reported as an error, never as a verdict.
import { verifyReceipt } from "./receipt-crypto.js";

/**
 * Where the desk's intake runs on this machine.
 *
 * TODO(M3): point this at the deployed Worker before hosting, together with the intake's
 * own origin allow-list. The public key channel answers any origin; the job list does not.
 */
export const LEDGER_DESK_BASE = "http://127.0.0.1:8086";

/**
 * What each verdict says on the page.
 */
export const VERDICTS = {
  verified: { label: "Verified", note: "The signature covers this job, parcel and fee." },
  changed: { label: "Does not match", note: "The signature does not cover what this row says. Do not trust it." },
  "no-key": { label: "Key not published", note: "The desk does not publish the key this receipt names." },
  unsigned: { label: "Not signed", note: "Issued before the desk held a signing key." },
};

/**
 * Read the desk's public keys.
 *
 * :param options: base (the intake's origin) and fetchImpl (for tests).
 * :return: A promise of a Map from kid to the published public JWK.
 * :raises Error: When the channel cannot be read, so no row is judged without a key.
 */
export async function readPublicKeys({ base = LEDGER_DESK_BASE, fetchImpl } = {}) {
  const send = fetchImpl || ((...args) => fetch(...args));
  const response = await send(`${base}/api/pubkey`, { credentials: "omit" });
  if (!response.ok) throw new Error(`The key channel answered ${response.status}.`);
  const body = await response.json();
  const keys = new Map();
  for (const entry of body.keys || []) keys.set(entry.kid, entry);
  return keys;
}

/**
 * Judge one receipt against the published keys.
 *
 * :param receipt: The receipt as the desk served it.
 * :param keys: The Map from readPublicKeys.
 * :return: A promise of {verdict, kid}.
 */
export async function checkReceipt(receipt, keys) {
  if (!receipt || !receipt.signature) return { verdict: "unsigned", kid: "" };
  const key = keys.get(receipt.kid);
  if (!key) return { verdict: "no-key", kid: receipt.kid || "" };
  const ok = await verifyReceipt(key, receipt);
  return { verdict: ok ? "verified" : "changed", kid: receipt.kid || "" };
}

/**
 * Read the receipts and verify every one of them.
 *
 * :param options: base, limit and fetchImpl.
 * :return: A promise of {rows, keys, counts} or {error}.
 */
export async function readLedger({ base = LEDGER_DESK_BASE, limit = 20, fetchImpl } = {}) {
  const send = fetchImpl || ((...args) => fetch(...args));
  let keys;
  let jobs;
  try {
    keys = await readPublicKeys({ base, fetchImpl: send });
    const response = await send(`${base}/api/jobs?limit=${limit}`, { credentials: "omit" });
    if (!response.ok) throw new Error(`The desk answered ${response.status}.`);
    jobs = (await response.json()).jobs || [];
  } catch (error) {
    return { error: `The desk could not be read: ${error && error.message || error}` };
  }
  const rows = [];
  const counts = { verified: 0, changed: 0, "no-key": 0, unsigned: 0 };
  for (const receipt of jobs) {
    const checked = await checkReceipt(receipt, keys);
    counts[checked.verdict] += 1;
    rows.push({ receipt, ...checked });
  }
  return { rows, keys, counts };
}

/**
 * Show what a changed amount does to a receipt, without writing anything anywhere.
 *
 * This is a local what-if on a copy, labelled as such on the page. It is the cheapest way
 * for a visitor to see that the signature really binds the fee rather than merely exist.
 *
 * :param receipt: The receipt as served.
 * :param keys: The published keys.
 * :return: A promise of the verdict for the same receipt with one cent added.
 */
export async function tamperCheck(receipt, keys) {
  return checkReceipt({ ...receipt, feeCents: Number(receipt.feeCents) + 1 }, keys);
}

/**
 * Draw the ledger into a container.
 *
 * :param root: The element to fill.
 * :param ledger: What readLedger returned.
 * :param options: onTamper, called with a row when its what-if button is pressed.
 * :return: Nothing.
 */
export function renderLedger(root, ledger, options = {}) {
  root.replaceChildren();
  if (ledger.error) {
    const note = document.createElement("p");
    note.className = "ledger-error";
    note.setAttribute("role", "alert");
    note.textContent = ledger.error;
    root.append(note);
    return;
  }
  const { rows, keys, counts } = ledger;
  const summary = document.createElement("p");
  summary.className = "ledger-summary";
  summary.setAttribute("role", "status");
  summary.textContent = rows.length === 0
    ? "The desk holds no jobs yet."
    : `${counts.verified} verified of ${rows.length} · ${counts.unsigned} not signed · ${counts.changed} not matching · ${counts["no-key"]} with an unpublished key`;
  root.append(summary);

  const keyLine = document.createElement("p");
  keyLine.className = "ledger-keys";
  keyLine.textContent = keys.size === 0
    ? "The desk publishes no signing key, so no receipt can be verified here."
    : `Signing keys published by the desk: ${[...keys.keys()].join(", ")}`;
  root.append(keyLine);

  if (rows.length === 0) return;
  const table = document.createElement("table");
  table.className = "ledger-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const title of ["Job number", "Order reference", "Fee", "Recorded at", "Key", "Signature"]) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = title;
    headRow.append(cell);
  }
  head.append(headRow);
  table.append(head);

  const body = document.createElement("tbody");
  for (const row of rows) {
    const line = document.createElement("tr");
    line.dataset.verdict = row.verdict;
    line.dataset.jobId = row.receipt.jobId;
    for (const value of [
      row.receipt.jobId,
      row.receipt.pizzaOrderRef || "—",
      feeText(row.receipt.feeCents),
      row.receipt.createdAt,
      row.kid || "—",
    ]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      line.append(cell);
    }
    const verdict = document.createElement("td");
    const badge = document.createElement("strong");
    badge.className = `ledger-verdict ledger-${row.verdict}`;
    badge.textContent = VERDICTS[row.verdict].label;
    const note = document.createElement("span");
    note.className = "ledger-note";
    note.textContent = VERDICTS[row.verdict].note;
    verdict.append(badge, note);
    if (row.verdict === "verified" && options.onTamper) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ledger-tamper";
      button.textContent = "Test a changed amount";
      button.addEventListener("click", () => options.onTamper(row, button));
      verdict.append(button);
    }
    line.append(verdict);
    body.append(line);
  }
  table.append(body);
  root.append(table);

  const privacy = document.createElement("p");
  privacy.className = "ledger-privacy";
  privacy.textContent = "A receipt carries the booking only. The recipient's name, phone and address stay on the desk and never appear here.";
  root.append(privacy);
}

/**
 * An amount in cents as the page writes it.
 *
 * :param cents: The fee.
 * :return: The text, such as $4.50.
 */
function feeText(cents) {
  const value = Number(cents);
  if (!Number.isFinite(value)) return "—";
  return `$${(value / 100).toFixed(2)}`;
}