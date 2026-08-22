# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A personal technical knowledge archive published as a static site. It is a fork of [Quartz 4](https://quartz.jzhao.xyz/) (v4.5.2), so the repo contains two distinct things:

- `content/` — the actual value of this repo: hand-written Markdown notes. Almost all work happens here.
- `quartz/` — the vendored upstream static-site generator (Preact + esbuild + unified/remark/rehype). Modified only for UI/theming.

Deployed to GitHub Pages by `.github/workflows/deploy.yml` on every push to `master` (`npm ci` → `npx quartz build` → upload `public/`).

## Commands

```bash
npm i                                      # node >=22, npm >=10.9.2 required
npx quartz build --serve                   # local dev server on :8080 with hot reload
npx quartz build --serve --port 3000       # other useful build flags: -d <dir>, -o <dir>,
                                           # --watch, --concurrency N, --bundleInfo, -v
npm run check                              # tsc --noEmit + prettier --check  (run before committing)
npm run format                             # prettier --write
npm run test                               # tsx --test (node test runner over *.test.ts)
npx tsx --test quartz/util/path.test.ts    # single test file
```

Only three test files exist (`quartz/util/path.test.ts`, `quartz/util/fileTrie.test.ts`, `quartz/components/scripts/search.test.ts`) — they cover upstream engine utilities, not content.

## Content architecture

### The notes ↔ summaries mirror (most important invariant)

`content/notes/` and `content/summaries/` are **exact structural mirrors**: every note has a counterpart at the identical relative path and filename. Adding a note means touching three places:

```
content/notes/Networking/istio-tls-layering.md        ← full deep-dive note
content/summaries/Networking/istio-tls-layering.md    ← 1:1 condensed counterpart
content/summaries/index.md                            ← one table row linking both
```

The two trees are currently in sync (56 notes each), but `summaries/index.md` has drifted — 5 notes have summaries with no index row (`AuthNZ/http-sessions-cookies-security`, `K8s/hpa-vpa-autoscaling`, `K8s/kube-apiserver-request-routing`, `Networking/istio-service-discovery-dns-listeners`, `Networking/istio-tls-layering`). Nothing automates this; the index is maintained by hand.

### File shapes

**Note** (`content/notes/<Topic>/<file>.md`): `title` frontmatter → `## Overview` → topic sections in declarative prose with heavy ASCII diagrams and tables → `## See also` / `## Related` → `## Interview Prep` (the only Q&A section, `### Q:` / `**A:**`).

**Summary** (`content/summaries/<Topic>/<file>.md`): `title` frontmatter prefixed `"Summary: ..."` → a `> **Full notes:** [[notes/<Topic>/<file>|... -->]]` backlink → `## Key Concepts` → `## Quick Reference` → `## Key Takeaways`. No Interview Prep section. Summaries link forward to notes; notes do *not* link back to summaries.

Other content areas: `content/playbooks/` (scripts, conventions, tools), `content/designs/`, `content/links.md`. Each directory has an `index.md` acting as its landing page.

### Conventions

- **Frontmatter**: `title` only. All 124 markdown files use exactly this one key — no tags, dates, draft flags. (`CreatedModifiedDate` derives dates from git history, so keep commits meaningful.)
- **Wikilinks** are root-relative from `content/`: `[[notes/Networking/tls-1.3-handshake|TLS 1.3 Handshake]]`. Inside Markdown tables the pipe must be escaped: `[[summaries/GCP/PSC\|Private Service Connect]]`.
- **Filenames**: newer files use kebab-case; older ones use `snake_case` or `SCREAMING_SNAKE` (`OIDC_Oauth.md`, `OPERATOR_ARCHITECTURE_AND_MIGRATION.md`). Use kebab-case for new files. Do **not** rename existing files — `markdownLinkResolution: "shortest"` means renames silently break inbound wikilinks.
- Topic directories are PascalCase-ish and stable: `AuthNZ`, `CloudLogging`, `CUElang`, `GCP`, `Git`, `Golang`, `K8s`, `kubebuilder`, `Networking`, `O11y`, `PubSubPusher`.

## Quartz engine

Build pipeline (`quartz/build.ts` → `quartz/processors/`): **parse** (transformers build the mdast/hast) → **filter** → **emit** (emitters write files to `public/`). Plugins are registered in `quartz.config.ts`, page composition in `quartz.layout.ts`.

- `quartz/plugins/transformers/` — per-file AST transforms (frontmatter, Obsidian-flavored markdown, syntax highlighting via Shiki, KaTeX, ToC, link crawling).
- `quartz/plugins/emitters/` — output producers (ContentPage, FolderPage, TagPage, ContentIndex/RSS/sitemap, CustomOgImages).
- `quartz/components/*.tsx` — Preact SSR components. Client-side behavior lives in sibling `scripts/*.inline.ts` files, imported with `// @ts-ignore` and attached via a component's `afterDOMLoaded`. Those scripts must listen for the `"nav"` event (fires on initial load *and* SPA navigation) and register teardown with `window.addCleanup()`.

### Where to make UI changes

Because `quartz/` is vendored upstream code, prefer the lowest-friction override point:

1. `quartz.config.ts` — theme colors (`--light`, `--lightgray`, `--gray`, `--darkgray`, `--dark`, `--secondary`, `--tertiary`, `--highlight`, `--textHighlight`), fonts, plugin toggles.
2. `quartz/styles/custom.scss` — the intended place for all CSS overrides (imports `base.scss`). Dark mode is `[saved-theme="dark"]` on the root element; breakpoints `$mobile` (<800px), `$tablet`, `$desktop` (>1200px) come from `variables.scss`.
3. `quartz/components/scripts/animations.inline.ts` — local (non-upstream) addition holding scroll progress, back-to-top, and reveal animations. All motion is guarded by `prefers-reduced-motion`.

Editing engine files under `quartz/plugins/`, `quartz/util/`, or `quartz/components/*.tsx` directly creates merge conflicts with upstream Quartz — do it only when config and `custom.scss` genuinely cannot express the change.

### Known config drift

`quartz.config.ts` sets `baseUrl: "yatharthagoenka.github.io/devtools"` (inherited from the fork source), but the actual remote is `github.com/anirudh-y-M/archive` and the site serves from `anirudh-y-m.github.io/archive`. This affects absolute URLs in RSS, sitemap, and OG images. Fix it if touching anything that depends on canonical URLs.

## Note-authoring style contract

Detailed rules for *how* notes must be written (verification against RFCs/official docs before writing, depth requirements, `> **Note:**` callouts when correcting source material, the no-redundant-notes rule) live in `.claude/CLAUDE.md`, along with the `cs-master-notes` and `ui-enhancer` subagent definitions. Note that `.claude/` is gitignored — those instructions are local-only and not shared with clones.

The single most load-bearing rule from there: **before creating a new note file, grep `content/notes/` for overlapping coverage and append to the existing file instead.** New files are for genuinely new topics only.
