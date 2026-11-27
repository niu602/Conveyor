# Upstream 0.2.2 notes — `publisher_funded`, for M3

Read on 2026-11-27 against the synced base `90d561d6185d3b5625f9d8055da4d259074af745`.
Question put to this note: is paying for visitors' model calls a **configuration** change
or a **code** change on our side?

## Verdict

**Configuration-level for the site — but it needs one new service we must build and host.**

Two halves, and both matter:

1. **Site side: pure configuration, zero lines of site code.** One object in
   `agent-manifest.json`. No `script.js`, no `site-actions.js`, no `index.html`, no HOCON,
   no bridge change. All the supporting code already lives in `runtime/`, which we copy
   verbatim and are forbidden to edit — and the runtime we synced today already contains it.
2. **Infrastructure side: we must stand up a key-holding proxy.** `publisher_funded` does
   not make the model free; it moves the bill from the visitor to us. Something of ours has
   to hold the upstream key and forward the call. That is a new Worker, not an edit to an
   existing file.

So the honest one-liner for the plan: **配置级接入 + 一个自建代理 Worker**. Calling it
"just a config flag" would hide the only real work item.

### Correction to the wording in the task

The flag is **not** in HOCON. `llm_router` lives in **`agent-manifest.json`**. Our HOCON
holds instructions and rules; it has no router section. Evidence: the manifest field table
in `references/bundle_and_hosting.md:45`, and our own
`pizza-site/agent-manifest.json:22-26`.

## Where the feature comes from

Both PRs named in the task are real, and both are already inside tag `0.2.2`:

| PR | Merge commit | What it did |
| --- | --- | --- |
| #55 `akshit9162/sponsored-router` | `3ea4b3f` | Implementation |
| #75 `worktree-publisher-funded-docs` | `d67755e` (doc commit `ca7da75`) | Documentation + build-time validation |

`git merge-base --is-ancestor <merge> 0.2.2` returns 0 for both.

Later hardening: `9fb36d3` "Refuse a publisher-funded base_url that is also byok_router".

**The #55 file list is the strongest single piece of evidence for the verdict.** 25 files,
669 insertions, and every one of them is under `runtime/`, `references/`, `scripts/` or
`tests/`:

```text
skills/agentify-website/runtime/engine.js        | 37 +++-
skills/agentify-website/runtime/llm.js           | 18 +-
skills/agentify-website/runtime/ui.js            | 15 +-
skills/agentify-website/runtime/in-use-line.js   |  4 +
skills/agentify-website/runtime/README.md        | 21 ++-
examples/*/runtime/{engine,llm,ui,in-use-line}.js  (the same copied runtime)
tests/skills/agentify-website/runtime/*.test.mjs   (engine, llm, in-use-line, panel)
```

Not one example site's business code was touched. The examples changed only because their
copied `runtime/` folder changed — exactly the operation we performed in this sync.

## Evidence in the synced code

| Location | What it proves |
| --- | --- |
| `references/bundle_and_hosting.md:45` | Manifest field table: `publisher_funded` means the site pays; the browser is sent no key and no `Authorization` header; a visitor who adds a key switches to `byok_router`; a partner network also runs on `base_url`, paid by this site; ignored when `mock: true` |
| `references/bundle_and_hosting.md:330-385` | Whole section "Paying for visitors' model calls": manifest shape, the three things the proxy must do, five self-protection measures |
| `scripts/build_network.mjs:666-678` | `byok_router` is required. With `publisher_funded` and not mock, the builder demands `this.runtime.isPublisherFundedRouter` or fails with "needs the skill's current runtime". `byok_router` equal to `base_url` is an error |
| `runtime/engine.js:59` | `export function isPublisherFundedRouter(manifest, url)` — the gate the builder looks for |
| `runtime/llm.js:55,61-62` | Constructor takes `publisherFunded`; when true, `apiKey = ""` |
| `runtime/llm.js:74` | The "key required" refusal is skipped when publisher-funded |
| `runtime/llm.js:85` | Trace records `keySource: "none: paid for by this site"` |
| `runtime/README.md:94-107` | Same contract, from the runtime's own README |

Both of our copied runtimes export the gate at `engine.js:59`, so **the build will accept
the flag today**. Before this sync it would not have.

## The exact delta for M3

Our current `pizza-site/agent-manifest.json:22-26`:

```json
"llm_router": {
  "base_url": "https://api.otari.ai/api/v1",
  "mock": false,
  "byok_router": "https://api.otari.ai/api/v1"
}
```

Target shape:

```json
"llm_router": {
  "base_url": "https://<our-proxy-host>/v1",
  "mock": false,
  "publisher_funded": true,
  "byok_router": "https://api.otari.ai/api/v1"
}
```

Three points worth noting now, so M3 does not rediscover them:

- Keeping `byok_router` on otari while `base_url` points at our proxy **satisfies the
  different-URL check for free**. No extra trick needed.
- A visitor who pastes their own key still gets otari, not our proxy. Their key never
  reaches our bill.
- `mock: true` ignores the flag entirely, so our test suites are unaffected by this change.

## What the proxy must do (from `bundle_and_hosting.md:330-385`)

1. Hold the upstream key **server-side only** and add it to the forwarded request.
2. Forward to the upstream chat-completions endpoint, streaming included.
3. Return the upstream response, including CORS headers the browser needs.

And the five self-protection measures the same section asks for: an allow-list of origins,
a per-visitor rate limit, a spend cap, a model allow-list, and no logging of visitor
content. These are the publisher's responsibility, not the runtime's.

**Cost note, no action taken:** this spends the publisher's money on every visitor call.
Nothing was purchased, provisioned or enabled while writing this note. It is a finding
for M3, and the decision to turn it on stays with the project owner.

## Method note

The task asked for "PR #75 说明 + #55 实现". Those were read **as commits in the local
synced clone** (`d67755e`, `ca7da75`, `3ea4b3f`, `9fb36d3`), not through the GitHub web UI.
That is the stronger form of the same evidence: the merged code and docs rather than the
PR description. No network call to GitHub was made for this note.