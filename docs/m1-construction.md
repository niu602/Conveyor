# M1 construction list — "one needle"

Scope: 2026-11-25 → 11-29. Goal is the red line from the plan: a **real browser** run of

```text
pizza agent → handoff to courier network (peer loading + consent card)
→ bridge read get_quote (hidden frame on courier origin)
→ bridge write confirm_dispatch (opens the courier's own window)
→ visitor confirms → same-origin Worker + D1 records the job idempotently
→ receipt returns to the pizza chat
```

One-way write. Reverse information only through a read-only `job_status` lookup.
Nothing here is M2 work: no signed receipts, no reconciliation page, no sealed bids.

## 0. Local topology (decided, do not drift)

| Site | Role | Local origin | Network name | Network URL for the partner |
| --- | --- | --- | --- | --- |
| `pizza-site/` | caller | `http://127.0.0.1:8084` | `little_oven_pizza` | — |
| `courier-site/` | callee | `http://localhost:8085` | `courier_dispatch` | `http://localhost:8085/courier_dispatch` |

Two different host names on purpose: on loopback the runtime mirrors the BYOK key into a
host cookie, and a partner on the same host name would receive it. Port 8080 is occupied
on this machine (`ApplicationWebServer`), so 8084/8085 keep the flow runnable.

Cross-wired constants:

- `pizza-site/agent-manifest.json` → `allowed_peers: ["http://localhost:8085"]`,
  `peer_policy.note` names the courier.
- `pizza-site/little_oven_pizza.hocon` → `tools` contains
  `"http://localhost:8085/courier_dispatch"`; `link_labels` maps that exact URL to
  `"Conveyor Courier"`; one "How to work" line for the courier tool.
- `courier-site/bridge/bridge-actions.js` → `callerOrigins: ["http://127.0.0.1:8084"]` on
  both shared actions (never `"*"` for the write).

Before hosting, only these three strings change to the https URLs (plus the tool name
derived from the URL path); the build prints the reminder.

## 1. `courier-site/` — file list

Copied from the skill templates, then filled:

```text
courier-site/
  index.html                  dispatch desk: quote form, job list, status lookup, cancel
  styles.css                  site styles + assistant.css
  script.js                   App + App.page: getState, requestQuote, listJobs,
                              lookupJob, cancelJob  (buttons/forms call the same methods)
  site-actions.js             local page actions (see §2)
  site.js                     boot + GREETING + DIALOGS for irreversible actions
  courier_dispatch.hocon      network: one front agent `courier_desk_agent`
  agent-manifest.json         actions, allowed_peers (pizza origin), llm_router, theme
  links.json
  runtime/                    copied byte-for-byte from the skill, never edited
  bridge/
    bridge-actions.js         get_quote (read) + confirm_dispatch (registered write, §3)
    dispatch-window.js        confirm_dispatch implementation, own window, §3
    action-bridge.html        written by the build — do not touch
    agent-manifest.json       written by the build — do not touch
  tests/                      from templates/tests/, filled (see §5)
  worker/
    src/index.js              Worker: /api/quote, /api/dispatch, /api/jobs*, /api/health
    schema.sql                D1 tables (§4)
    wrangler.toml             name, d1 binding, dev port 8086
    README.md                 how to run locally and deploy
  README.md                   run command, files, limits, "changes from templates"
```

Network shape: **one** front agent (no specialist — separate system/knowledge/workflow
tests all fail). Its tools: the local `website_*` page actions, plus nothing else in M1.
Sample queries must include one the site cannot do ("Can you deliver to another city
today?" → declines).

## 2. Local page actions (`site-actions.js`, `availability` omitted = local-only)

| Action | Effect | Input → output |
| --- | --- | --- |
| `get_dispatch_state` | read | `{}` → today, zone table with fees, job list summary, latest job, page facts (hours, cancellation rule, courier address) |
| `request_quote` | read | `{dropZone, parcelSize, itemCount}` → `{quoteId, feeCents, feeText, etaMinutes, expiresAt, basis}` — calls Worker, changes nothing on the page |
| `confirm_dispatch` | irreversible | `{quoteId, expectedFeeCents, pizzaOrderRef, itemSummary, dropZone, parcelSize, customerName, phone, address, note, expectedQuoteId}` → receipt `{jobId, status, feeCents, etaMinutes, acceptedAt}` |
| `cancel_job` | irreversible | `{jobId, expectedStatus}` → `{jobId, status:"cancelled", cancelledAt}`; refuses after pickup |

Rules that must live in `script.js`, not in the actions module: zone/fee table, expiry of
quotes, cancellation eligibility. Every operation refuses by returning
`{ok:false, reason, field}` before changing anything. `confirm_dispatch` takes an
`expectedQuoteId` (the page's quote version) so a visitor never confirms one price and
gets another; the read returns the current one every turn.

## 3. Bridge contract (the needle)

`bridge/bridge-actions.js` registers exactly:

**`get_quote` — read, `availability:"bridge"`, `callerOrigins:["http://127.0.0.1:8084"]`**

```json
input:  { "dropZone": "north|harbor|old_town|outside",
          "parcelSize": "small|medium|large",
          "itemCount": 1..99 }
output: { "ok": true, "quoteId": "...", "feeCents": 450, "feeText": "$4.50",
          "etaMinutes": 18, "expiresAt": "2026-11-25T18:30:00Z" }
```

Implementation: `fetch("<origin>/api/quote", POST, credentials:"omit")`. Reads nothing
from the frame (the bridge frame has no page). Refuses `outside` with a reason.

**`confirm_dispatch` — irreversible, `availability:"bridge"`, `callerOrigins:["http://127.0.0.1:8084"]`, `confirmsInWindow:true`**

```json
input:  { "quoteId": "...", "expectedFeeCents": 450,
          "pizzaOrderRef": "LO-20261125-0007",
          "itemSummary": "2x Margherita, 1x Pepperoni",
          "dropZone": "north", "parcelSize": "medium" }
```

No names, phones or addresses in the call — those are typed only into the courier's
window. `execute` first re-checks the quote with the Worker; a refusal returns the site's
reason before any form. Otherwise it renders the window: what is being delivered, the
fee, ETA, fields (name, phone, address, note), a confirm button labelled
**"Dispatch this order"**, and Cancel. On confirm it POSTs `/api/dispatch` with an
`idempotencyKey` generated once when the window opens (`crypto.randomUUID()`), reused on
every retry in that window. Returns only the receipt — never the typed details.

Failure branches that must exist in M1 (even if minimal): quote expired → refusal with a
"request a new quote" reason; fee changed → `409 quote_changed`, ask again; network
failure on confirm → result `unknown`, explicitly "do not retry, check job status".

## 4. Worker — minimal interface (`worker/src/index.js`)

CORS: `Access-Control-Allow-Origin` only for the courier origin and
`http://127.0.0.1:8084` (pizza), never `*` on business endpoints. JSON only.

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| `POST` | `/api/quote` | `{dropZone, parcelSize, itemCount}` | `200 {quoteId, feeCents, etaMinutes, expiresAt, basis:{zone,size,base,perItem}}`; `400` bad zone/size; `422` `{ok:false,reason:"outside service area"}` |
| `POST` | `/api/dispatch` | `{quoteId, expectedFeeCents, pizzaOrderRef, dropZone, parcelSize, customerName, phone, address, note, idempotencyKey}` | `201 {jobId, receiptId, status:"assigned", feeCents, etaMinutes, acceptedAt}`; `409 {code:"quote_changed", currentFeeCents}`; `410 {code:"quote_expired"}`; replay of the same `idempotencyKey` returns the first receipt with `replayed:true`, never a second job |
| `GET` | `/api/jobs/{jobId}` | — | `200 {jobId, status, feeCents, etaMinutes, acceptedAt, updatedAt, events:[{type,at}]}`; `404` |
| `GET` | `/api/jobs?limit=20` | — | `200 {jobs:[…]}` (server-side only; the page calls it) |
| `POST` | `/api/jobs/{jobId}/cancel` | `{expectedStatus}` | `200 {jobId,status:"cancelled"}`; `409` after pickup; `404` |
| `GET` | `/api/health` | — | `200 {ok:true, now}` |

Idempotency: `UNIQUE(idempotency_key)` on `jobs`; insert-then-read inside a batch so a
double-submit gets the first row back. Idempotency is a property of the intake endpoint,
not of the agent.

### D1 schema (`worker/schema.sql`)

```sql
CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY, payload TEXT NOT NULL, fee_cents INTEGER NOT NULL,
  eta_minutes INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, quote_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
  pizza_order_ref TEXT, item_summary TEXT, drop_zone TEXT, parcel_size TEXT,
  customer_name TEXT, phone TEXT, address TEXT, note TEXT,
  fee_cents INTEGER NOT NULL, eta_minutes INTEGER NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL,
  type TEXT NOT NULL, at TEXT NOT NULL, detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_key ON jobs(idempotency_key);
```

Privacy: `jobs` holds the visitor's details because the courier needs them to deliver;
they never appear in a bridge call, a network request, a receipt or a public file. The
page's `lookup_job` requires the job id, and the list endpoint is not exposed through any
`website_*` tool.

## 5. Tests to write in M1

`courier-site/tests/` (from `templates/tests/`, keep every template case):

- every `agentTools` name is registered and local-only, or shared by the bridge with the
  listed caller origin;
- `get_dispatch_state` returns zones, fees, page facts, today;
- `request_quote` changes nothing and matches the Worker's fee calculation for each
  zone/size boundary (cheapest, most expensive, outside);
- `confirm_dispatch` refuses: expired quote, wrong `expectedQuoteId`, bad phone, empty
  address, zone outside — each returns `ok:false` and writes nothing;
- approved call writes the same job record as the page's own form, given the same input;
- the dialog's words and details match the call, only its confirm button confirms;
- **bridge tests**: `get_quote` caller origin allowed/refused; `confirm_dispatch` caller
  origin allowed/refused, `confirmsInWindow` set, a second submit with the same
  idempotency key yields one job (fake fetch, no Worker needed);
- the runtime `CALL_BUDGET` stays under 16,000 characters.

`pizza-site/tests/`: keep the example's tests, add the partner checks from the template
(consent card focus, partner action gets the runtime's dialog, bundled form runs nothing)
and a test that the courier URL is declared in `tools`, `link_labels` and `allowed_peers`.

## 6. Acceptance for M1

```shell
# both sites build with zero errors
node %SKILL%\scripts\build_network.mjs courier-site\courier_dispatch.hocon --manifest courier-site\agent-manifest.json --check
node %SKILL%\scripts\build_network.mjs pizza-site\little_oven_pizza.hocon --manifest pizza-site\agent-manifest.json --check

# both sites' tests
node --test "courier-site\tests\*.test.mjs"
node --test "pizza-site\tests\*.test.mjs"

# partner health, both directions
node %SKILL%\scripts\check_partner.mjs http://localhost:8085/courier_dispatch --origin http://127.0.0.1:8084
node %SKILL%\scripts\check_partner.mjs http://127.0.0.1:8084/little_oven_pizza --origin http://localhost:8085
```

Manual browser run, screenshots kept in `docs/`:

1. serve courier `--port 8085 --open-as localhost`, pizza `--port 8084 --open-as 127.0.0.1`,
   Worker `wrangler dev` on 8086;
2. in the pizza chat: "Order one Pepperoni for delivery. My name is Sam Lee." → consent
   card names Conveyor Courier → quote card → courier window opens on `localhost:8085`
   → confirm → receipt with job id;
3. courier page shows the new job; pizza chat reports the receipt;
4. kill the Worker, repeat → the flow must report `unknown` and must not create a second
   job when retried with the same key;
5. no key, no PII in any published file: `grep -ri "sk-" courier-site pizza-site`.

## 7. Risks and fallbacks (unchanged from the plan)

- If the bridge write does not open the courier window on the caller's page within 2 days,
  fall back to the documented alternative: an MCP-style same-origin endpoint plus a
  manual confirmation link — still compliant, still one write.
- Worker/D1 limits: a plain `fetch` mock in `tests/` keeps tests independent; hosting
  fallback is Render/Fly with the same contract.
