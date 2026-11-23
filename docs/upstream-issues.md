# Upstream issue log

Issues filed against the official reference repository, with the evidence kept here.
Only the check behaviour itself is reported; nothing about our project appears in them.

## cognizant-ai-labs/agentic-web#70 — 2026-11-22

- **URL:** <https://github.com/cognizant-ai-labs/agentic-web/issues/70>
- **State at filing:** open, author `niu602`
- **Re-checked 2026-11-23:** still `open`, `comments=0`, no labels,
  `updated_at=2026-11-22T10:01:10Z`. No maintainer response yet, so the local
  `partner_rules differs` warning stands and the pizza build is still accepted as
  "zero errors plus this one noted warning".
- **Title:** `[bug] build_network.mjs --check false-positives "partner_rules differs" on Windows (CRLF) checkouts`
- **Filed against:** `f154be8f43fb6152be221279cada7da6a1e931ea`

### What was reported

On a Windows checkout (`core.autocrlf=true`), `build_network.mjs --check` warns
`partner_rules differs from templates/network.hocon` for all three official examples even
though their `partner_rules` are correct. The Node linking suite then fails `L8` for all
five sites (three examples plus both linking fixtures).

### Root cause, as verified

Asymmetric line-ending normalization inside the builder, not the placeholder regex:

| Location | Behaviour |
| --- | --- |
| `run()`, ~line 170 | site HOCON is normalized: `.replace(/\r\n/g, "\n")` before `parseHocon` |
| `loadTemplateRules()`, ~line 482 | template is parsed **without** that normalization |
| `checkTemplateRules()`, lines 509–516 | regex on line 512 reads the site's concrete action name; `.replace` on line 513 substitutes it into the template text; comparison on line 514 then differs by two `\r` characters |

Evidence: with both texts taken as-is the strings are byte-identical (878 characters,
`true`). Normalizing only the site text leaves the template at 878 and the site at 876,
first differing index 0, char code 13 versus 10. CR counts: template 2, site as-is 2,
site normalized 0. The regex itself matches (`website_get_restaurant_state`).

Suggested fix in the issue: normalize the template the same way before parsing, and
optionally add a `.gitattributes` with `* text=auto eol=lf`.

### Impact on our milestones

Until upstream fixes it, every correctly built site on a Windows checkout will carry this
one warning. M1 acceptance is therefore "zero errors, and this one warning annotated".
A local workaround for development is to set `core.autocrlf=false` in a fresh checkout so
working-tree files stay LF; the pinned read-only clone is left untouched.
