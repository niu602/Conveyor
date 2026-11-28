// Mount the reconciliation ledger on the page. Shared by both sites, byte for byte.
//
// The page reads the desk itself, with no model involved: verification is something the
// visitor's browser computes, not something an assistant can assert. If the desk cannot
// be reached the section says so, and the rest of the page keeps working.
import { readLedger, renderLedger, tamperCheck } from "./receipt-ledger.js";

const root = document.getElementById("receipts-ledger");
const refresh = document.getElementById("refresh-receipts");

if (root) {
  let latest = null;

  /**
   * Read the desk and draw what it holds.
   *
   * :return: A promise of nothing.
   */
  async function load() {
    root.replaceChildren(Object.assign(document.createElement("p"), {
      className: "ledger-summary",
      textContent: "Reading the desk and verifying each receipt…",
    }));
    if (refresh) refresh.disabled = true;
    latest = await readLedger({ limit: 20 });
    renderLedger(root, latest, { onTamper });
    if (refresh) refresh.disabled = false;
  }

  /**
   * Show, on a copy, what one cent more would do to this receipt's signature.
   *
   * Nothing is sent to the desk and no row is changed: the answer is computed here and
   * labelled as a local what-if, so it can never be mistaken for the desk's own data.
   *
   * :param row: The verified row whose button was pressed.
   * :param button: The button to replace with the answer.
   * :return: A promise of nothing.
   */
  async function onTamper(row, button) {
    button.disabled = true;
    const answer = await tamperCheck(row.receipt, latest.keys);
    const note = document.createElement("span");
    note.className = "ledger-tamper-result";
    note.textContent = answer.verdict === "changed"
      ? "Local check, nothing sent: with one cent added, this signature does not match."
      : `Local check, nothing sent: with one cent added the verdict was ${answer.verdict}.`;
    button.replaceWith(note);
  }

  if (refresh) refresh.addEventListener("click", load);
  load();
}