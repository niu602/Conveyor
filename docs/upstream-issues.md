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

### Fixed upstream — verified 2026-11-27

**Status: closed as completed.** Re-read from the live issue page on 2026-11-27:

- Closed by **ofrancon** on **Nov 25, 2026**, in **`6f1c8e1`**, as *completed*.
- `andreibesleaga` also pushed a commit referencing the issue the same day.
- The issue page still shows no labels and no assignee.

The fix commit, read in the local synced clone:

| Field | Value |
| --- | --- |
| SHA | `6f1c8e167bf0338b30a7d7dfce762cdef106e5a5` |
| Author | Noravee Kanchanavatee `<noraveek@gmail.com>` |
| Date | Tue Nov 24 10:06:19 2026 -0800 (Nov 25 02:06 Beijing) |
| Subject | `Read the network template with LF line endings` |
| Trailer | `Closes #70` |
| Diff | 2 files, 102 insertions, 2 deletions |

**The adopted fix is the one suggested in the issue, word for word.** In
`loadTemplateRules()` — the exact function named in the root-cause table above:

```diff
-      const template = runtime.parseHocon(await readFile(NetworkBuilder.TEMPLATE, "utf8"));
+      // Use LF, as run() does for the site's HOCON. On a Windows checkout both files may
+      // have CRLF, and the rules must match the site's text.
+      const text = (await readFile(NetworkBuilder.TEMPLATE, "utf8")).replace(/\r\n/g, "\n");
+      const template = runtime.parseHocon(text);
```

The optional `.gitattributes` suggestion was not taken; the normalization alone was enough.

A regression test was added in `scripts/build_network.test.mjs`: **98 new lines** (99 changed
lines including one deletion). Per the commit message it builds and checks the fixture using
**CRLF copies of the site, the script and its templates**, so the Windows path is now covered
by the suite rather than by a contributor's local setting.

### Verified locally after syncing to `90d561d`

The base was moved from `f154be8` to `90d561d6185d3b5625f9d8055da4d259074af745` on 2026-11-27.
`git merge-base --is-ancestor 6f1c8e1 origin/main` exits 0, so the fix is in our base.

| Check | Before (`f154be8`) | After (`90d561d`) |
| --- | --- | --- |
| Pizza `build --check` | 1 warning (`partner_rules differs`) | **0 warnings, 0 errors** |
| Courier `build --check` | same warning | **0 warnings, 0 errors** |
| Linking, Node | 63 tests, 55 pass, **5 fail**, 3 skip | 63 tests, **60 pass, 0 fail**, 3 skip |
| Linking, real Chrome | 39 pass, 0 fail | **39 pass, 0 fail** |

All five former `L8` failures — guesthouse, tour site, pizza site and both linking fixtures —
are now `ok`. The three remaining skips are the same pre-existing ones documented in
`m0-baseline.md`, unrelated to this issue.

**Consequence for our acceptance wording:** the M1-era formulation "zero errors, plus this
one noted warning" is retired. From this base onward the standard is a plain **zero warnings,
zero errors**, and the `core.autocrlf=false` workaround is no longer needed.

Raw output: `raw-sync-build-pizza.txt`, `raw-sync-build-courier.txt`,
`raw-sync-linking-node.txt`, `raw-sync-linking-chrome.txt`.

### Note on the `0.2.2` tag

Tag `0.2.2` is `3130406` and **does not contain this fix**
(`git merge-base --is-ancestor 6f1c8e1 0.2.2` exits 1). Pinning the tag would reintroduce the
warning and the five `L8` failures. The base therefore tracks `main`, not the tag.
