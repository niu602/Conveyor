// The local desk must survive a restart, including a hard kill.
//
// This starts the real local-server.mjs as a child process, records a run through HTTP,
// kills the process without letting it shut down, and starts it again on the same data
// file. Nothing here is stubbed: if the flush were missing or partial, the job would be
// gone and these assertions would fail.
//
// The Worker is not involved. It uses D1; this file covers the development desk only.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SERVER = fileURLToPath(new URL("../worker/local-server.mjs", import.meta.url));
const CALLER = "http://127.0.0.1:8084";

/**
 * Start the desk on any free port and wait until it says where it is listening.
 *
 * :param dataFile: The file the desk keeps its data in.
 * :return: A promise of the child process and its base URL.
 */
async function startDesk(dataFile) {
  const child = spawn(process.execPath, [SERVER, "--port", "0", "--data", dataFile], { stdio: ["ignore", "pipe", "pipe"] });
  let seen = "";
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The desk did not start. Output so far: ${seen}`)), 20000);
    child.stdout.on("data", (chunk) => {
      seen += chunk;
      const found = /http:\/\/127\.0\.0\.1:(\d+)/.exec(seen);
      if (found) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${found[1]}`);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The desk exited with ${code} before it listened. Output: ${seen}`));
    });
  });
  return { child, base };
}

/**
 * Stop the desk the way a crash does, with no chance to flush on the way out.
 *
 * :param child: The desk's process.
 * :return: A promise of nothing.
 */
function killDesk(child) {
  const ended = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  return ended;
}

/**
 * Call the desk over HTTP as the pizza site would.
 *
 * :param base: The desk's base URL.
 * :param method: The HTTP method.
 * :param path: The endpoint's path.
 * :param body: The JSON body, or null.
 * :return: A promise of the status and the parsed body.
 */
async function call(base, method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: CALLER },
    body: body === null ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("a run recorded on the local desk is still there after the process is killed", { timeout: 90000 }, async () => {
  const local = fileURLToPath(new URL("../.local/", import.meta.url));
  await mkdir(local, { recursive: true });
  const directory = await mkdtemp(join(local, "restart-"));
  const dataFile = join(directory, "desk.json");
  let desk = await startDesk(dataFile);
  try {
    const quoted = await call(desk.base, "POST", "/api/quote", { dropZone: "north", parcelSize: "small", itemCount: 2 });
    assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
    const key = `dispatch:LO-RESTART:${quoted.body.quoteId}`;
    const sent = await call(desk.base, "POST", "/api/dispatch", {
      quoteId: quoted.body.quoteId,
      expectedFeeCents: quoted.body.feeCents,
      dropZone: "north",
      parcelSize: "small",
      itemCount: 2,
      itemSummary: "2x Margherita",
      pizzaOrderRef: "LO-RESTART",
      idempotencyKey: key,
      customerName: "Test Recipient",
      phone: "555-0188",
      address: "1 Test Quay, Marrow Point",
      note: "",
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const jobId = sent.body.jobId;

    await killDesk(desk.child);
    desk = await startDesk(dataFile);

    // The run itself, read by its number.
    const read = await call(desk.base, "GET", `/api/jobs/${jobId}`, null);
    assert.equal(read.status, 200, "The job did not survive the kill.");
    assert.equal(read.body.jobId, jobId);
    assert.equal(read.body.status, "assigned");
    assert.equal(read.body.feeCents, quoted.body.feeCents);
    assert.equal(read.body.events[0].type, "assigned", "The job's events did not survive.");

    // The reference still names it, so a replay after the restart cannot make a second run.
    const settled = await call(desk.base, "GET", `/api/dispatch/outcome?key=${encodeURIComponent(key)}`, null);
    assert.equal(settled.body.recorded, true);
    assert.equal(settled.body.jobId, jobId);

    // The quote survived too, so the same reference replays instead of writing again.
    const again = await call(desk.base, "POST", "/api/dispatch", {
      quoteId: quoted.body.quoteId,
      expectedFeeCents: quoted.body.feeCents,
      dropZone: "north",
      parcelSize: "small",
      itemCount: 2,
      pizzaOrderRef: "LO-RESTART",
      idempotencyKey: key,
      customerName: "Test Recipient",
      phone: "555-0188",
      address: "1 Test Quay, Marrow Point",
      note: "",
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.jobId, jobId);

    const list = await call(desk.base, "GET", "/api/jobs?limit=50", null);
    assert.equal(list.body.jobs.length, 2, "Expected the demo job and the one run, no duplicates.");
    assert.equal(list.body.jobs.filter((job) => job.jobId === "J-DEMO-1").length, 1, "The demo job was seeded twice.");
    // Nothing written to disk may reach a receipt.
    assert.equal(JSON.stringify(list.body).includes("555-0188"), false);
  } finally {
    await killDesk(desk.child);
    await rm(directory, { recursive: true, force: true });
  }
});

test("the demo job the desk seeds belongs to nobody", async () => {
  const { MemoryStore } = await import("../courier-desk.js");
  const { seedDemoJob } = await import("../demo-job.js");
  const store = new MemoryStore();
  await seedDemoJob(store);
  const demo = await store.getJob("J-DEMO-1");
  assert.equal(demo.customerName, "Demo Recipient");
  // 555-01xx is the range reserved for fiction, so no real subscriber can be dialled.
  assert.match(demo.phone, /^555-01\d\d$/);
  assert.match(demo.address, /Demo Quay/);
  assert.equal(await seedDemoJob(store), null, "Seeding twice must not make a second demo job.");
});