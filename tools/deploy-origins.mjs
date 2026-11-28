// The production origin switch, as a mechanism rather than a list of TODOs.
//
// Missing one of these is not a cosmetic bug: the intake's allow-list would refuse the
// deployed page, the preflight would get no Access-Control-Allow-Origin, and the write
// path would be dead online while every local test still passed. So the switch is one
// file (deploy.json) plus this script, and --check exits non-zero while any local origin
// survives in a file that ships.
//
//   node tools/deploy-origins.mjs            check, and say what is left
//   node tools/deploy-origins.mjs --apply    rewrite the mechanical set from deploy.json
//
// After --apply: node sync-shared.mjs (the ledger copy), then rebuild the pizza network
// (the HOCON and manifest are not touched here), then --check again.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// DEPLOY_ROOT and DEPLOY_CONFIG let a test drive this against a throwaway copy, so the
// guard itself is tested rather than trusted.
const ROOT = process.env.DEPLOY_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = process.env.DEPLOY_CONFIG || path.join(ROOT, "deploy.json");
const LOCAL = /https?:\/\/(?:localhost|127\.0\.0\.1):\d+/g;

/**
 * Files whose local origins this script can rewrite exactly.
 *
 * Each entry names the old literal and which deploy.json origin replaces it. Only whole
 * string literals are replaced, so a comment or a sentence is never rewritten by accident.
 */
const MECHANICAL = [
  { file: "courier-site/worker/index.js", swaps: [["http://localhost:8085", "courier"], ["http://127.0.0.1:8084", "pizza"]] },
  { file: "courier-site/desk-client.js", swaps: [["http://127.0.0.1:8086", "desk"]] },
  { file: "courier-site/receipt-ledger.js", swaps: [["http://127.0.0.1:8086", "desk"]] },
  { file: "courier-site/bridge/bridge-actions.js", swaps: [["http://127.0.0.1:8084", "pizza"]] },
  { file: "courier-site/bridge/dispatch-window.js", swaps: [["http://127.0.0.1:8084", "pizza"]] },
  { file: "courier-site/index.html", swaps: [["http://127.0.0.1:8084", "pizza"]] },
  { file: "pizza-site/index.html", swaps: [["http://localhost:8085", "courier"]] },
];

/** Files that need a rebuild or a decision, so this script only reports them. */
const MANUAL = [
  { file: "pizza-site/agent-manifest.json", why: "allowed_peers. Edit, then rebuild the network." },
  { file: "pizza-site/little_oven_pizza.hocon", why: "partner tools and link_labels. Edit, then rebuild the network." },
  { file: "pizza-site/bridge/bridge-actions.js", why: "caller origins of the two unhosted example partners. Decision pending." },
  { file: "pizza-site/bridge/order-window.js", why: "caller origin of the unhosted guesthouse example. Decision pending." },
];

/** Never deployed, so a local origin here is correct. */
const DEV_ONLY = [
  { file: "courier-site/worker/llm-proxy.mjs", why: "dev-only reverse proxy; the Worker has no such route." },
];

/** Documentation: must be updated for the submission, but nothing breaks if it lags. */
const DOCS = ["README.md", "courier-site/README.md", "pizza-site/README.md"];

const config = JSON.parse(await readFile(CONFIG, "utf8"));
const apply = process.argv.includes("--apply");

/**
 * Read a file, or return null when it is absent.
 *
 * :param file: The path relative to the repository root.
 * :return: A promise of the text, or null.
 */
async function read(file) {
  try {
    return await readFile(path.join(ROOT, file), "utf8");
  } catch {
    return null;
  }
}

/**
 * The local origins a file still contains, with line numbers.
 *
 * :param text: The file's text.
 * :return: An array of {line, text}.
 */
function localLines(text) {
  const found = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.match(LOCAL)) found.push({ line: index + 1, text: line.trim() });
  });
  return found;
}

const placeholders = Object.entries(config.origins).filter(([, value]) => !value || String(value).startsWith("REPLACE_"));

if (apply) {
  if (placeholders.length > 0) {
    console.log("Refusing to apply: deploy.json still has placeholders:");
    for (const [name] of placeholders) console.log(`  origins.${name}`);
    process.exit(1);
  }
  for (const entry of MECHANICAL) {
    const text = await read(entry.file);
    if (text === null) {
      console.log(`MISSING ${entry.file}`);
      continue;
    }
    let next = text;
    for (const [old, key] of entry.swaps) next = next.split(old).join(config.origins[key]);
    if (next === text) {
      console.log(`already ${entry.file}`);
    } else {
      await writeFile(path.join(ROOT, entry.file), next);
      console.log(`switched ${entry.file}`);
    }
  }
  console.log("\nNext: node sync-shared.mjs, then rebuild the pizza network, then --check.");
  process.exit(0);
}

let blocking = 0;
console.log("=== mechanical set (node tools/deploy-origins.mjs --apply) ===");
for (const entry of MECHANICAL) {
  const text = await read(entry.file);
  const hits = text === null ? [] : localLines(text);
  if (hits.length === 0) {
    console.log(`  clean   ${entry.file}`);
  } else {
    blocking += hits.length;
    console.log(`  LOCAL   ${entry.file}`);
    for (const hit of hits) console.log(`            ${hit.line}: ${hit.text}`);
  }
}

console.log("\n=== needs a rebuild or a decision (not rewritten here) ===");
for (const entry of MANUAL) {
  const text = await read(entry.file);
  const hits = text === null ? [] : localLines(text);
  if (hits.length === 0) {
    console.log(`  clean   ${entry.file}`);
  } else {
    blocking += hits.length;
    console.log(`  LOCAL   ${entry.file} — ${entry.why}`);
    for (const hit of hits) console.log(`            ${hit.line}: ${hit.text}`);
  }
}

console.log("\n=== dev-only, correct as it is ===");
for (const entry of DEV_ONLY) console.log(`  skipped ${entry.file} — ${entry.why}`);

console.log("\n=== documentation, update before submitting ===");
for (const file of DOCS) {
  const text = await read(file);
  const hits = text === null ? [] : localLines(text);
  console.log(`  ${hits.length === 0 ? "clean" : `${hits.length} local`}  ${file}`);
}

console.log("\n=== deploy.json ===");
for (const [name, value] of Object.entries(config.origins)) {
  console.log(`  ${String(value).startsWith("REPLACE_") ? "UNSET" : "set  "} origins.${name} = ${value}`);
}
for (const [name, value] of Object.entries(config.partners || {})) {
  if (value === null) {
    blocking += 1;
    console.log(`  UNDECIDED partners.${name} — host it or drop it from the production network`);
  } else {
    console.log(`  set   partners.${name} = ${value}`);
  }
}

if (placeholders.length > 0 || blocking > 0) {
  console.log(`\nNOT READY: ${blocking} local or undecided item(s), ${placeholders.length} unset origin(s).`);
  process.exit(1);
}
console.log("\nREADY: no local origin survives in anything that ships.");