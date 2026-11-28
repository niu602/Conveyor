// The deploy-day origin switch. This guard is what stops a half-switched site from
// shipping, so the guard itself is tested here, on a throwaway copy.
// Run: node --test "D:/Conveyor/courier-site/tests/*.test.mjs"
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "deploy-origins.mjs");

/** The files the switch rewrites, with the local literals they carry today. */
const SEED = {
  "courier-site/worker/index.js": 'export const ALLOWED_ORIGINS = [\n  "http://localhost:8085",\n  "http://127.0.0.1:8084",\n];\n',
  "courier-site/desk-client.js": 'static LOCAL_BASE = "http://127.0.0.1:8086";\n',
  "courier-site/receipt-ledger.js": 'export const LEDGER_DESK_BASE = "http://127.0.0.1:8086";\n',
  "courier-site/bridge/bridge-actions.js": 'const CALLERS = ["http://127.0.0.1:8084"];\n',
  "courier-site/bridge/dispatch-window.js": 'const CALLERS = ["http://127.0.0.1:8084"];\n',
  "courier-site/index.html": '<a id="pizza-link" href="http://127.0.0.1:8084/">Little Oven Pizza</a>\n',
  "pizza-site/index.html": '<a href="http://localhost:8085/">Conveyor Courier</a>\n',
};

/**
 * A throwaway repository with the mechanical files and a deploy.json.
 *
 * :param origins: The origins to put in the config.
 * :return: A promise of {root, config, run, cleanup}.
 */
async function sandbox(origins) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-deploy-"));
  for (const [file, text] of Object.entries(SEED)) {
    const full = path.join(root, file);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, text);
  }
  const config = path.join(root, "deploy.json");
  await writeFile(config, JSON.stringify({ origins, partners: { guesthouse: "https://g.example", harborTours: "https://h.example" } }));
  return {
    root,
    config,
    /**
     * :param args: Arguments for the script.
     * :return: The exit code and the output.
     */
    run(args = []) {
      const done = spawnSync(process.execPath, [SCRIPT, ...args], {
        encoding: "utf8",
        env: { ...process.env, DEPLOY_ROOT: root, DEPLOY_CONFIG: config },
      });
      return { code: done.status, out: `${done.stdout}${done.stderr}` };
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("the check fails while any local origin survives, and says which file and line", async () => {
  const box = await sandbox({
    pizza: "REPLACE_WITH_PIZZA_PAGES_ORIGIN",
    courier: "REPLACE_WITH_COURIER_PAGES_ORIGIN",
    desk: "REPLACE_WITH_DESK_WORKER_ORIGIN",
  });
  try {
    const done = box.run();
    assert.equal(done.code, 1, "A site still on localhost must not read as ready.");
    assert.match(done.out, /NOT READY/);
    assert.match(done.out, /courier-site\/worker\/index\.js/);
    assert.match(done.out, /2: "http:\/\/localhost:8085"/);
    assert.match(done.out, /UNSET origins\.pizza/);
    // The dev-only proxy is correct on localhost and must not be reported as a problem.
    assert.match(done.out, /skipped courier-site\/worker\/llm-proxy\.mjs/);
  } finally {
    await box.cleanup();
  }
});

test("apply refuses to run on a half-filled config, and writes nothing", async () => {
  const box = await sandbox({
    pizza: "https://pizza.example",
    courier: "REPLACE_WITH_COURIER_PAGES_ORIGIN",
    desk: "https://desk.example",
  });
  try {
    const done = box.run(["--apply"]);
    assert.equal(done.code, 1);
    assert.match(done.out, /Refusing to apply/);
    assert.match(done.out, /origins\.courier/);
    const untouched = await readFile(path.join(box.root, "courier-site/worker/index.js"), "utf8");
    assert.match(untouched, /http:\/\/localhost:8085/, "A refused apply must not have written anything.");
  } finally {
    await box.cleanup();
  }
});

test("a full config switches every mechanical file and the check then passes", async () => {
  const box = await sandbox({
    pizza: "https://pizza.pages.dev",
    courier: "https://courier.pages.dev",
    desk: "https://desk.workers.dev",
  });
  try {
    const applied = box.run(["--apply"]);
    assert.equal(applied.code, 0, applied.out);
    const intake = await readFile(path.join(box.root, "courier-site/worker/index.js"), "utf8");
    assert.match(intake, /https:\/\/courier\.pages\.dev/);
    assert.match(intake, /https:\/\/pizza\.pages\.dev/);
    assert.doesNotMatch(intake, /localhost|127\.0\.0\.1/);
    // The desk's own origin, not the courier page's: mixing these would break every read.
    const client = await readFile(path.join(box.root, "courier-site/desk-client.js"), "utf8");
    assert.match(client, /https:\/\/desk\.workers\.dev/);
    const ledger = await readFile(path.join(box.root, "courier-site/receipt-ledger.js"), "utf8");
    assert.match(ledger, /https:\/\/desk\.workers\.dev/);
    // A page link keeps its trailing slash and its surrounding markup.
    const page = await readFile(path.join(box.root, "courier-site/index.html"), "utf8");
    assert.match(page, /href="https:\/\/pizza\.pages\.dev\/"/);

    const checked = box.run();
    assert.equal(checked.code, 0, checked.out);
    assert.match(checked.out, /READY/);
    // Applying twice changes nothing.
    const again = box.run(["--apply"]);
    assert.equal(again.code, 0);
    assert.match(again.out, /already courier-site\/worker\/index\.js/);
  } finally {
    await box.cleanup();
  }
});

test("an undecided partner blocks the check even when every origin is set", async () => {
  const box = await sandbox({
    pizza: "https://pizza.pages.dev",
    courier: "https://courier.pages.dev",
    desk: "https://desk.workers.dev",
  });
  try {
    await writeFile(box.config, JSON.stringify({
      origins: { pizza: "https://pizza.pages.dev", courier: "https://courier.pages.dev", desk: "https://desk.workers.dev" },
      partners: { guesthouse: null, harborTours: "https://h.example" },
    }));
    const done = box.run();
    assert.equal(done.code, 1);
    assert.match(done.out, /UNDECIDED partners\.guesthouse/);
  } finally {
    await box.cleanup();
  }
});