// Keep the shared verification files identical in both sites.
//
// Each site is served from its own root and deploys on its own, so each carries its own
// copy rather than importing across origins: the local server sends CORS only on the
// public bundle files, not on a page's modules. A copy that drifts would let one site
// verify bytes the other never signed, so the copies are made here and a test compares
// them byte for byte.
//
// Run: node sync-shared.mjs        (write the copies)
//      node sync-shared.mjs --check (compare only, exit 1 on drift)
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** The canonical copy's site, and the sites that receive a copy. */
const SOURCE = "courier-site";
const COPIES = ["pizza-site"];
const FILES = ["receipt-crypto.js", "receipt-ledger.js", "receipt-page.js", "receipt-ledger.css"];

const check = process.argv.includes("--check");
let drifted = [];
for (const file of FILES) {
  const canonical = await readFile(path.join(ROOT, SOURCE, file));
  for (const site of COPIES) {
    const target = path.join(ROOT, site, file);
    let current = null;
    try {
      current = await readFile(target);
    } catch {
      current = null;
    }
    if (current && current.equals(canonical)) {
      console.log(`same   ${site}/${file}`);
      continue;
    }
    drifted.push(`${site}/${file}`);
    if (check) {
      console.log(`DRIFT  ${site}/${file}`);
    } else {
      await writeFile(target, canonical);
      console.log(`copied ${site}/${file}`);
    }
  }
}
if (check && drifted.length > 0) {
  console.log("Run: node sync-shared.mjs");
  process.exit(1);
}