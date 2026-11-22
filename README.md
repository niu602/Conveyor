# Conveyor

Cross-site transaction primitives for the open agentic web, plus two self-hosted agentic
sites that complete one real cross-site transaction inside a visitor's browser.

**Status: M0 (foundation), 2026-11-22.** The repository is public from day one. The two
demo sites and the primitives library land in the milestones below.

## The gap this targets

An agent can already browse an agentic site and answer questions about it. It cannot
**transact across two independent agentic sites**: nothing binds the terms the visitor
agreed to, nothing deduplicates a write that the network retried, and nothing produces a
receipt that both sides can audit afterwards. The Worldwide Agentic Web MVP spec lists
these as the first extension (`§7`): policy-bound mandates, sealed bids, deterministic
negotiation, settlement controls and auditable receipts. The reference implementation
ships none of them, and the community sites listed in the spec stop at read-only Q&A.

Conveyor implements that layer as a reusable component, and proves it with two real
sites rather than a mock:

- **Pizza site (caller).** A working storefront — menu, cart, checkout, demo orders.
  When a visitor orders delivery, its agent hands the dispatch to the courier site.
- **Courier site (callee).** A working dispatch desk — quote, job intake, job list,
  status lookup, cancellation rules. It publishes a network plus bridge actions: a
  read-only quote any listed caller may run, and one write — `confirm_dispatch` — that
  opens **in the courier site's own window**, where the visitor confirms the job and the
  site's same-origin Worker records it idempotently.

Flow is one-way: pizza calls courier, the courier never writes back. Return information
travels only through a read-only `job_status` query.

## Built on the official reference implementation

| Item | Value |
| --- | --- |
| Base repository | [`cognizant-ai-labs/agentic-web`](https://github.com/cognizant-ai-labs/agentic-web) |
| Pinned commit | `f154be8f43fb6152be221279cada7da6a1e931ea` (2026-11-20) |
| License of the base | Apache-2.0 |
| Spec | Worldwide Agentic Web MVP spec, in `docs/` of the base |
| Prompt/asset source for the sites | `skills/agentify-website/` (SKILL.md, `runtime/`, `templates/`, `references/`) |

The base repository is rewritten upstream from time to time. This repository pins the
commit above for development and re-aligns with the latest spec before submission.

## Increment disclosure

Everything below is stated in the same shape the challenge asks for: what came from the
open-source base, and what is new work here. Nothing from the base is claimed as original.

| Component | Origin | License | What changed |
| --- | --- | --- | --- |
| `runtime/` in each site | Official `skills/agentify-website/runtime/` | Apache-2.0 | **Copied byte-for-byte, never edited.** One copy per site. |
| `build_network.mjs`, `serve_site.mjs`, `check_partner.mjs` | Official skill scripts | Apache-2.0 | Used as-is from the pinned base; not vendored into this repository. |
| `pizza-site/` | Derived from official `examples/marrow_point_pizza_agentified` | Apache-2.0 | M1: delivery handoff added — courier network in `tools`, courier origin in `allowed_peers`, `link_labels`, dispatch confirmation bound to amount and cart version. Full list in `pizza-site/README.md` under "Changes from the official example". |
| `courier-site/` | New site in this repository | Apache-2.0 | Built on the skill's templates and runtime. Real dispatch business (quote, intake, jobs, status, cancellation), bridge read + bridge write, same-origin Worker intake. |
| `counter-kit/` | New library in this repository | Apache-2.0 | Mandates (confirmation binding), idempotency with unknown-outcome state machine, signed receipts, settlement records. Independent tests and docs. |
| `concierge-site/` (optional, M6) | New site in this repository | Apache-2.0 | Third site: discovers peers and convenes them for one multi-party demo. Reuses `counter-kit` unchanged. |

Secrets policy: no API keys, tokens, personal data or customer records are committed.
Every LLM call uses the visitor's own key (BYOK) from their browser.

## Layout

```text
docs/            baseline records, milestone notes, Stage 1 self-check
pizza-site/      M1: agentified storefront (caller)
courier-site/    M1: agentified dispatch desk (callee)
counter-kit/     M4: reusable cross-site transaction primitives
concierge-site/  M6 (optional): third site that convenes peers
```

## Milestones

| Milestone | Dates | Deliverable |
| --- | --- | --- |
| M0 Foundation | 11-22 → 11-24 | Public repo, pinned base commit, baseline runs recorded (this commit) |
| M1 One needle | 11-25 → 11-29 | Courier bridge write + Worker intake, pizza handoff, full flow in a real browser |
| M2 Transaction | 11-30 → 12-8 | Business surfaces, mandates, idempotency, unknown outcome, signed receipts, reconciliation page |
| M3 Hosting | 12-9 → 12-13 | Cloudflare Pages + Workers/D1, community listing PR, Stage 1 self-check on the live URLs |
| M4 Extraction | 12-14 → 12-20 | `counter-kit` published as a standalone reusable component |
| M5 Materials | 12-21 → 1-3 | English README, screenshots, demo video script and recording, Devpost draft |
| M6 Optional | 1-4 → 1-8 | `concierge-site` multi-party demo, only if the schedule holds |

## Develop

Requires Node.js 22 or newer. The base repository must be checked out at the pinned
commit; the build script is run from there rather than copied here.

```shell
git clone https://github.com/cognizant-ai-labs/agentic-web
git -C agentic-web checkout f154be8f43fb6152be221279cada7da6a1e931ea
node agentic-web/skills/agentify-website/scripts/serve_site.mjs pizza-site --port 8080
```

Per-site build and test commands are added with each site in M1.

## License

Apache-2.0. See [`LICENSE`](LICENSE). The base repository and its `runtime/` are
Apache-2.0 by Cognizant AI Labs; this repository's new components keep the same license
so they can be reused by any agentic site.
