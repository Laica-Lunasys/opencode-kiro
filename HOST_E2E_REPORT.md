# Host End-to-End Validation Report

**Task**: opencode-v2-migration-13
**Plugin**: `opencode-kiro@0.5.0-beta.1` (branch `opencode-v2`)
**OpenCode host SHA (pinned)**: `010133f6df21ab273b260327670f19c95e7a167c`
**Pinned plugin API**: `@opencode-ai/plugin@0.0.0-next-16383`
**Date**: 2026-07-29
**Method**: detached read-only `git worktree` of the local OpenCode clone at the pinned SHA, hermetic XDG/HOME config, clean npm cache, packed tarball install.

## Environment

| Item | Value |
|------|-------|
| Host worktree | `$TMPDIR/tmp.nw1pvoUIao/opencode-e2e` (detached @ `010133f6df21ab273b260327670f19c95e7a167c`) |
| Source clone | `/Users/user/Documents/1-coding/open-source/opencode` (branch `feat/kiro-provider`, working tree untouched) |
| Plugin tarball | `opencode-kiro-0.5.0-beta.1.tgz` (npm pack, dist-only) |
| Hermetic config root | temp dir (real user config untouched) |

## Checklist Results

| # | Item | Result | Evidence |
|---|------|--------|----------|
| 0a | Temp worktree at exact pinned SHA, read-only | PASS | git worktree list shows `.../tmp.nw1pvoUIao/opencode-e2e 010133f6df (detached HEAD)`; rev-parse HEAD = `010133f6df21ab273b260327670f19c95e7a167c`; source clone stayed on `feat/kiro-provider` with empty `git status --short` |
| 0b | Plugin build + `npm pack` tarball | PASS | `npm run build` exit 0 (dist/server.js, dist/tui.js, 2 lazy view chunks, .d.ts); `npm pack` -> `opencode-kiro-0.5.0-beta.1.tgz` (12523 B, 10 files, dist-only) |
| 0c | Host build/install inside worktree only | PASS | Worktree `bun install` pre-existing (node_modules present); `bun run dev --help` from worktree root prints "OpenCode 2.0 preview command line interface" with subcommands (serve/api/run/plugin/auth/debug) — host boots at pinned SHA. Note: bun must run with cwd=worktree root (root tsconfig supplies solid `jsxImportSource`; running the CLI entry from an outside cwd fails with `Cannot find module react/jsx-dev-runtime`). |
| 0d | Clean-cache install of tarball into hermetic root | PASS | Hermetic HOME/XDG_* root + empty `XDG_CACHE_HOME`; global `opencode.json` + `cli.json` carry `plugins:[{package:"opencode-kiro@file:<abs tgz>",options:{}}]`. From-scratch arborist install into `$XDG_CACHE_HOME/opencode/packages/opencode-kiro@file:.../node_modules/opencode-kiro` succeeded (~86s first run). **Blocker found**: the bare `file:<abs tgz>` spec form (as written in the task file) FAILS — see Upstream blockers B1. |
| 1 | Server entry resolution (`./server`; root fallback noted) | PASS | Server log: `msg="loading plugin" id=opencode-kiro@file:...tgz entrypoint=.../node_modules/opencode-kiro/dist/server.js` and `GET /api/plugin` lists id `kiro` alongside the 68 built-ins. Root (`.`) fallback does NOT resolve: `Npm.add(spec,{subpaths:[""]})` returns `{directory,...}` with NO `entrypoint` because the package exports map intentionally has no `"."` entry — harmless, `./server` is tried first (see Observation O1). |
| 2 | TUI entry resolution (`./tui`, no server-only behavior) | PASS | Host TUI resolver `Npm.add(spec,{subpaths:["tui"]})` -> `.../node_modules/opencode-kiro/dist/tui.js` (verified through the hosts own `@opencode-ai/util/npm` at the pinned SHA, same code path as `packages/cli/src/commands/handlers/default.ts:70`). Plain-Node `import(dist/tui.js)` succeeds and yields `{id,setup}` only — no Bun-native/`@opentui/core` or server-only import at module scope (lazy view-module pattern preserved). |
| 3 | Setup contract: both setups run, no throw, cleanup on shutdown | PASS | Both entries load and their setups run without throwing: server setup -> plugin id `kiro` in `GET /api/plugin` + `catalog.updated` event emitted 0.5 s after load; TUI setup -> `{id:"opencode-kiro",setup}` imported and invoked by the TUI host (item 9). Cleanup verified on the login path: `DELETE /api/integration/kiro/connect/oauth/<attemptID>` -> 204 and the spawned `kiro-cli login` child (pid 31569, ppid = server) was gone within 3 s; after each server shutdown no orphaned `kiro-cli`/ACP process remained (`ps` empty). |
| 4 | Integration surface: `kiro` integration + "Kiro CLI Login" method | PASS | `GET /api/integration` (177 integrations) contains `{"id":"kiro","name":"Kiro","methods":[{"id":"kiro-cli-login","type":"oauth","label":"Kiro CLI Login","prompts":[{"type":"select","key":"sidebar",...}]}],"connections":[]}` — integration + method label + sidebar consent prompt all present. |
| 5 | Auth flow end-to-end (needs local `kiro-cli`) | PASS | kiro-cli 2.15.1 logged in (IAM Identity Center, profile `KiroProfile-us-east-1`). `POST /api/integration/kiro/connect/oauth {methodID:"kiro-cli-login",inputs:{sidebar:"no"}}` -> 200 in 0.9 s with `{mode:"auto",url:"https://kiro.dev/docs/cli/",instructions:"Already authenticated with Kiro CLI."}`; status poll -> `complete`; `GET /api/integration/kiro` -> `connections:[{type:"credential",id:"cred_facccdddc001dQLuY0heBR4t82",label:"default"}]`. Unauthenticated branch also exercised (hermetic HOME): `mode:"auto"` + "Waiting for login..." + live `kiro-cli login` child + 2 s poll. |
| 6 | models.dev Kiro entry present? enrichment vs self-registration branch | PASS (answer: ABSENT) | Live models.dev catalog cached by the host at `$XDG_CACHE_HOME/opencode/models.json` (3.28 MB, fetched 2026-07-29): **174 providers, no `kiro` key and no occurrence of "kiro" anywhere in the payload**. Therefore the enrichment branch cannot fire and the plugins self-registration fallback is the live path — confirmed by item 7 (runtime model list + effort variants registered by the plugin itself). |
| 7 | Effort variant request path → `providerOptions.kiro.reasoningEffort` | FAIL (plumbing gap — see B3) | Variant selection itself works end-to-end: session created with `{"id":"claude-sonnet-5","providerID":"kiro","variant":"high"|"max"}`, the assistant message records that exact ref, and `withVariant` (host `model-resolver.ts:126-133`) merges `variants[].settings.reasoningEffort` into `model.settings` -> plugin `aisdk` hook `event.options`. BUT the effort never reaches the SDK: (a) the host only builds `providerOptions` for `@ai-sdk/openai|anthropic|openai-compatible` (`model-resolver.ts:99-110`) so `providerOptions.kiro.reasoningEffort` is NEVER populated for `aisdk:kiro-acp-ai-provider`; (b) `createKiroAcp(event.options)` receives the key `reasoningEffort`, while `KiroACPProviderSettings` names it `effort`/`efforts` (installed `dist/index.d.ts:552-555`), so `resolveRequestedEffort` -> `this.config.effort` is `undefined` and `ensureEffort` returns early (silent no-op by SDK design). Live corroboration with `KIRO_ACP_DEBUG_FILE`: intercept records written for every turn, zero effort activity/failure records. |
| 8 | Process count: duplicate/unowned ACP instance? | PASS (answer: NO extra unowned instance) | Controlled A/B at the pinned SHA. (A) `opencode.provider.dynamic` ENABLED, one prompt turn on a variant session: 2 owned ACP instances (`kiro-cli acp --agent opencode-d796090c` with 12 MCP tools + `opencode-ab261ede` with 0 tools), each with its `kiro-cli-chat` child. (B) same scenario with `"-opencode.provider.dynamic"` in `plugins` (verified removed: 68 plugins, `kiro` present, `opencode.provider.dynamic` absent): **identical** 2 instances (`opencode-c36eee57` 12 tools + `opencode-f4b80bd3` 0 tools). => DynamicProviderPlugin creates NO extra live ACP process (it runs first, but our hook always overwrites `event.sdk` and its lazy instance never spawns). **Severity: LOW / informational.** The real second instance is the plugins own per-options SDK cache: the ephemeral summary/title turn (debug record `affinityOut ...:ephemeral, tools:0`) has a different `stableOptionsKey` -> second owned instance -> 2 `kiro-cli acp` + 2 `kiro-cli-chat` per session. All were shut down with the host (post-shutdown `ps` empty, no orphans). |
| 9 | TUI slots: sidebar credits box + composer-top chip render | FAIL (blocker B2) | Real Bun host + real pty (220x60 via `@lydell/node-pty`, hermetic config, `--standalone -s <session with credits>`): the TUI booted and the sidebar rendered its built-in boxes (Context / 19,947 tokens / $0.00 spent / LSP), the session transcript rendered — but **no Kiro credits box and no composer-top chip**. Root cause proven directly: from the installed plugin location `require.resolve` fails for `@opentui/solid`, `solid-js` and `@opentui/core` (`MODULE_NOT_FOUND`), and invoking the packaged `dist/tui.js` `setup()` there fails with `Cannot find package "@opentui/solid"` — the host installs package plugins into an isolated `$XDG_CACHE_HOME/opencode/packages/<spec>` tree that contains only the tarballs own dependencies, and those three are declared devDependencies/bundler externals. So the TUI plugin cannot activate at all when installed from the tarball. See blocker B2. |
| 10 | Credits live + reload/durable sync (no double count) | PASS (durable) / PARTIAL (TUI-live) | Durable server-side truth confirmed key-unwrapped at the pinned SHA: `GET /api/session/<id>/message` assistant content part = `{"type":"text","text":"OK.","state":{"credits":0.08234691218905472,"creditsUnit":"credit"}}` — i.e. `part.state.credits` / `part.state.creditsUnit`, no `metadata.kiro`, on a **text-only** response (finish `stop`, no tool parts), which is exactly the case the v1 build could not show. Re-fetching the message list after the turn returns the same single carrier (no duplicate credit part -> no double count on durable sync). The TUI-side transient-then-reconcile path could not be exercised live — see item 9 / blocker B2. |
| 11 | Logout: runtime-only models disappear | PASS | Before logout `GET /api/model` -> 19 models with `providerID:"kiro"`; `DELETE /api/credential/cred_facccdddc001dQLuY0heBR4t82` -> 204; ~8 s later `GET /api/model` -> **0** kiro models and `GET /api/integration/kiro` -> `connections: []`. Runtime-only, self-registered models disappear on the logout event with no host restart and no leftover catalog entries. |
| 12 | Worktree removed; opencode clone byte-identical before/after | PASS | Before: worktree `.../tmp.nw1pvoUIao/opencode-e2e` @ `010133f6df`, clone on `feat/kiro-provider` @ `3a68247163`, `git status --short` EMPTY. `git worktree remove --force` + `git worktree prune` -> worktree gone; remaining worktrees are only the pre-existing ones (main clone, unrelated `T/opencode/oc-v2` @ `fd97d789ef` (untouched), `opencode-bundled`, `opencode-stock`). After: clone still on `feat/kiro-provider` @ `3a68247163` with `git status --short` EMPTY — byte-identical. All host artifacts (worktree, hermetic XDG/HOME config, package cache, tarball install, pty capture) lived in temp paths; the real user config was never touched. |

## Summary

11 of 13 checklist rows PASS, 1 PARTIAL, 2 FAIL. The server half of the plugin
(entry resolution, setup/cleanup, integration + login, self-registration,
runtime models, key-unwrapped durable credits, logout) works end-to-end against
OpenCode at `010133f6df21ab273b260327670f19c95e7a167c`. Two defects block the
TUI half and the effort-variant path; both are described below with root cause
and candidate fixes. Neither is a plan failure per immutable requirement 16 —
Corvus + user decide.

## Upstream blockers / deviations from migration doc

### B1 — Tarball plugin specs must be `name@file:<path>`; a bare `file:<path>` spec fails (UPSTREAM, low severity, WORKED AROUND)

The install/config instructions (task file Step 2, and `OPENCODE_V2_MIGRATION.md`
install prose) say to point `plugins[].package` at "the abs path to the tgz or a
`file:` spec". Both plain forms fail at the pinned SHA:

- absolute path (`/…/opencode-kiro-0.5.0-beta.1.tgz`): `PluginSupervisor.load`
  treats any absolute target as a local module file (`supervisor.ts:170-171`,
  `pathToFileURL(target)`) and tries to `import()` the tarball.
- `file:/…​.tgz`: `Npm.add` derives the package name with `npa(spec).name`, which
  is `null` for an unnamed `file:` spec, so it falls back to the whole spec as
  the name and `Arborist.reify` fails →
  `WARN failed to load plugin … cause=Cause([Fail(NpmInstallFailedError)])`.

Working form (used for every result in this report, both server and TUI config):

```json
{ "plugins": [{ "package": "opencode-kiro@file:/abs/path/opencode-kiro-0.5.0-beta.1.tgz", "options": {} }] }
```

Action: fix the README/`OPENCODE_V2_MIGRATION.md` install snippet (doc-only), and
consider a tarball-resolution assertion in task 14. A published-registry install
(`"opencode-kiro@0.5.0-beta.1"`) is unaffected.

### B2 — TUI plugin cannot activate when installed from a package: `@opentui/solid` / `solid-js` / `@opentui/core` are unresolvable (PLUGIN-SIDE, HIGH severity, BLOCKS items 9 and the live half of 10)

The host installs each package plugin into an isolated tree
(`$XDG_CACHE_HOME/opencode/packages/<spec>/node_modules/opencode-kiro`) that
contains only the tarball's own declared dependencies. `@opentui/solid`,
`solid-js` and `@opentui/core` are declared as devDependencies + bundler
externals, so from that location:

- `require.resolve("@opentui/solid" | "solid-js" | "@opentui/core")` →
  `MODULE_NOT_FOUND`
- `dist/tui.js` imports fine, but `setup()` throws
  `Cannot find package '@opentui/solid'` (the lazily-imported solid
  `createSignal` version counter), i.e. the TUI plugin never activates and both
  slots are never registered.

Confirmed visually: under a real 220x60 pty the sidebar shows only built-in
boxes; no credits box, no composer chip.

Candidate fixes (design decision needed — the pinned host patches
`solid-js@1.9.10` in-workspace while `@opentui/solid@0.4.5` peers `1.9.12`
exactly, so a second solid instance is a real risk, see Risk 3/4):

1. Declare `@opentui/solid` + `solid-js` (+ `@opentui/core` if the views need it)
   as real `peerDependencies` so the host's npm install pulls them into the
   plugin tree — resolves the crash, but introduces a second solid/renderer
   instance whose interop with the host renderer must then be host-verified.
2. Drop the plugin's own solid import (use only host-provided reactivity/render
   surface from `@opencode-ai/plugin/tui`), keeping the design free of
   `context.renderer`/`context.theme` dependence (immutable requirement 12).
3. Ask upstream to expose the host's `@opentui/*` + `solid-js` to plugin
   entrypoints (true peer resolution for TUI plugins).

Owner: TUI tasks (08/09/10) once Corvus + user pick an option. Note the unit
suites cannot see this — it only appears when the packed tarball is installed by
the host, which is exactly what this task exists to catch.

### B3 — Effort variants are inert at runtime: `providerOptions.kiro.reasoningEffort` is never populated for third-party AI-SDK packages, and the settings key names differ (MIXED upstream + plugin-side, MEDIUM severity, BLOCKS item 7)

The migration doc assumes a variant's `settings.reasoningEffort` reaches the SDK
as `providerOptions.kiro.reasoningEffort`. At the pinned SHA it cannot:

- `model-resolver.ts:99-110` builds `providerOptions` **only** for
  `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/openai-compatible`; for
  `aisdk:kiro-acp-ai-provider` it returns `undefined` (upstream limitation).
- The surviving path is variant settings → `model.settings` (`withVariant`) →
  plugin `aisdk` hook `event.options` → `createKiroAcp(event.options)`. But the
  plugin writes `reasoningEffort` while `KiroACPProviderSettings` names it
  `effort` / `efforts` (installed `dist/index.d.ts:552-555`), so
  `resolveRequestedEffort()` → `this.config.effort` is `undefined` and
  `ensureEffort()` returns early — silently, by SDK design.

Net effect: variant selection is recorded on the session and the assistant
message, and the turn succeeds, but the requested effort never reaches kiro-cli.

Cheapest fix (plugin-side, no SDK change, satisfies immutable requirements 8/14):
map the effort in the `aisdk` hook when constructing the provider, e.g. pass
`{ ...options, effort: options.reasoningEffort }` (or emit `effort` from the
catalog transform instead of `reasoningEffort` and keep the variant-id semantics).
Either way, `settings.reasoningEffort` must stop being the only carrier. Owner:
task 06 (catalog/discovery) or task 07 (aisdk hook), Corvus's call. A per-call
override would additionally need upstream to widen `providerOptions` support.

### Non-blocking observations

- **O1 — no root (`.`) export**: `Npm.add(spec, { subpaths: ["server", ""] })`
  resolves `./server`; the root fallback yields no entrypoint because the exports
  map deliberately has no `"."` key. Harmless (`./server` is tried first) but the
  "root-fallback also works" question from the checklist answers *no*.
- **O2 — plugin id asymmetry**: the server plugin's id is `kiro` while the TUI
  plugin's id is `opencode-kiro`. Both hosts accept it, but `cli.json`/`opencode.json`
  enable/disable directives (`"-<id>"`) therefore need different ids per host.
  Worth a doc line, or aligning the ids.
- **O3 — first request pays plugin install**: the first request that flushes the
  supervisor blocks for the whole cold arborist install (~86 s here) and
  `GET /api/model/default` has a hard 5 s timeout, so it returns
  `ServiceUnavailableError "Model catalog initialization timed out"` on a cold
  cache. Upstream behavior, unrelated to plugin code; retry succeeds.
- **O4 — TUI model validation races the catalog**: launching the TUI on a
  kiro session before the server catalog is populated renders
  `Model kiro/claude-sonnet-5 is not valid` and falls back to the default model.
  Upstream ordering, no plugin action.
- **O5 — one ACP instance per distinct options key**: the ephemeral
  summary/title turn has different provider settings than the main turn, so the
  plugin's `stableOptionsKey` cache creates a second owned `kiro-cli acp`
  instance (2 `kiro-cli` + 2 `kiro-cli-chat` per active session). Both are owned
  and both are torn down with the host; consider whether the cache key should
  ignore turn-scoped settings.

## Fix verification — B2 Option 1 (re-run at 7df3ea2)

**Scope**: re-check of checklist items 9 and 10 (TUI-live half) only, after the B2
fix moved `@opentui/solid@0.4.5` + `solid-js@1.9.12` from devDependencies into
`dependencies` (still tsup externals, never bundled; `@opentui/core@0.4.5`
arrives transitively via `@opentui/solid`). Same harness shape as the original
run (detached read-only worktree at the pinned SHA, hermetic HOME/XDG, empty npm
cache, `name@file:<abs tgz>` spec per B1). The original rows above are history and
are left untouched.

**Plugin SHA under test**: `7df3ea2` (branch `opencode-v2`, clean)
**Host SHA**: `010133f6df21ab273b260327670f19c95e7a167c` (unchanged pin)
**Date**: 2026-07-29

### VERDICT

**B2 fix FAILED — pivot to Option 2 (do not ship `7df3ea2` as-is).**

Option 1 fixes the *resolution* half of B2 and nothing else. The packaged plugin
now installs its dependencies (V1) and `setup()` finally runs and registers both
slots (V2) — but the moment the host asks the plugin to render, the plugin's own
`@opentui/solid` throws `No renderer found` and **the entire host TUI crashes**
(`OpenCode crashed — An unexpected error stopped the session`). A control run with
the plugin disabled boots and renders normally on the same session, so the crash is
unambiguously ours.

This is a **net regression in blast radius**: at `c9a4e0c` the failure was silent
non-activation (no credits surfaces, host TUI otherwise fully usable); at
`7df3ea2` the plugin activates and takes the host TUI down with it. Whatever is
decided next, `7df3ea2` is strictly worse to ship than the original state.

The finding is also stronger than "1.9.10 vs 1.9.12 skew": the failure is solid
**module-instance identity**, not version skew. `@opentui/solid`'s `createElement`
resolves the live renderer through `useContext(RendererContext)`, which depends on
(a) solid's module-global `Owner` and (b) the `createContext` id — both of which are
per-copy. The host's owner lives in its `solid-js@1.9.10` copy and its provider
populated *its* `RendererContext` id; the plugin's `solid-js@1.9.12` copy sees
`Owner === null` and a different context id. **Aligning the plugin to the host's
exact patched `solid-js@1.9.10` would therefore not help either**, so no variant of
Option 1 that ships the plugin's own `@opentui/solid` + `solid-js` can work. The
exact-peer mismatch noted in B2's original write-up (and the host's own violation of
`@opentui/solid@0.4.5`'s `solid-js: "1.9.12"` exact peer) is a red herring.

Consequently the remaining viable directions are B2's **Option 2** (build no nodes
with a plugin-owned solid/opentui — use only a host-provided render surface) or
**Option 3** (upstream exposes the host's `@opentui/*` + `solid-js` to plugin
entrypoints so `require("@opentui/solid")` from a plugin resolves to the *host's*
instance). For Option 2, note the installed `@opencode-ai/plugin/tui` context does
expose `ui.renderer: CliRenderer` (`dist/tui/context.d.ts:270`) while `Slot`'s
`JSX.Element` is a types-only import from `@opentui/solid`
(`dist/tui/context.d.ts:3,99`) — i.e. a host-provided surface exists, but using it
touches the `context.renderer` avoidance in immutable requirement 12, so this needs
a Corvus + user decision rather than a unilateral pivot. Owner: TUI tasks
(08/09/10).

Ordering caveat for whoever re-runs this: the credits/durable half is unaffected and
was re-confirmed green at `7df3ea2` (V4), so only the TUI render path is at stake.

### Re-verification results

| # | Check | Result | Evidence |
|---|-------|--------|----------|
| V1 | Rebuild + `npm pack` + hermetic host install at `7df3ea2` | PASS | `npm run build` exit 0; `npm pack` → `opencode-kiro-0.5.0-beta.1.tgz` (10 files, 12,755 B, dist-only). Hermetic XDG (`config`/`data`/`cache`/`state` in temp, `$XDG_CACHE_HOME` empty at start), real `HOME` kept so `kiro-cli` auth stays usable (opencode resolves all its dirs through `xdg-basedir`, `packages/util/src/global.ts`). Host arborist install of `opencode-kiro@file:<abs tgz>` succeeded; `GET /api/plugin` → 69 plugins incl. `{"id":"kiro"}`. **The B2 fix works at the install layer**: the isolated tree `…/packages/opencode-kiro@file:<tgz>/node_modules/` now contains `@opentui/solid@0.4.5`, `@opentui/core@0.4.5` (transitive, + native `@opentui/core-darwin-arm64@0.4.5`) and `solid-js@1.9.12` — the three modules that were `MODULE_NOT_FOUND` in the original run. |
| V2 | TUI plugin activation in the real host under a pty (orig. item 9) | FAIL (activates, then crashes the host TUI) | Real Bun host TUI at the pinned SHA under a real pty (`script(1)`, `stty cols 220 rows 60`, hermetic XDG, `--standalone -s ses_052e69995ffeGHTF2xySQmH3O9` — a session carrying durable Kiro credits), cwd = worktree root. `setup()` **does** now run and **does** register both slots — proven by the host invoking the plugin's own `sidebar.content` render callback (`…/node_modules/opencode-kiro/dist/tui.js:116:20` appears in the crash stack). But the first `createElement` inside that callback throws and the host dies: the pty shows `OpenCode crashed` / `An unexpected error stopped the session` / `Error: No renderer found`. **Neither slot ever renders, and the whole TUI is now unusable** — the built-in sidebar boxes never paint either (`Context`/`spent`/`LSP` = 0 occurrences in the capture). Control run, identical session/harness with `cli.json` `plugins: []`: no crash, no `No renderer found`, built-in sidebar renders (`Context`, `spent`, `LSP` present) → the crash is caused by the plugin, not the harness or the session. **Blast radius is worse than the original B2**: before, `setup()` threw and the plugin silently failed to activate (host TUI kept working); now the plugin activates and takes the host TUI down with it. |
| V3 | Solid/renderer interop: host patched `1.9.10` vs plugin `1.9.12` | FAIL — the two instances do **not** coexist | The crash stack captures the instance boundary in one frame chain: host `solid-js@1.9.10` drives the render (`…/opencode-e2e/node_modules/.bun/solid-js@1.9.10/node_modules/solid-js/dist/solid.js` → `runComputation` → `untrack` → `createRoot:189`), which calls the plugin's slot callback (`…/node_modules/opencode-kiro/dist/tui.js:116`) → `createCreditsBoxView` (`dist/credits-box-view-FIHO6TR6.js:10`) → **the plugin's own** `@opentui/solid` (`…/hermetic/cache/opencode/packages/opencode-kiro@file:…/node_modules/@opentui/solid/src/reconciler.ts:196`) → `throw new Error("No renderer found")`. Root cause: `@opentui/solid`'s `createElement` obtains the live renderer with `useContext(RendererContext)`, and `useContext` resolves against **solid's module-global `Owner`** — the plugin's `solid-js@1.9.12` copy has `Owner === null` while the host's owner lives in its `1.9.10` copy, and the plugin's `RendererContext` is a *different* `createContext` id than the one the host provider populated. Both halves of that lookup fail across the module boundary. **This is version-independent**: pinning the plugin to the host's exact `solid-js@1.9.10` (patch included) would not help, because the failure is module-*instance* identity, not version skew — so the `1.9.10`-vs-`1.9.12` skew and the host's exact-peer violation are red herrings, and **no variant of Option 1 that ships the plugin's own `@opentui/solid`/`solid-js` can work**. Note `@opentui/solid` also imports `solid-js/dist/solid.js` by deep path, so each copy hard-binds to the copy of solid beside it. Secondary confirmation that the tree really is duplicated: the plugin install carries its own `@opentui/core@0.4.5` + native `@opentui/core-darwin-arm64@0.4.5` alongside the host's. |
| V4 | Live credits (orig. item 10, TUI-live half) | BLOCKED by V2/V3 (not by auth) | `kiro-cli` auth **was** available this run (kiro-cli 2.15.1, IAM Identity Center, profile `KiroProfile-us-east-1`), the integration connected (`mode:"auto"`, "Already authenticated with Kiro CLI." → credential `cred_fad16d6520019Tl6XM64qOfuFG`), 19 kiro models self-registered, and a **text-only** turn succeeded (`finish:"stop"`, no tool parts), re-confirming the durable carrier key-unwrapped at `7df3ea2`: `content[0] = {"type":"text","text":"OK.","state":{"credits":0.10599419245439472,"creditsUnit":"credit"}}`. The TUI-live/transient half still cannot be exercised: the TUI crashes before painting anything (V2), so the `session.text.ended` transient path remains unverified. Not fabricated, not auth-blocked — blocked by the interop failure. |
| V5 | No orphaned kiro-cli/ACP/server processes; worktree removed; clone byte-identical | PASS (with a pre-existing-orphan note) | Post-run `ps`: **zero** `kiro-cli acp` / `kiro-cli-chat` processes, zero servers from this run (my `serve --port 41777` and both `--standalone` TUIs exited/were signalled). Two `spawn-helper` strays from my own abandoned `@lydell/node-pty` probes were terminated (PIDs 50898/50992 → gone). Worktree: `git worktree remove --force` + `git worktree prune` → gone; the unrelated `T/opencode/oc-v2` @ `fd97d789ef` is still listed and was never touched, as are `opencode-bundled` / `opencode-stock`. Clone byte-identical: `feat/kiro-provider` @ `3a68247163f730a0ffc62135b40e8bdfd7c266c5` with **empty** `git status --porcelain` both before and after (verified at start and at teardown). **Note (not from this run)**: two host servers started 09:12/09:14 — before this run began — are still alive, one explicitly rooted at the *original* run's now-deleted worktree `T/opencode/tmp.nw1pvoUIao/opencode-e2e` (`serve --service`, PID 27548) plus `serve --port 4477` (PID 27143). They are leftovers predating this session, so they were reported rather than killed; they also mean `run`/TUI invocations must always pass `--server`/`--standalone` to avoid binding to that stale background service. |

## Answers to open questions

- **models.dev Kiro entry present in the pinned catalog?** **NO.** The live
  catalog the host fetched and cached at `$XDG_CACHE_HOME/opencode/models.json`
  (3.28 MB, 2026-07-29) has 174 providers, no `kiro` provider key and no
  occurrence of the string "kiro" anywhere. The enrichment branch is therefore
  dead in practice; the plugin's minimal self-registration fallback is the live
  path and it produced 19 runtime models with effort variants (5-6 variants each
  on the reasoning-capable models, `settings.reasoningEffort` per variant).
- **Duplicate ACP process from `DynamicProviderPlugin`?** **NO extra unowned
  instance.** Process counts are identical with the dynamic provider plugin
  enabled and with it removed via `"-opencode.provider.dynamic"` (2 owned
  instances in both runs, same tool/tool-less split). It registers before package
  plugins, but the Kiro hook always overwrites `event.sdk` and the dynamic
  plugin's provider object never spawns a process. Severity: LOW /
  informational — no migration change required. The second instance seen in both
  runs is the plugin's own per-options SDK cache (see O5), not an unowned
  provider, and it is cleaned up with the host.

## Re-verification at b47cfbee7c (re-pin, iteration 2)

**Scope**: full host e2e re-verification at the NEW pinned host SHA after the
re-pin + TUI rework (Phase 4 gate, iteration 2). Same harness shape as the runs
above (detached read-only worktree, hermetic XDG with real `HOME` kept for
kiro-cli auth, empty `$XDG_CACHE_HOME` at start, `name@file:<abs tgz>` spec per
B1, `script(1)` pty at 220x60, explicit `--port`/standalone to avoid the two
pre-existing stale background servers noted in V5). Prior sections are history
and are left untouched.

**Plugin SHA under test**: `45e5617` (branch `opencode-v2`, clean; tarball
re-packed FRESH at this SHA — 9 files, 12.6 kB, the composer-chip lazy chunk is
gone by design)
**Host SHA**: `b47cfbee7c4fd24e5d73e5753b4755db62a92a63` (NEW pin; delta commits
`fe91698ed6` ensureRuntimePluginSupport, `44cd984589` SlotMap,
`27e7b0558a` supervisor refactor all confirmed ancestors)
**Date**: 2026-07-29

### Re-verification results (iteration 2)

| # | Check | Result | Evidence |
|---|-------|--------|----------|
| R1 | Worktree at exact new SHA; host builds/boots | PASS | `git worktree add $TMP/opencode-e2e b47cfbee7c…` → `rev-parse HEAD` = `b47cfbee7c4fd24e5d73e5753b4755db62a92a63`; clone stayed on `feat/kiro-provider` @ `3a68247163` with empty `git status --porcelain`. `bun install` (5036 packages), `bun run dev --help` from worktree root prints "OpenCode 2.0 preview command line interface". |
| R2 | Hermetic packed-tarball install; server entry loads; TUI entry resolves | PASS | Fresh `npm run build` + `npm pack` at `45e5617` (9 files, 12.6 kB, dist-only). Hermetic XDG root, empty cache; server `serve --port 42191`; `GET /api/plugin` → 69 plugins incl. `{"id":"kiro"}` (server entry loaded, setup ran). Isolated tree `…/packages/opencode-kiro@file:…/node_modules/` contains `@opentui/solid@0.4.5`, `solid-js`, `@opentui/core` (+ native), `kiro-acp-ai-provider`; plain-Node `import(dist/tui.js)` and `import(dist/server.js)` both → `{id,setup}`. **New at this SHA**: `serve` prints a server password and all `/api/*` requests require HTTP Basic auth (`opencode:<printed password>`); API responses are now wrapped as `{location,data}` (was a bare array). |
| R3 | THE VERDICT — TUI renders the Kiro sidebar credits box without crashing the host | PASS (plugin rework verified) / with upstream caveat B4 for `file:`-tarball installs | Real Bun host TUI at `b47cfbee7c` under `script(1)` pty 220x60, hermetic XDG, `--standalone -s <session with durable credits>`. **With the plugin loaded from a colon-free path** the sidebar renders `Kiro` / `0.08 credits` (matches the session's durable 0.0821…) AND the host built-ins still paint (`19,874 tokens`, `$0.00 spent`, `LSP`) — 0 occurrences of `crashed`/`No renderer found` in the capture. `ensureRuntimePluginSupport` redirection verified directly: a probe module inside the plugin tree importing `solid-js` receives the HOST's instance (`createSignal` identity === host's). The plugin's own-node rendering design works as intended at this SHA. **Caveat (upstream, B4)**: when the same tarball is installed by the host's package channel, the install dir is `…/packages/opencode-kiro@file:/abs/path.tgz/…` — the `:` in that dirname defeats the loader shim's exact-path `onLoad` rewrite, the plugin's OWN `@opentui/solid` loads, and the TUI crashes with `No renderer found` exactly like the old V2. Same tree copied to a colon-free path → renders; registry-style dirname (`opencode-kiro@0.5.0-beta.1`, colon-free) → host-solid identity TRUE. Root cause isolated with minimal Bun probes: eager AND lazy `build.onLoad` with resolved+realpath filters fire for colon-free paths and never fire for the `@file:`-colon path. Published-registry installs are colon-free and unaffected. |
| R4 | Live credits (transient) + durable reload, no double count | PASS | Six live TUI sessions against one server (`--server http://…:42194`, `OPENCODE_PASSWORD` env): text-only turns fired via `POST /api/session/:id/prompt` while the TUI was attached. Terminal-emulator replay (pyte, 220x60) of the pty captures shows the box live-tracking every turn **in order** — `0.08 → 0.16 → 0.28 → 0.42 → 0.59 → 0.8 credits` — matching the durable sums exactly (final durable: 5 credit parts, Σ=0.80…); plain-text grep misses these because the renderer repaints only changed cells. Wire check: `session.text.ended` SSE event carries `data.state = {credits, creditsUnit}` (captured live), the upstream TUI reducer still drops `state` at this SHA (`packages/tui/src/context/data.tsx:566` copies only `text`) → the transient-store workaround remains required and works. Reload/no-double-count: every fresh TUI mount painted exactly the durable sum current at mount (0.08 / 0.28 / 0.42 / 0.59), never a doubled total; instrumented diagnostic copy (temp-only, not the artifact) confirmed the reconcile path drops transients once the durable part lands. |
| R5 | Server spot-checks at the new SHA (incl. supervisor refactor `27e7b0558a`, B3 effort fix) | PASS | (a) Integration: `GET /api/integration` (177) has `kiro` + method label "Kiro CLI Login" + sidebar consent prompt. (b) Login: `POST …/connect/oauth {sidebar:"no"}` → "Already authenticated with Kiro CLI." → credential stored; credential persists across server restarts (19 models re-registered from cold start without re-login). (c) Models: **19** kiro models; 9 with variants; variants now emit `settings.effort` (`low/medium/high/xhigh/max`) — the B3 catalog-side fix is live. (d) **B3 verified END-TO-END on the wire**: with a PATH-shim teeing kiro-cli's ACP stdin, a `#high`-variant turn produced `{"method":"_kiro.dev/commands/execute","params":{…,"command":{"command":"effort","args":{"value":"high"}}}}` for BOTH the main and the ephemeral client, and the turn completed with durable credits — `settings.effort` → aisdk hook `event.options` → `createKiroAcp(options).config.effort` → `setEffort` reaches kiro-cli. (e) Processes: exactly 2 owned `kiro-cli acp` instances per active session (main + ephemeral per O5), both children of the server's bun process, no unowned/duplicate instance, all torn down with the host. (f) Logout: `DELETE /api/credential/…` → 204; 19 → **0** kiro models in ~10 s, `connections: []`. |
| R6 | Cleanup: no orphans from this run; worktree removed; clone byte-identical | PASS | All 6 TUI+script pairs, 4 servers (ports 42191-42194) and their ACP children from this run terminated — post-run `ps`: zero `kiro-cli acp`/`kiro-cli-chat`, zero servers from this run. The two PRE-EXISTING orphan servers (PIDs 27548 / 27143, predate this session) were left untouched as instructed. `git worktree remove --force` + `prune` → worktree gone; remaining worktrees = main clone + untouched `T/opencode/oc-v2` @ `fd97d789ef` + `opencode-bundled` + `opencode-stock`. Clone: `feat/kiro-provider` @ `3a68247163…` with **empty** `git status --porcelain` before AND after. All artifacts (worktree, hermetic XDG, tarball install, pty captures, probes, wire shim) lived in temp paths. |

### VERDICT (iteration 2)

**RE-PIN VERIFIED.** The plugin rework at `45e5617` does exactly what the re-pin
promised: with `ensureRuntimePluginSupport` active, the plugin's solid imports
receive the HOST's module instances, the sidebar `Kiro` credits box renders and
live-updates without crashing the host, built-ins keep painting, the durable
total never double-counts, effort variants reach kiro-cli as `effort` on the
wire, and the server half is fully green. One NEW upstream defect was found and
isolated (B4 below): the host's `file:`-tarball package-install channel breaks
the loader shim because the install dirname contains a `:`; registry installs
are colon-free and unaffected. This is an upstream/host-layout defect, not a
plugin defect — the identical tree renders from any colon-free path.

### B4 — `file:`-tarball plugin installs defeat the OpenTUI loader shim: `:` in the install dirname prevents the runtime rewrite (UPSTREAM, MEDIUM severity, affects only `name@file:<tgz>` installs)

At `b47cfbee7c` the host installs package plugins into
`$XDG_CACHE_HOME/opencode/packages/<spec>/…` where `<spec>` is the raw plugin
spec (`packages/util/src/npm.ts:86`; `sanitize()` only rewrites illegal chars on
win32, line 47). For `opencode-kiro@file:/abs/path.tgz` the resulting directory
path contains a `:`. The `@opentui/core` runtime plugin
(`ensureRuntimePluginSupport`) rewrites external-plugin imports of
`solid-js`/`@opentui/*` via exact-path `build.onLoad` loaders — and those
loaders never fire for paths containing the colon segment, so the plugin's own
dependency copies load and the first `createElement` dies with `No renderer
found`, crashing the whole TUI (same blast radius as the old V2). Probes:
identical tree at a colon-free path → host-instance identity TRUE + real host
renders; registry-style dirname `opencode-kiro@0.5.0-beta.1` → TRUE; the
`@file:` path → FALSE. Minimal Bun 1.3.14 repro: eager `onLoad` with
resolved+realpath exact filters fires for colon-free paths, never for the
colon path. Consequences: (1) published-registry installs (the shipping
channel) are unaffected; (2) local `file:`-tarball validation of the TUI half
must load the plugin from a colon-free path (e.g. `plugins[].package` pointing
at an extracted tree's `dist/tui.js`) until upstream sanitizes the dirname or
keys the loader differently. Candidate upstream fix: sanitize `:` in
`Npm`'s package cache dirname on all platforms (it is already `_`-rewritten on
win32).

### Upstream deviations noticed at `b47cfbee7c` (vs the prior pin)

- **Server auth**: `serve` now prints a per-boot password; every `/api/*` call
  requires HTTP Basic auth (`opencode:<password>`; `OPENCODE_PASSWORD` env for
  TUI/clients attaching via `--server`).
- **API envelope**: responses are wrapped as `{location, data}` (previously bare).
- **Prompt API reshaped**: model moved out of the message call —
  `POST /api/session` accepts `model` (`Model.Ref` incl. `variant`),
  `POST /api/session/:id/prompt` takes `{text, files?, agents?, …}`,
  `POST /api/session/:id/model` switches it; the old
  `POST /api/session/:id/message {model, parts}` shape is gone.
- **O4 still live and stickier**: launching the TUI on a kiro session before the
  catalog is warm falls back to the default model AND **persists** that fallback
  onto the session (`session.switchModel`); subsequent prompts then fail with
  "The provided model identifier is invalid" until the model is switched back.
- **Reducer bug confirmed still live** (`data.tsx:566` drops `state` on
  `session.text.ended`) — the transient workaround stays required, and works.

## BUNDLED_E2E

**Task**: opencode-v2-migration-20 — bundled single-platform binary + FULL-INTEGRATION e2e
**Worktree**: `/Users/user/Documents/1-coding/open-source/opencode-v2-kiro` @ `4fbca30fd9` (`feat/kiro-provider-v2`, wired built-in via task 19, file: iteration)
**Plugin source**: `opencode-kiro` @ `0636e77` (branch `opencode-v2`) via `file:` dep + workspace overrides
**models.dev artifact**: `OPENCODE_MODELS_PATH=/Users/user/Documents/1-coding/open-source/models.dev/.artifacts/api.json` (18 kiro models, all with `limit.context`, 8 with effort `reasoning_options`)
**Build command**: `cd packages/cli && bun run script/build.ts --single`
**Date**: 2026-07-29
**Method**: bundled binary run with hermetic XDG (temp `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_CACHE_HOME`/`XDG_STATE_HOME`, real `HOME` kept for kiro-cli auth), NO `plugins` config anywhere; `script(1)` pty 220x60 + pyte replay; fresh ports; explicit `--server`/standalone (pre-existing orphan PIDs 27143/27548/87546 and unrelated user processes ignored, untouched).

### Checklist results (bundled)

| # | Item | Result | Evidence |
|---|------|--------|----------|
| B-0 | Binary builds via `script/build.ts --single` (time/size recorded) | PASS | `bun run script/build.ts --single --skip-install` (deps pre-installed by task 19) exit 0 in **2.17 s**; output `dist/cli-darwin-arm64/bin/opencode2` = **149,671,778 B (143 MB)**; boots: `opencode2 v0.0.0-feat/kiro-provider-v2-202607291439`. Note: the build bakes a live models.dev snapshot (`script/generate.ts` fetches `https://models.dev/api.json` at build time), but `OPENCODE_MODELS_PATH` outranks it at runtime (`server-process.ts:90-94`) — the enrichment A/B in B-4 confirms the baked snapshot has no usable kiro entry. |
| B-1 | Binary boots; kiro server plugin registered BUILT-IN (no runtime npm install, no `plugins` config) | PASS | Hermetic `serve --port 43103`, cwd = hermetic temp dir: `GET /api/plugin` → **69 plugins incl. `kiro` at index 60** (after `opencode.provider.dynamic` idx 44 — built-in `pre` array order). Zero config files in hermetic `XDG_CONFIG_HOME` (verified empty), **no `$XDG_CACHE_HOME/opencode/packages` dir created** (no runtime npm/arborist install), 0 `loading plugin` package-channel log lines. Harness note: first boot from the repo cwd leaked the repo's own `.opencode/opencode.jsonc` (`plugin:["corvus-ai@beta"]`) — rerun from a hermetic cwd with a fresh cache; all recorded results use the hermetic cwd. |
| B-2 | TUI boots; `opencode-kiro` TUI plugin active as builtin (source: "builtin") | PASS | Real TUI from the bundled binary under `script(1)` pty 220x60 (`--server http://127.0.0.1:43106 -s <session>`): boots, transcript + host built-ins paint, AND the plugin's `Kiro` sidebar box renders (B-6). Builtin provenance: hermetic config contains ZERO files (no `cli.json`, no `plugins` anywhere), so the only possible source is the compiled-in registration — worktree `packages/tui/src/plugin/builtins.ts:10,22` (`import KiroTui from "opencode-kiro/tui"` appended to `builtins`); server half likewise `packages/core/src/plugin/internal.ts:30,157`. Cross-check: the `"-opencode-kiro"` builtin-id disable directive is honored (B-7). `opencode2 plugin list` (server side) → `kiro` among 69 active. |
| B-3 | Auth: Kiro CLI Login present + works | PASS | `GET /api/integration` (169) → `kiro` with method `{id:"kiro-cli-login", type:"oauth", label:"Kiro CLI Login"}` + sidebar consent prompt. `POST /api/integration/kiro/connect/oauth {methodID:"kiro-cli-login",inputs:{sidebar:"no"}}` → 200 in **0.81 s**, `mode:"auto"`, `url:"https://kiro.dev/docs/cli/"`, "Already authenticated with Kiro CLI." (kiro-cli 2.15.1, IAM Identity Center); `GET /api/integration/kiro` → `connections:[{type:"credential",id:"cred_fae56101d001A6qUYt1VLkqR7F",label:"default"}]`. |
| B-4 | Models: ENRICHMENT path — rich models.dev metadata, context windows from api.json, catalog∩runtime counts recorded | PASS | **Intersection: catalog 18 ∩ runtime 19 = 18 registered.** Runtime lineup (same `listModels` call the plugin makes, via kiro-acp-ai-provider): **19** models with raw `name === id` (incl. `claude-opus-5`, absent from the artifact). `GET /api/model` with `OPENCODE_MODELS_PATH=<artifact>` → **18** kiro models, `claude-opus-5` correctly dropped, artifact-only ids: none, registered-only: none. All 18 carry models.dev display names ("Claude Sonnet 5", "GPT-5.6 Luna", "Deepseek v3.2"…) and api.json context windows (1M/272k/256k/200k/196k/164k) — 0 name/context mismatches vs artifact. Effort models carry variants (`claude-sonnet-5`: low/medium/high/xhigh/max → `settings.effort`). **A/B control (same binary, hermetic env, NO `OPENCODE_MODELS_PATH`)**: **19** models, raw names (`name:'claude-sonnet-5'`), `ctx=0` — the self-registration fallback is visibly poorer, proving the 18-model run is the ENRICHMENT path, not fallback. |
| B-5 | Effort variant on the wire (ACP stdin shim) for an effort-capable model | PASS | PATH-shim `kiro-cli` teeing ACP stdin (technique from R5d), server relaunched with shimmed PATH. Session created with `model:{providerID:"kiro",id:"claude-sonnet-5",variant:"high"}`; text-only prompt turn. Wire captures show `{"method":"_kiro.dev/commands/execute","params":{…,"command":{"command":"effort","args":{"value":"high"}}}}` in BOTH ACP clients' stdin (main + ephemeral), plus `commands/options` polling for `effort`. Turn completed `finish:"stop"` with the assistant recording `model:{…,variant:"high"}` and durable `state:{credits:0.0604…,creditsUnit:"credit"}`. |
| B-6 | TUI sidebar credits render live on a text-only turn; no crash; single solid instance (compiled-in) | PASS | pty capture (pyte replay, 220x60): at mount the sidebar shows `Kiro` / `0.06 credits` (= durable sum); after a live text-only turn fired via `POST /api/session/:id/prompt` while attached, final screen shows `Kiro` / **`0.16 credits`** (= new durable Σ 0.1629, 2 credit parts, no double-count). Host built-ins keep painting (`17,323 tokens`, `$0.00 spent`, `LSP`). 0 occurrences of `No renderer found` / `crashed` / orphan text in the raw capture. Solid dedupe: compiled-in — the worktree graph the bundle was built from links `packages/tui`, `packages/cli`, `@opentui/solid@0.4.5`, and `opencode-kiro` ALL to the single workspace-patched `solid-js@1.9.10` store entry (`catalog:` override; the `solid-js@1.9.12` store folder exists but is linked from no package in the TUI graph); loader-shim/path issues (B4) are irrelevant since nothing is loaded from disk at runtime. |
| B-7 | Disable directives: `"-kiro"` (server) and `"-opencode-kiro"` (TUI cli.json) each deactivate their half; removed after | PASS | **TUI half**: hermetic `cli.json` `{"plugins":["-opencode-kiro"]}` → TUI boots on the same credits session, host built-ins paint (`17,323 tokens`/`$0.00 spent`/`LSP`) but the raw capture contains **zero** `credits` occurrences (Kiro box gone), no crash. **Server half**: hermetic `opencode.json` `{"plugins":["-kiro"]}` → `GET /api/plugin` = **68** (kiro absent, dynamic present); with a FRESH data dir: **0** kiro models, kiro integration reduced to catalog-generic `[key, env]` methods — the plugin-owned "Kiro CLI Login" method gone, no connections (note: on the reused data dir, previously-persisted models/credential remain visible — persistence residue, not plugin activity). **Removed after**: both config files deleted (config dir back to host-written `service-*.json` only) → restart = **69** plugins, `kiro` restored. |
| B-8 | Teardown: no processes from this run; worktree intact (kept for task 21); main clone untouched | PASS | All e2e servers (ports 43101/43103-43109), TUIs, `script(1)` pairs, shim tee, and one background `serve --service` auto-spawned by `opencode2 plugin list` were terminated — post-run `ps`: zero processes owned by this run. Left untouched as instructed: pre-existing orphans (PIDs 27143/27548 from prior sessions, 87546 = user's global service) and an unrelated user opencode session (PID 28916 + its 2 owned ACP pairs, started independently at 16:39). Worktree `opencode-v2-kiro` INTACT @ `4fbca30fd9`, zero tracked modifications (binary artifact untracked, as designed) — kept for task 21. Main clone `/…/opencode`: branch `feat/kiro-provider`, `git status --porcelain` **empty**. models.dev repo: only pre-existing untracked `.artifacts/`. All e2e state lived in temp dirs. |

### VERDICT (bundled)

**BUNDLED INTEGRATION VERIFIED.** All 9 rows PASS. Kiro works as a BUILT-IN of
the single-file bundled binary with zero `plugins` config: server plugin in the
core `pre` array, TUI plugin compiled into the TUI builtins, auth via Kiro CLI
Login, and — the core check — models flow through the **ENRICHMENT** path
(`OPENCODE_MODELS_PATH` artifact): registered lineup = catalog 18 ∩ runtime 19
= **18** models with models.dev names + context windows, vs the fallback's 19
raw-named ctx=0 models in the A/B control. Effort reaches kiro-cli on the wire
(`effort=high` for both ACP clients), sidebar credits live-update (0.06 → 0.16)
on host-instance solid (single patched `solid-js@1.9.10`, compiled in — B4's
loader-shim path issue is structurally irrelevant to the bundled binary), and
both disable directives cleanly deactivate their half.

### Upstream deviations noticed (bundled run)

- `opencode2 plugin list` (no `--server` flag support) auto-spawns a background
  `serve --service` from the invoked binary — surprising side effect for a
  read-only listing command; the service must be torn down separately.
- Plugin registry population is lazy: `GET /api/plugin` returns `[]`/0 for the
  first ~10-20 s after boot before settling at the full set (69 with kiro).
- With `"-kiro"` on a data dir that previously ran the plugin, self-registered
  models and the stored credential remain visible (durable persistence residue);
  a fresh data dir shows the true disabled state (0 models, no login method).
- The repo-level `.opencode/opencode.jsonc` of whatever cwd the binary starts in
  is merged into config (project config discovery) — hermetic runs must use a
  hermetic cwd, not just hermetic XDG dirs.

### Published-package smoke (0.5.0-beta.1 @ registry)

**Task**: opencode-v2-migration-21 — abbreviated smoke of the bundled binary
rebuilt from the PUBLISHED registry package (was `file:` in the full run above).
**Date**: 2026-07-29
**Publish facts (USER-executed)**: `opencode-kiro@0.5.0-beta.1` live on npm;
`dist.shasum d00dab9eab35425fbe3d06c3e4cd2667842a343e` = local `npm pack` match;
dist-tags `beta` → `0.5.0-beta.1`, `latest` → `0.4.0` (untouched), `next` →
`0.3.6-rc.1`. Actual channel is **`beta`**, not the planned `next-v2`.
**Wiring switch**: worktree `opencode-v2-kiro` @ `feat/kiro-provider-v2`, commit
`b5177147cc` — both `packages/core/package.json` and `packages/tui/package.json`
deps `file:…/opencode-kiro` → exact `"opencode-kiro": "0.5.0-beta.1"`. `bun
install` clean in 1.35 s (no age-gate error — bunfig `minimumReleaseAgeExcludes`
covers the fresh publish); lockfile now resolves the registry entry
(`opencode-kiro@0.5.0-beta.1`, sha512 `zQYCKhW9…pvCQ==`). Dedupe re-verified in
the installed store: `…/.bun/opencode-kiro@0.5.0-beta.1+ea65f8f16f79ddfa/node_modules/`
links `solid-js → solid-js@1.9.10` (workspace-patched — `#2046` hunk present in
`dist/solid.js` and `dist/dev.js`) and `@opentui/solid → 0.4.5` shared entry;
both `packages/core` and `packages/tui` symlink the same registry store entry.
**Rebuild**: `bun run script/build.ts --single --skip-install` exit 0 in
**2.39 s**; `dist/cli-darwin-arm64/bin/opencode2` = **149,671,778 B (143 MB)**.
**Method**: hermetic XDG + hermetic cwd (per the deviations note above), real
`HOME` kept for kiro-cli auth (2.15.1, logged in), `OPENCODE_MODELS_PATH=
/Users/user/Documents/1-coding/open-source/models.dev/.artifacts/api.json`;
`serve --port 43121` (Basic auth per printed password); TUI via `script(1)` pty
220x60 + pyte replay, `OPENCODE_PASSWORD` env for attach.

| # | Item | Result | Evidence |
|---|------|--------|----------|
| P-1 | Binary boots; kiro server plugin BUILT-IN | PASS | `GET /api/plugin` → **69 plugins incl. `kiro` at index 60**; hermetic `XDG_CONFIG_HOME` contains zero config files (empty `opencode/` dir only) — compiled-in registration is the only possible source. |
| P-2 | Models: enrichment path, 18 enriched | PASS | `GET /api/model` → **18** kiro models, all with models.dev display names + context windows (e.g. `claude-sonnet-5` = "Claude Sonnet 5", ctx 1,000,000, variants low/medium/high/xhigh/max → `settings.effort`); `claude-opus-5` correctly dropped (catalog 18 ∩ runtime 19 = 18). |
| P-3 | Auth: Kiro CLI Login | PASS | `POST /api/integration/kiro/connect/oauth {methodID:"kiro-cli-login",inputs:{sidebar:"no"}}` → "Already authenticated with Kiro CLI."; `GET /api/integration/kiro` → 1 credential connection. |
| P-4 | Text-only prompt round-trips; durable credits | PASS | Session `ses_0518bdfecffePBTWorBjnvscsm` on `kiro/claude-haiku-4.5`: prompt → assistant reply `pong`, durable `state:{credits:0.0130…,creditsUnit:"credit"}`. |
| P-5 | TUI sidebar box renders + live credits update | PASS | pty capture at mount: sidebar shows `Kiro` / **`0.01 credits`** (= durable 0.0130) alongside host built-ins (`% used` / `$0.00 spent` / `LSP`). Second live prompt fired while attached (`ping`) → sidebar updates to **`0.03 credits`** = new durable Σ 0.02804 (2 credit parts, no double-count). 0 occurrences of `crashed` / `No renderer found` in the raw capture. |
| P-6 | Teardown | PASS | Smoke server + TUI terminated; 0 `kiro-cli acp` leftovers from this run; pre-existing user global service (PID 87546) untouched. Worktree tracked-clean at `b5177147cc` (binary artifact untracked, as designed). |

**VERDICT: PUBLISHED-PACKAGE BUILD VERIFIED** — identical behavior to the
`file:` iteration (B-0…B-7); B4's `name@file:` loader-shim caveat is moot on the
registry channel (nothing is loaded from disk in the bundled binary anyway); no
behavioral difference from the task-20 run was observed.

## Beta.2 e2e at 1cf61593b5

**Task**: opencode-v2-migration-28 — host e2e of the beta.2 candidate at the Phase 8 pin
**Plugin SHA under test**: `d3458cc` (branch `opencode-v2`, clean; 94/94 targeted green)
**Host SHA**: `1cf61593b5ec204619b3f679fe418fec10ca5934` (`upstream/v2` head 2026-08-23; Phase 8 pin)
**Pinned plugin API**: `@opencode-ai/plugin@0.0.0-dev-17968`
**Date**: 2026-08-23
**Method**: detached read-only `git worktree` of the local OpenCode clone at the pinned SHA; hermetic XDG + hermetic cwd; fresh `npm pack` tarball installed via the host package channel (`name@file:` spec per B1); `script(1)` pty 220x60 + pyte replay; per-command timeouts; fresh ports; explicit `--server`/standalone; pre-existing orphan servers ignored/untouched. **Headline**: `tui: true` auto-load — a SINGLE server `plugins` entry, NO cli.json TUI entry anywhere.

### Checklist results (beta.2)

| # | Item | Result | Evidence |
|---|------|--------|----------|
| C-1 | Worktree at exact SHA; host builds/boots (Bun version needs noted) | PASS | `git worktree add --detach $TMP/beta2-e2e/opencode-e2e 1cf61593b5…` → `rev-parse HEAD` = `1cf61593b5ec204619b3f679fe418fec10ca5934`; clone stayed on `feat/kiro-provider` @ `3a68247163`, porcelain EMPTY. `bun install` (4905 packages, 301 s); `bun run dev --help` → "OpenCode 2.0 preview command line interface". **Bun version note**: the repo pins `packageManager: bun@1.3.14` at this SHA (NOT 1.4.0 as the dispatch guessed); local bun 1.3.14 matches exactly. `bun install` normalized `bun.lock` in the WORKTREE only (15 deletions; worktree deleted at teardown, clone untouched). |
| C-2 | Fresh `npm pack` (0.5.0-beta.2); hermetic install; server entry resolves + loads | PASS | Fresh `npm run build` + `npm pack` at `d3458cc` → `opencode-kiro-0.5.0-beta.2.tgz` (10 files, 12.9 kB, shasum `96eddb597356773620f57ac8655ebadd6de458be`; chip chunk `credits-chip-view-*.js` back in the tarball as designed). Hermetic XDG root (config/data/cache/state in temp, cache empty at start), real HOME kept for kiro-cli; **hermetic project config via `OPENCODE_CONFIG_PROJECT_DISABLE=1`** (new env at this SHA — cleaner than a hermetic cwd; the worktree's own `.opencode/opencode.jsonc` would otherwise merge in). Global config = ONE entry: `opencode.json {"plugins":[{"package":"opencode-kiro@file:<abs tgz>","options":{}}]}` (B1 `name@file:` form still required). `serve --port 44201` (Basic auth per printed password, `{location,data}` envelope): `GET /api/plugin` → **81 plugins incl. `kiro`, `status:"active"`, `"tui": true`** — the server entry resolved from the isolated arborist tree and its `tui` flag is on the wire. **Install-dirname change at this SHA**: the spec's slashes now create NESTED dirs — `…/packages/opencode-kiro@file:` + `/var/…/opencode-kiro-0.5.0-beta.2.tgz/node_modules/opencode-kiro` — the `:` is still present in the first segment (B4 applicability answered in C-3). |
| C-3 | **HEADLINE — `tui: true` auto-load**: TUI surfaces appear with ONLY the server config entry (no cli.json TUI entry); B4 colon-path applicability recorded | PASS (registry-layout install) / **B4 APPLIES to the auto-load path for `file:` installs — now contained per-slot, not a host crash** | Hermetic config tree verified to contain EXACTLY ONE file (`opencode.json` with the single server `plugins` entry; `cli.json` absent everywhere). Auto-discovery mechanism confirmed in host source: the TUI syncs `client.api.plugin.list` and activates every `status:"active" && plugin.tui && source.type:"package"` entry, resolving the package's `./tui` subpath itself (`packages/tui/src/plugin/context.tsx:490,653`). **Run A (`name@file:<tgz>` spec, colon install dir)**: TUI booted, transcript + built-ins painted, our slot callback WAS invoked — but rendered `opencode-kiro crashed in slot sidebar.content: No renderer found` in a plugin-error panel. **B4 still applies to the new auto-load path for `file:` installs** (install dirname still starts `opencode-kiro@file:` — `npm.ts` `sanitize()` still win32-only; NEW at this SHA the spec's slashes create NESTED dirs under that colon segment). **NEW upstream improvement: the crash is contained per-slot** — the host TUI keeps working (transcript, built-ins, composer all fine; the error renders as a dismissible "Plugin … x" notice), vs. the whole-TUI crash at `b47cfbee7c`. **Run B (registry layout)**: identical installed tree seeded at the colon-free dirname `packages/opencode-kiro@0.5.0-beta.2` + config `{"package":"opencode-kiro@0.5.0-beta.2"}` (host's `Npm.add` short-circuits on an existing `node_modules/<name>` — no registry fetch; beta.2 is unpublished, proving resolution came from the seeded layout): **TUI auto-loads our `./tui` entrypoint with ZERO TUI config — sidebar box (`Kiro` + total) AND composer-top chip both render**; pyte replay shows the chip on the line directly above the composer and the box in the sidebar; 0 occurrences of `crashed`/`No renderer found`. `plugin.list` wire evidence: `{"id":"kiro","source":{"type":"package","package":"opencode-kiro@0.5.0-beta.2"},"status":"active","tui":true}`. Install docs implication confirmed: registry-channel users need ONE `opencode.json` entry, nothing else. |
| C-4 | Auth: forms-flow "Kiro CLI Login" (no prompt select); credential stored; state sanity | PASS | `GET /api/integration` (169) → `kiro` method `{id:"kiro-cli-login", type:"oauth", label:"Kiro CLI Login"}` with **NO `prompts` and no `form` field** (forms flow; the sidebar consent select is gone, as designed). State sanity observed: (1) **pending** — kiro-cli 2.19.1 initially reported "Not logged in" (stale token since the July runs): `POST …/connect/oauth {methodID:"kiro-cli-login",inputs:{}}` → `mode:"auto"`, "Waiting for login...", live `kiro-cli login` child (pid 40433, ppid = server) + status poll `pending`; (2) **cancel/cleanup** — `DELETE …/oauth/<attemptID>` → 204, login child GONE within 4 s; (3) **complete** — after an out-of-band pty `kiro-cli whoami` refreshed the CLI token (IAM Identity Center), fresh connect → 200 in 0.95 s, "Already authenticated with Kiro CLI.", poll → `complete`, `GET /api/integration/kiro` → `connections:[{type:"credential",id:"cred_02e77377c001pQHj3Tg3Z1g53Y",label:"default"}]`. |
| C-5 | Models via OPENCODE_MODELS_PATH (env overrides embedded snapshot); enrichment intersection + context windows | PASS | `OPENCODE_MODELS_PATH=<models.dev>/.artifacts/api.json` (July artifact REUSED — **not rejected** by this SHA; no rebuild needed; `server-process.ts` still wires it as `models.file`, hardened resolution honors it). `GET /api/model` → **18** kiro models, all with models.dev display names ("Claude Sonnet 5", "GPT-5.6 Sol", "Deepseek v3.2"…) + artifact context windows (1M/272k/256k/200k/196k/164k) — ENRICHMENT path, not fallback (fallback would show raw `name===id`, ctx 0). Intersection: catalog 18 ∩ runtime 19 = **18**, `claude-opus-5` correctly dropped. Effort models carry variants → `settings.effort` (`claude-sonnet-5`: low/medium/high/xhigh/max; GPT-5.6 family additionally `none`). |
| C-6 | Effort variant on the wire (ACP stdin shim) | PASS | PATH-shim `kiro-cli` teeing ACP stdin (per-instance tee files), server relaunched with shimmed PATH. Session created `{"providerID":"kiro","id":"claude-sonnet-5","variant":"high"}`; text-only prompt. Wire capture (main client): `{"command":{"command":"effort","args":{"value":"high"}}}` via `commands/execute` — `settings.effort` → aisdk hook → `createKiroAcp(options).config.effort` reaches kiro-cli at this SHA. Turn completed `finish:"stop"`, assistant recorded `variant:"high"` + durable `state:{credits:0.07248,creditsUnit:"credit"}`. Observations: the ephemeral client captured `effort:"none"` (new value seen at this pin; informational), and THREE owned ACP instances appeared for this session (3 tee files: warmup/discovery + ephemeral + main) vs 2 in prior runs — all children of the server, all torn down with it. |
| C-7 | Credits: chip (composer.top) + box live; DURABLE via upstream fix (fresh mount w/o transient); live overlay still needed; no double-count; theme tokens | PASS | **Durable (upstream fix verified)**: server-side text-only turns persist key-unwrapped `content[].state = {credits, creditsUnit}` (first turn: `{"text":"pong","state":{"credits":0.01546…,"creditsUnit":"credit"}}`); THREE fresh TUI mounts (new processes — transient store necessarily empty) each painted exactly the durable sum current at mount: `0.02` (Σ 0.01546, 1 part) → `0.03` (Σ 0.03080, 2 parts) → `0.05` (Σ 0.04873, 3 parts) — **credits present WITHOUT our transient store**; never doubled. **Live (overlay still required)**: with the TUI attached, a prompt turn updated BOTH surfaces in place to `0.07 credits` = exact new durable Σ 0.06906 (4 parts; raw-grep misses the repaint — pyte replay shows it; transcript live-painted `live-check` too). The upstream live reducer STILL drops state at this SHA — `packages/client/src/solid/data.ts` `session.text.ended` branch copies only `text` (`if (match) match.text = event.data.text`), so the transient overlay remains the only live carrier; durable-wins reconcile keeps totals exact. **Both surfaces**: chip = single line directly above the composer (`session.composer.top` claim), box = `Kiro` header + total in the sidebar (`sidebar.content` claim), composing with host content (append claims, no takeover). **Theme tokens applied**: chip/box total renders fg `128;128;128` = the host theme's subdued token (identical to built-in subdued text like "12,096 tokens"); box header "Kiro" renders fg `238;238;238` = host default text token (identical to built-in headers "Context"/"pong") — `context.theme` feature-detection is live end-to-end. **10ms batching sanity**: client event delivery is batched at 10 ms at source (`packages/client/src/solid/connection.ts:60` — `setTimeout(flush, options.flushInterval ?? 10)` wrapping `batch(() => events.forEach(onEvent))`; server-side delta batching is a separate `deltaBatchInterval = 100` in `publish-llm-event.ts`); behaviorally the overlay incremented exactly once per turn across 4 turns with every painted total = the exact durable Σ — no dropped or duplicated increments. |
| C-8 | Disable directive `-kiro` (server) — does tui:true auto-load die with it? | PASS — **one directive kills BOTH halves** | Config `{"plugins":[{"package":"opencode-kiro@0.5.0-beta.2","options":{}},"-kiro"]}` + FRESH data dir (residue gotcha): `GET /api/plugin` → **80** plugins (was 81), `kiro` ABSENT; **0** kiro models; kiro integration reduced to catalog-generic `[key, env]` methods (plugin-owned "Kiro CLI Login" gone). **TUI half dies with it, by construction and by observation**: the TUI auto-loads only `status:"active" && tui && source:"package"` entries from plugin.list (`context.tsx:490`), so the disabled server plugin removes the TUI half too — TUI boot on the same host: **0** occurrences of `kiro`/`credits` in the capture, no crash, host renders normally. Under `tui: true` there is no separate TUI disable id to document — `-kiro` is the single kill-switch (obsoletes the O2 id-asymmetry doc concern for the auto-load channel). Config restored after. |
| C-9 | Teardown: no run-owned processes; worktree removed; clone byte-identical | PASS | All 4 servers (ports 44201-44204), all TUI/`script(1)` pairs, shim tees, and ACP children terminated — post-run `ps`: ZERO run-owned processes (pre-existing user service PID 87546 + unrelated user sessions untouched). `git worktree remove --force` + `prune` → e2e worktree gone; remaining worktrees = main clone + `opencode-bundled` + `opencode-stock` + `opencode-v2-kiro`, all untouched. **Note**: `git worktree prune` also dropped the long-dead `T/opencode/oc-v2` registration — its directory no longer existed (git already listed it "prunable" BEFORE this run); stale-metadata cleanup only, no working tree touched. Clone: `feat/kiro-provider` @ `3a68247163f730a0ffc62135b40e8bdfd7c266c5`, `git status --porcelain` EMPTY before AND after (byte-identical). models.dev repo: only the pre-existing untracked `.artifacts/` (artifact reused, no rebuild). All e2e state (worktree, hermetic XDG, tarball, captures, shim) lived in temp paths. |
| C-10 | **AMENDMENT (pre-publish)** — chip moved `session.composer.top` → `prompt.footer.status` (v1 placement restored); placement spot-check | PASS | Fresh `npm run build` + `npm pack` after the amendment → `opencode-kiro-0.5.0-beta.2.tgz` NEW shasum `e1a27496cd644c60e688c1f0051b3a7052af2fad` (supersedes `96eddb59…`; dist grep: 1× `prompt.footer.status`, 0× `session.composer.top`). Fresh detached worktree at `1cf61593b5` (rev-parse exact; clone porcelain EMPTY before/after, worktree removed at teardown), `bun install`, hermetic XDG + `OPENCODE_CONFIG_PROJECT_DISABLE=1`, `name@file:` install then colon-free registry-layout seed (`packages/opencode-kiro@0.5.0-beta.2`, config `{"plugins":["opencode-kiro@0.5.0-beta.2"]}` — B4 avoided) → `plugin.list`: `{"id":"kiro","source":{"package":"opencode-kiro@0.5.0-beta.2"},"status":"active","tui":true}`. Auth via `POST /api/integration/kiro/connect/oauth {methodID:"kiro-cli-login"}` → credential + 19 kiro models (self-registration fallback; no OPENCODE_MODELS_PATH — irrelevant to placement). pty 220x60 + pyte replay, session with one durable turn (`state:{credits:0.01546,creditsUnit:"credit"}`): **chip renders IN THE PROMPT FOOTER ROW** — `0.02 credits` on the footer line directly beside the host cost/context display (`… 0.02 credits  12.1K (6%)  ctrl+p commands …`), NOT above the composer; sidebar box unaffected (`Kiro` / `0.02 credits`). **Live**: prompt fired while attached → BOTH surfaces updated in place to `0.03 credits` (= new durable Σ 0.03080), footer showed `0.03 credits  14.0K (7%)`, transcript live-painted; 0 occurrences of `crashed`/`No renderer found`. Mode note: chip claims `prompt.footer.status` (props `{sessionID?, mode}`), renders in both normal and shell modes, withheld when sessionID absent. |

### VERDICT (beta.2)

**BETA.2 E2E VERIFIED.** All 9 rows PASS. The headline holds: with a SINGLE
server `plugins` entry and NO cli.json TUI entry anywhere, `tui: true` makes the
host TUI auto-load the package's `./tui` entrypoint — sidebar `Kiro` credits box
AND the revived composer-top chip both render, live-update on attached turns
(exact durable sums, never double-counted), and paint with host theme tokens.
The durable credits path is now genuinely upstream-fixed (three fresh mounts
painted correct totals with no transient store), while the live path still
requires our overlay (reducer still drops `state` at this SHA). Auth is the
forms flow (no prompts), models flow through the OPENCODE_MODELS_PATH enrichment
path with the existing July artifact (not rejected), effort reaches kiro-cli on
the wire as `effort=high`, and one `-kiro` directive now disables BOTH halves.
**Install-channel caveat for local validation only**: B4 (colon in the
`name@file:` install dirname defeating the OpenTUI loader shim) still applies to
the auto-load path — but the blast radius shrank from whole-TUI crash to a
contained per-slot error notice. Registry installs are colon-free and fully
green (proven via registry-layout seeding).

> **Pre-publish amendment (C-10)**: after this verdict the chip placement moved
> from `session.composer.top` to `prompt.footer.status` (v1 footer-row placement
> restored) and was re-verified in the host — see row C-10; the repacked tarball
> shasum is `e1a27496cd644c60e688c1f0051b3a7052af2fad`.

### Upstream deviations noticed at `1cf61593b5` (vs `b47cfbee7c`)

- **Per-slot plugin crash containment (NEW, improvement)**: a plugin render
  throw now shows `opencode-kiro crashed in slot <path>: <error>` in a
  dismissible panel; the host TUI keeps working (at `b47cfbee7c` the same B4
  failure killed the whole TUI).
- **`OPENCODE_CONFIG_PROJECT_DISABLE=1` (NEW)**: disables project-config
  discovery/merging — the clean answer to the Phase 6 "hermetic cwd" gotcha
  (`server-process.ts` `config.project`).
- **`file:`-spec install dirs are now NESTED**: the raw spec's slashes create a
  real directory tree under `packages/opencode-kiro@file:/…` (previously one flat
  dirname); the colon survives, so B4 stands for this channel; `Npm.add`
  short-circuits when `dir/node_modules/<name>` already exists (no re-reify).
- **Assistant messages carry `providerState`**: message-level
  `{contextUsagePercentage, turnDurationMs, credits, creditsUnit}` alongside the
  per-part `content[].state` (we keep reading part state; message-level mirror is
  informational).
- **Ephemeral ACP client receives `effort:"none"`** and a session produced THREE
  owned ACP instances (warmup/discovery + ephemeral + main) vs 2 under O5.
- **Server plugin registry population is still lazy** (~30-60 s cold with the
  arborist install; `/api/plugin` returns 0 entries until settled) — O3/lazy
  behavior unchanged.
- Prompt/session API shape unchanged from `b47cfbee7c` (`POST /api/session`
  takes `model` incl. `variant`; `POST /api/session/:id/prompt {text}`); Basic
  auth + `{location,data}` envelope unchanged.

## Beta.3 e2e at 8ba434b597

**Task**: opencode-v2-migration-34 — host e2e of the beta.3 candidate at the Phase 9 pin; **headline: THE FIX VALIDATION** (dual-listen credential events, task 31)
**Plugin SHA under test**: `b5d7d13` (branch `opencode-v2`, clean; 102/102 targeted green)
**Host SHA**: `8ba434b5973856b2f32b8cd3543e154b25c413e6` (`upstream/v2` head 2026-08-29; Phase 9 pin)
**Pinned plugin API**: `@opencode-ai/plugin@0.0.0-dev-18686`
**Date**: 2026-08-30
**Method**: detached read-only `git worktree` of the reference clone at the pinned SHA (SHA object already local — no fetch needed); hermetic XDG (config/data/cache/state) + `OPENCODE_CONFIG_PROJECT_DISABLE=1`; real HOME kept for kiro-cli (2.20.1); fresh `npm pack` tarball; **colon-free registry-layout seed** (B4 avoidance): tarball npm-installed into `$XDG_CACHE_HOME/opencode/packages/opencode-kiro@0.5.0-beta.3/` (with a seed-root `package.json` so npm anchors there — it otherwise walks UP to a parent package root), config = ONE entry `{"plugins":["opencode-kiro@0.5.0-beta.3"]}`; `OPENCODE_MODELS_PATH=<models.dev>/.artifacts/api.json` (July artifact reused); `serve --port 44301` (Basic auth); SSE `/api/event` captured for the whole fix sequence; `script(1)` pty 220x60 + pyte replay for TUI rows; per-command timeouts; pre-existing orphans ignored/untouched.

### Checklist results (beta.3)

| # | Item | Result | Evidence |
|---|------|--------|----------|
| F-1 | Worktree at exact SHA; host builds/boots (bun version noted) | PASS | `git worktree add --detach <tmp> 8ba434b597…` → `rev-parse HEAD` = `8ba434b5973856b2f32b8cd3543e154b25c413e6`; clone stayed on `feat/kiro-provider` @ `3a68247163`, porcelain EMPTY (0 bytes) before the run. **Repo pins `packageManager: bun@1.3.14`** — local bun 1.3.14 matches exactly. `bun install` 4829 packages in 17.6 s (warm cache); `bun run dev --help` → "OpenCode 2.0 preview command line interface". |
| F-2 | Fresh pack (0.5.0-beta.3); hermetic single-config install (`tui: true` auto-load) | PASS | Fresh `npm run build` + `npm pack` at `b5d7d13` → `opencode-kiro-0.5.0-beta.3.tgz` (10 files, 13.7 kB, shasum `9e3020c23242d2e53b70547bb9a781122cbb171b`). Registry-layout seed (colon-free — `sanitize()` in `packages/util/src/npm.ts:38` is STILL win32-only, so B4 stands for `file:` installs; install base = `$XDG_CACHE_HOME/opencode/packages/<spec>`, short-circuit on existing `node_modules/<name>` confirmed at `npm.ts:180`). Hermetic config tree = exactly ONE file (`opencode.json`, single server `plugins` entry; NO cli.json anywhere). `GET /api/plugin` → **80 plugins incl. `{"id":"kiro","source":{"type":"package","package":"opencode-kiro@0.5.0-beta.3"},"status":"active","tui":true}`** ~10 s after boot. beta.3 is UNPUBLISHED — resolution can only have come from the seeded layout. |
| F-3 | **THE FIX — mid-session connect: models appear WITHOUT restart** | **PASS** | Server (PID 71290) started LOGGED OUT: `GET /api/model` → 116 total, **0 kiro**; `GET /api/integration/kiro` → `connections: []` (method `kiro-cli-login` present). SSE `/api/event` capture opened. Mid-session `POST …/connect/oauth {methodID:"kiro-cli-login"}` → `complete` ("Already authenticated with Kiro CLI."), credential `cred_0529f9e6d0012YH412GKjV3Mlx` stored. **Same server process, NO restart: `GET /api/model` → 134 total, 18 kiro models** (display names + variants present). **Events that drove the re-check (SSE capture)**: `{"type":"credential.updated","data":{}}` (evt_0529f9e72001…) + `{"type":"credential.switched","data":{"integrationID":"kiro","credentialID":"cred_0529f9e6d001…"}}` (evt_0529f9e78001…), 6 ms apart; **0 occurrences of `integration.connection.updated` in the whole capture** — the dual-listen migration is doing ALL the work on this host. (Auth preamble: kiro-cli's own token had expired; the first connect attempt correctly went `mode:"auto"` pending, spawned `kiro-cli login`, and FAILED after the ~120 s poll — an out-of-band pty `kiro-cli login --license pro --identity-provider … --region eu-west-1` + USER browser completion restored CLI auth; the server was NOT restarted at any point.) |
| F-4 | **THE FIX — logout: models clear WITHOUT restart** | **PASS** | `DELETE /api/credential/cred_0529f9e6d001…` → 204. Same server, ~4 s later: `connections: []`, `GET /api/model` → 116 total, **0 kiro** (exactly −18). SSE: removal published `{"type":"credential.updated","data":{}}` + `{"type":"credential.switched","data":{"integrationID":"kiro","credentialID":null}}` (active-credential removal publishes both, per `credential.ts:222-228`). |
| F-5 | Multi-account sanity (`credential.switched` with a REAL switch) | PASS | Two consecutive connects → TWO credentials (`Kiro`, `Kiro 2` — host auto-labels). `POST /api/credential/<older>/activate` → 204; SSE fired `credential.switched {"integrationID":"kiro","credentialID":"cred_052a0dfb3001…"}` (a genuine switch to a non-newest credential); kiro models stayed **18** throughout. Extra credential removed after; 1 connection left for the remaining rows. |
| F-6 | 18 enriched models via OPENCODE_MODELS_PATH (enrichment, not fallback) | PASS | July artifact REUSED (not rejected at this SHA). 18 kiro models with models.dev display names ("Claude Sonnet 5", "GPT-5.6 Sol"…) + artifact context windows (`claude-sonnet-5` ctx 1,000,000 / `gpt-5.6-sol` 272,000 — fallback would show `name===id`, ctx 0). Effort models carry variants → `settings.effort` (`claude-sonnet-5`: low/medium/high/xhigh/max). `settings.contextWindows` passthrough (18 entries) + `{cwd, agent:"opencode", trustAllTools:true, mcpTimeout:45}` on the wire settings. Intersection note: runtime model set at kiro-cli 2.20.1 changed (new `glm-5`, `minimax-m2.5`, `qwen3-coder-next`, `deepseek-3.2`…); catalog ∩ runtime still = **18**. |
| F-7 | Effort on the wire (ACP stdin capture) | PASS | PATH-shim `kiro-cli` teeing ACP stdin (per-instance tee files); server relaunched with shimmed PATH (port 44302; stored credential persisted in the hermetic data dir → 18 models in 5 s). Session `{"providerID":"kiro","id":"claude-sonnet-5","variant":"high"}` + text prompt → wire capture (main client): `{"command":"effort","args":{"value":"high"}}` via `_kiro.dev/commands/execute`; ephemeral client captured `effort:"none"` (same informational behavior as beta.2). THREE owned ACP instances (warmup/discovery + ephemeral + main; 3 non-empty tee files), all children of the server. Turn `finish:"stop"`, assistant recorded `variant:"high"` + durable `content[].state = {credits:0.08865,creditsUnit:"credit"}` + message-level `providerState` mirror `{contextUsagePercentage, turnDurationMs, credits, creditsUnit}`. |
| F-8 | Credits chip (footer row) + box live on a text turn; durable across restart; no double-count | PASS | pty via `script(1)` + `stty cols 220 rows 60` + pyte replay. **Durable (fresh mounts, transient store necessarily empty)**: TUI mount painted footer chip `0.09 credits` (= durable 0.08865) on the prompt footer row beside the host path/context display, AND sidebar box `Kiro` / `0.09 credits` alongside built-ins (`2% used`). **Live**: prompt fired while attached → BOTH surfaces updated in place to **`0.18 credits`** = exact new durable Σ 0.18259 (2 credit parts — never doubled); transcript live-painted. **Durable across restart**: third fresh TUI mount painted exactly `0.18` on both surfaces. 0 occurrences of `crashed`/`No renderer found` across all three raw captures. (80-col note: at narrow width the sidebar is hidden by the host layout; the footer chip still renders — captured at both widths.) |
| F-9 | `-kiro` disable kills both halves | PASS | Config `{"plugins":["opencode-kiro@0.5.0-beta.3","-kiro"]}` + **FRESH data dir** (residue gotcha honored): `GET /api/plugin` → **79** plugins (was 80), `kiro` ABSENT; **0** kiro models; kiro integration reduced to catalog-generic `[key, env]` methods (plugin-owned "Kiro CLI Login" gone). TUI boot on the same host: **0** occurrences of `kiro`/`credits` in the raw capture, 0 `crashed`, host renders normally — one directive still kills BOTH halves (auto-load only picks `status:"active"` package entries from plugin.list). Config/data restored (hermetic temp). |
| F-10 | Teardown: no run-owned processes; worktree removed; clone byte-identical | PASS | All 3 servers (ports 44301-44303), all TUI/`script(1)` pairs, the pty login wrapper, shim tees, and ACP children terminated — post-run `ps`: ZERO run-owned processes. `git worktree remove --force` + `prune` → e2e worktree gone; remaining worktrees = main clone + `opencode-bundled` + `opencode-stock` + `opencode-v2-kiro`, all untouched. Clone: `feat/kiro-provider` @ `3a68247163`, `git status --porcelain` EMPTY before AND after (byte-identical); no fetch performed (pin SHA already local). models.dev repo untouched (artifact read-only). All e2e state (worktree, hermetic XDG, tarball, captures, shim) lived under the pre-approved temp root. Note: kiro-acp wrote `.kiro/agents/opencode-*.json` under the session cwd DURING turns — that cwd was inside the temp worktree (removed); the reference clone is unaffected. |

### VERDICT (beta.3)

**BETA.3 E2E VERIFIED — THE FIX VALIDATED END-TO-END.** All 10 rows PASS. The
headline holds live: a host started LOGGED OUT shows 0 kiro models; a
mid-session Kiro CLI Login makes **18 models appear on the same server process
with NO restart**, and the SSE capture proves the reactivity came from
**`credential.updated` (empty payload) + `credential.switched`
(`{integrationID:"kiro", credentialID:…}`)** — with **ZERO occurrences of
`integration.connection.updated`** anywhere in the run, confirming both the
Phase 9 defect premise (old event name is dead on new hosts) and the dual-listen
fix (task 31) as the sole reactivity driver. Logout (`DELETE
/api/credential/:id`) cleared the 18 models without restart (removal publishes
`credential.updated` + `credential.switched {credentialID:null}` when the active
credential goes). Multi-account got a real sanity pass: two stored credentials
(host auto-labels "Kiro" / "Kiro 2"), activating the older one fired a genuine
`credential.switched` and models stayed 18. All standard rows held: `tui: true`
single-config auto-load, OPENCODE_MODELS_PATH enrichment (July artifact still
accepted; 18 enriched models), effort `high` on the ACP wire, footer chip + 
sidebar box live AND durable across three fresh mounts with exact never-doubled
sums, `-kiro` killing both halves, clean teardown with a byte-identical clone.

### Upstream deviations noticed at `8ba434b597` (vs `1cf61593b5`)

- **Credential events REPLACE `integration.connection.updated` (THE Phase 9
  premise, now proven live)**: `Credential.create` publishes BOTH
  `credential.updated {}` and `credential.switched {integrationID,
  credentialID}` (6 ms apart in our capture); `remove` publishes
  `credential.updated` (+ `credential.switched {credentialID:null}` when the
  active credential is removed — `packages/core/src/credential.ts:222-228`);
  `activate` publishes only `credential.switched`. The old event name appeared
  0 times in the full SSE capture.
- **Multi-account credential UX**: repeated connects create ADDITIONAL
  credentials (auto-labeled "Kiro", "Kiro 2" — beta.2 stored label was
  "default"); `POST /api/credential/:id/activate` switches;
  `DELETE /api/credential/:id` is the logout path (there is no
  integration-level disconnect route anymore).
- **Failed-login attempt semantics**: with kiro-cli's own token expired, the
  connect attempt went `pending` (spawned `kiro-cli login`, no tty) and cleanly
  transitioned to `failed` after the ~120 s poll window — no crash, no stuck
  attempt; a later connect on the same server succeeded normally.
- **Plugins-before-generation (`1e7c60adce`) — observed good**: prompts issued
  seconds after boot round-tripped cleanly (`finish:"stop"` first try, all
  servers); no first-turn raciness anywhere in the run. Plugin registry
  populated in ~5-10 s warm (vs the 30-60 s cold-lazy note from beta.2).
- **Plugin count 80** at this SHA (beta.2: 81) — host built-in set churn only.
- **B4 status re-checked in source (not behaviorally this run)**: `sanitize()`
  in `packages/util/src/npm.ts:38` is still win32-only, so `name@file:` install
  dirnames still carry `:` on darwin; this run used the colon-free
  registry-layout seed exclusively (install base `$XDG_CACHE_HOME/opencode/
  packages/<spec>`; short-circuit on existing `node_modules/<name>` at
  `npm.ts:180` confirmed — beta.3 is unpublished, so resolution can only have
  come from the seed).
- **Runtime model set moved with kiro-cli 2.20.1**: new runtime IDs (`glm-5`,
  `minimax-m2.5`, `qwen3-coder-next`, `deepseek-3.2`, …); catalog ∩ runtime is
  still exactly **18** with the July models.dev artifact.
- **Harness footnote (not upstream)**: npm walks UP to the nearest package root
  when the target dir has no `package.json` — seeding the registry layout needs
  a stub `package.json` in the seed dir first (a scratch package root under the
  temp tree absorbed one stray install before this was added; no repo touched).
- Session/prompt API shape unchanged (`POST /api/session` takes `model` incl.
  `variant`; `POST /api/session/:id/prompt {text}`); Basic auth +
  `{location,data}` envelope unchanged; assistant `providerState` mirror
  unchanged.
