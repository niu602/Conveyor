# M0 baseline record — 2026-11-22

Everything here was run on the local machine, against the **read-only** clone at
`D:\OpenAgenticWeb`, pinned at `f154be8f43fb6152be221279cada7da6a1e931ea` (2026-11-20).
The clone was not modified: `git status` reports only the pre-existing untracked `_work/`.

Working copies live under `D:\Conveyor\_baseline\` (git-ignored) so that builds never
touch the clone. Raw command output is kept as `docs/raw-m0-*.txt`.

## Environment

| Item | Value |
| --- | --- |
| OS | Windows 11, PowerShell 7.6.4 |
| Node | v22.23.2 |
| npm | 10.9.8 |
| git | 2.53.0.windows.2 |
| Chrome | `C:\Program Files\Google\Chrome\Application\chrome.exe` |
| Base commit | `f154be8` — matches the plan (§2) |

## 1. Official pizza example — build

```shell
node D:\OpenAgenticWeb\skills\agentify-website\scripts\build_network.mjs ^
  D:\Conveyor\_baseline\marrow_point_pizza_agentified\little_oven_pizza.hocon ^
  --manifest D:\Conveyor\_baseline\marrow_point_pizza_agentified\agent-manifest.json --check
```

Result: **exit 0**. Generated network, discovery files and bridge verified up to date.
Front agent `little_oven_assistant`, 4,230 instruction chars (+1,612 CRUSE added by the
runtime), two partner tools, bridge shares `bridge/bridge-actions.js` reads.

Output: `raw-m0-build-pizza.txt`.

**One warning:** `partner_rules differs from templates/network.hocon.`

Investigated. At this commit the warning is a **false positive** in the builder:
parsing both files with the runtime's own HOCON parser and substituting
`website_<read_action>` → `website_get_restaurant_state` yields **byte-identical**
878-character strings (verified twice, with the skill runtime and with the site's copied
runtime). The check in `scripts/build_network.mjs` (`checkTemplateRules`, lines 497–518)
nevertheless warns. Consequence: every official example and both linking fixtures trip
this warning, and the upstream `L8` test fails for all five sites (see §3).

**For our sites:** copy `templates/network.hocon`'s `partner_rules` unchanged, substitute
only the read action name, and expect this same warning until upstream fixes the check.
M1's acceptance is "zero errors"; the warning is annotated, not hidden.

## 2. Official pizza example — Node tests

```shell
node --test "D:\Conveyor\_baseline\marrow_point_pizza_agentified\tests\*.test.mjs"
```

Result: **31 tests, 31 pass, 0 fail** (exit 0), 537 ms.
The budget-printing test reports **6,279 characters of system prompt + 4,997 of tool
definitions** per model call — inside the 16,000-char `CALL_BUDGET`.
Coverage includes cart operations, refusals, totals, page-handler parity, irreversible
confirmation/dialogs, stale cart version, text-field limits, and the record written
equals the page form's record.

Output: `raw-m0-test-pizza.txt`.

## 3. Official pizza example — server and CORS

```shell
node D:\OpenAgenticWeb\skills\agentify-website\scripts\serve_site.mjs ^
  D:\Conveyor\_baseline\marrow_point_pizza_agentified --port 8089 --host 127.0.0.1 ^
  --log D:\Conveyor\docs\raw-m0-serve-pizza.log
```

| Request | Status | `Access-Control-Allow-Origin` |
| --- | --- | --- |
| `GET /` | 200 | — (page, correctly without CORS) |
| `GET /agent-manifest.json` | 200 | `*` |
| `GET /little_oven_pizza.network.json` | 200 | `*` |

Server log confirms the `Origin` header was seen and no `Authorization` header was sent
by the probe. Output: `raw-m0-serve-pizza-log.txt` (the live `.log` is git-ignored).

## 4. Linking test bed — Node half

```shell
cd D:\OpenAgenticWeb
node --test "tests/linking/linking.test.mjs"
```

Result: **63 tests — 55 pass, 5 fail, 3 skip** (exit 1), 20.0 s.
No port is used; the whole run stays in-process with a scripted router and the fake key
`sk-test-not-a-real-key`.

- **Failures:** all 5 are `L8 ... keeps the skill's runtime and rules, and builds clean`,
  one per site (guesthouse, tours, pizza, caller fixture, partner fixture). All five fail
  on the same §1 warning — the assertion is `doesNotMatch /WARNING: partner_rules differs/`.
  Nothing about runtime bytes, `peer_rules` or partner rules content failed.
- **Skips (with reasons, not failures):**
  - `L11 fixture caller -> guesthouse`: the guesthouse does not share
    `website_search_rooms` with `http://localhost:8082`.
  - `L11 guesthouse -> pizza`: the pizza site's only read also reads its page HTML,
    which needs a browser; the Chrome check covers it.
  - remaining tour-site directions (`tours-to-gh`, `tours-to-pizza`, tour `L8`) stay idle
    as documented; the real `harbor_tours_agentified` is present, so `L4`/`L11` ran.

Everything that matters for the plan's red line passed: **L1/L4** (one consent card, files
and bridge fetched only after Allow, key never leaves the router, partner runs on the
caller's model), **L3** (decline sends nothing), **L5** (no call-back loop), **L6** (second
call to the same partner skipped), **L7** (`allowed_peers` refusal), **L9** (invalid partner
never runs), **L11** (bridge read runs in a frame on the partner's origin), **L10**
(two-hop chain with a card at each hop).

Output: `raw-m0-test-linking.txt`.

## 5. Linking test bed — real Chrome half

```shell
node D:\OpenAgenticWeb\tests\linking\chrome\run_linking_check.mjs ^
  --out D:\Conveyor\_baseline\linking-chrome ^
  --chrome "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

Result: **exit 2, 0 cases run.**

```text
ERROR: The guesthouse server stopped: Cannot serve ...: listen EACCES: permission denied 127.0.0.1:8080
```

Port **8080** on this machine is held by another local process (`ApplicationWebServer`,
PID 16120, listening `0.0.0.0:8080`). The check hard-codes 8080/8081/8082/8083, so it
cannot start. Ports 8081, 8082, 8083, 8791, 9782 were free.

**Decision:** do not kill an unrelated process. The Chrome half was deferred until 8080
was free; see §5b for the completed run. Output: `raw-m0-chrome-linking.txt`.

## 5b. Linking test bed — real Chrome half, completed

Re-run on 2026-11-22 after the unrelated process on 8080 was stopped by the user.

```shell
node D:\OpenAgenticWeb\tests\linking\chrome\run_linking_check.mjs ^
  --out D:\Conveyor\_baseline\linking-chrome2 ^
  --chrome "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

Result: **39 passed, 0 failed, 0 skipped, exit 0.** Output: `raw-m0-chrome-linking2.txt`;
report and per-case evidence in `_baseline\linking-chrome2\` (git-ignored).

| Case | Result | What it proves for our red line |
| --- | --- | --- |
| C1 / C2 (7 directions) | pass | One consent card before any contact; the partner's files and bridge are fetched only after Allow; every model call runs on the caller's router with the visitor's key; the partner never receives the key or an `Authorization` header. Consent→answer 399–594 ms. |
| C3 (7 directions) | pass | Declining sends nothing at all to the partner. |
| C4 | pass | The same between real example sites, not just fixtures. |
| C9 | pass | A bridge **read** runs in a frame on the partner's own origin, parses the partner's page with `DOMParser`, and its facts reach the caller. |
| **C10** | **pass** | A bridge **write** (`book_departure`, `place_order`) opens the partner's own window; the check types the details there and submits; the receipt returns to the caller, and **no model request held a typed detail**. |
| **C11** | **pass** | Cancel in the partner's window returns a cancelled result. |
| C5 / C6 | pass | Keyless read check succeeds; each bridge page loads only the modules its `bridge-actions.js` imports, never the page or its boot files. |

**Consequence for M1:** the mechanism the plan calls the red line is already proven on
this machine against the official sites — `peer loading → consent → bridge read → bridge
write in the callee's own window → receipt`. M1 therefore only has to reproduce it with
our own courier intake, not discover it.

Note: this Chrome run uses the official examples as served, so it is not affected by the
`partner_rules` warning of §1 (that is the Node `L8` build assertion only).

## Summary against M0 acceptance

| Acceptance item | Status |
| --- | --- |
| Repository public and clonable | done (this commit, `niu602/Conveyor`) |
| Official pizza example: build + tests green | **31/31 pass**, build exit 0 (1 known upstream warning) |
| Linking baseline recorded in `docs/` | Node half: 55 pass / 5 known L8 fails / 3 documented skips. **Chrome half: 39 pass / 0 fail**, C10+C11 bridge write proven (§5b) |
| Official clone untouched | verified with `git status` |

## Repository

| Check | Result |
| --- | --- |
| URL | <https://github.com/niu602/Conveyor> |
| First commit | `55b39e97081aadfd3e9adcd8c7b1ce141f3bbee5` |
| Visibility | `private=false`, default branch `main` (GitHub API) |
| License detected | `Apache-2.0` (GitHub API) |
| Clone test | `git clone --depth 1` → exit 0, 10 tracked files present |
| Secret scan | no `sk-…`, `AKIA…` or `ghp_…` strings in any tracked file |

Push transcript: `raw-m0-push.txt`.

## Reproduce

```shell
# build + tests (any working copy; never inside the clone)
node D:\OpenAgenticWeb\skills\agentify-website\scripts\build_network.mjs <site>\<network>.hocon --manifest <site>\agent-manifest.json --check
node --test "<site>\tests\*.test.mjs"

# linking (from the clone root)
node --test "tests/linking/linking.test.mjs"
```
