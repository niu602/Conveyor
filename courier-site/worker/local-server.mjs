// Run the courier desk on this machine, with the same handler the Worker uses.
//
// The store is mirrored to a JSON file, so a job is still on the desk after a restart or a
// hard kill. The Worker itself is untouched: it uses D1. Pass --port 0 to take any free
// port, which the restart test does; the bound port is printed below.
//
//   node courier-site/worker/local-server.mjs --port 8086
//   node courier-site/worker/local-server.mjs --port 0 --data D:/tmp/desk.json
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { handle } from "./index.js";
import { FileStore } from "./file-store.mjs";
import { seedDemoJob } from "../demo-job.js";

const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 8086;
const dataIndex = args.indexOf("--data");
// Kept under .local/, which .gitignore already excludes: the desk holds visitor details.
const dataFile = dataIndex >= 0 ? args[dataIndex + 1] : fileURLToPath(new URL("../.local/desk.json", import.meta.url));
const store = await FileStore.open(dataFile);
await seedDemoJob(store);

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const request = new Request(`http://localhost:${port}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
  });
  const response = await handle(request, store);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(await response.text());
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Courier desk (local, file-backed) on http://127.0.0.1:${server.address().port}`);
  console.log(`Data: ${dataFile}`);
  console.log("Endpoints: POST /api/quote, POST /api/dispatch/check, POST /api/dispatch,");
  console.log("           GET /api/dispatch/outcome?key=..., GET /api/jobs, GET /api/jobs/:id,");
  console.log("           POST /api/jobs/:id/cancel, POST /api/jobs/:id/advance, GET /api/health");
});
