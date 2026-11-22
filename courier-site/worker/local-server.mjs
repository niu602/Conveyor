// Run the courier desk on this machine, with the same handler the Worker uses.
//
// It keeps the store in memory, so a restart clears it. That is enough for the M1
// browser run and for the failure drills; the deployed desk uses D1 instead.
//
//   node courier-site/worker/local-server.mjs --port 8086
import { createServer } from "node:http";
import { handle } from "./index.js";
import { MemoryStore } from "../courier-desk.js";
import { seedDemoJob } from "../demo-job.js";

const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 8086;
const store = new MemoryStore();
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
  console.log(`Courier desk (local, in-memory) on http://127.0.0.1:${port}`);
  console.log("Endpoints: POST /api/quote, POST /api/dispatch, GET /api/jobs, GET /api/jobs/:id,");
  console.log("           POST /api/jobs/:id/cancel, POST /api/jobs/:id/advance, GET /api/health");
});
