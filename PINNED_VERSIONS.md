# Pinned Versions — opencode-v2 prerelease

**Package version**: `0.5.0-beta.3`
**Recorded**: 2026-07-28 (task 02, opencode-v2-migration); re-pinned 2026-07-29 (Phase 4 gate iteration 2); re-pinned 2026-08-23 (Phase 8, task 24); re-pinned 2026-08-30 (Phase 9, task 30)

## Exact pins (v2-sensitive dependencies) — CURRENT (Phase 9, 2026-08-30)

| Package | Pinned version | Where |
|---|---|---|
| `@opencode-ai/plugin` | `0.0.0-dev-18686` | devDependencies + peerDependencies (exact; dev channel — the live v2 channel) |
| `@opentui/solid` | `0.5.9` | dependencies (exact; max published, sole version satisfying the new `>=0.5.9` peer floor; bundler-external, never bundled) |
| `solid-js` | `1.9.12` | dependencies (exact; `@opentui/solid@0.5.9` peers this EXACTLY; bundler-external, never bundled) |
| `kiro-acp-ai-provider` | `3.0.0` | dependencies (exact, unchanged from v1) |

## Tested OpenCode compatibility target — CURRENT (Phase 9)

| Item | Value |
|---|---|
| Tested OpenCode SHA (`upstream/v2` head, 2026-08-29) | `8ba434b5973856b2f32b8cd3543e154b25c413e6` |
| Prior tested SHA (Phase 8 re-pin, superseded) | `1cf61593b5ec204619b3f679fe418fec10ca5934` |
| `engines.opencode` | Removed — v2 host has no stable semver; the tested SHA above is the compatibility target |

### Phase 9 re-pin (2026-08-30, task 30) — supersession notes

- Supersedes `@opencode-ai/plugin@0.0.0-dev-17968` + OpenCode SHA `1cf61593b5…`
  (Phase 8 pins, evidence retained below for audit).
- **Version correlation**: head `8ba434b5973856b2f32b8cd3543e154b25c413e6` committed
  2026-08-29T13:31:04Z; `0.0.0-dev-18686` published 2026-08-29T13:43:01Z (~12 min
  later — the CI build OF that head; `dev-18685` predates the commit, `dev-18687+`
  are post-head). Pinned by exact version string, never by dist-tag. npm `latest`
  (1.18.25) remains the stale v1 line; `dev` remains the live v2 channel.
- **Peer changes at this pin**: @opentui peer floor moved `>=0.5.7` → `>=0.5.9` →
  `@opentui/solid` bumped `0.5.7` → `0.5.9` (max published; registry query
  2026-08-30). `@opentui/solid@0.5.9` peers `solid-js@1.9.12` EXACTLY → solid-js
  pin unchanged. New optional peer version `@opencode-ai/theme@0.0.0-dev-18686`
  (not installed — optional, host-provided).
- **THE FIX prerequisite shipped in this package**: the event union carries
  `credential.updated` + `credential.switched`; `integration.connection.updated`
  is GONE (upstream `eb1ac54d73`/`62d9aa9838`) — task 31 widens the discovery
  filter to dual-listen on all three names.
- **Typecheck window**: typecheck intentionally RED between task 30 and tasks
  31/32 (event-name + any additive-surface absorption).

## Installed tarball verification evidence (`@opencode-ai/plugin@0.0.0-dev-18686`) — CURRENT

Verified on 2026-08-30 (task 30 gate) against a hermetic temp-dir
`npm install --ignore-scripts` AND re-confirmed on the in-repo
`node_modules/@opencode-ai/plugin` after the re-pin install:

1. **Version**: installed `package.json` reports exactly `0.0.0-dev-18686`.
2. **Exports map** (v2 layout — PASS): `.` → `./dist/promise/index.js`,
   `./effect` → `./dist/effect/index.js`, `./tui` → `./dist/tui/index.js`, plus a
   `./*` → `./dist/*.js` wildcard. `./v1` is **GONE**; stale `./v2/promise`
   layout ABSENT.
3. **TUI claims API** (PASS): `dist/tui/context.d.ts:160` `export type SlotPath =
   keyof SlotMap`; `:180` `export type SlotClaim<Path extends SlotPath …>`;
   `:405` `readonly slot: (claim: SlotClaim) => () => void`. `SlotMap` includes
   our two claim paths: `"prompt.footer.status"` (`:148`) and
   `"sidebar.content"` (`:153`, props `{ sessionID: string }`);
   `"session.composer.top"` (`:150`) still present.
4. **Integration forms API** (PASS): `dist/promise/integration.d.ts:14`/`:25`
   `readonly form?: Form.Fields`; `:46` `authorize: (answer: Form.Answer) =>
   Promise<IntegrationOAuthAuthorization>`; `:32-33`
   `IntegrationOAuthAuthorization = { readonly url: string; … }`. No
   `prompt`/`prompts` occurrence anywhere in `integration.d.ts`.
5. **Server plugin TUI auto-load flag** (PASS): `dist/promise/plugin.d.ts:52`
   `readonly tui?: boolean;`.
6. **Credential event rename — THE FIX prerequisite** (PASS):
   - `@opencode-ai/schema/dist/event-manifest.d.ts:44` `type:
     Schema.Literal<"credential.updated">` with `data: Schema.Struct<{}>`
     (EMPTY payload — always re-check `connection.active`); `:76`
     `Schema.Literal<"credential.switched">` with `data: Schema.Struct<{
     integrationID: Integration.ID, credentialID: NullOr<Credential.ID> }>`
     (Kiro-scopable; credentialID is NULLABLE).
   - Client event union: `@opencode-ai/client/dist/promise/generated/types.d.ts:1401`
     `type: "credential.updated"`, `:1411` `type: "credential.switched"`.
   - `integration.connection.updated` is **ABSENT** from every installed
     `@opencode-ai/*` dist (recursive grep, zero hits) — the rename shipped in
     this package.
7. **Credential.OAuth / OAuth attempt** (PASS, one benign type widening):
   `@opencode-ai/schema/dist/credential.d.ts:162-169` `OAuth = { type:"oauth",
   methodID, refresh, access, expires, metadata? }` — `expires` is now
   `Schema.Int` (was NonNegativeInt); `expires: 0` remains valid, no code
   impact. `IntegrationOAuthAuthorization.url` is plain `string`.
8. **Peer ranges** (PASS, floor moved): `@opentui/core >=0.5.9`,
   `@opentui/solid >=0.5.9`, `solid-js >=1.9.0`, `@opencode-ai/theme
   0.0.0-dev-18686` (all optional).
9. **@opentui/solid selection**: published versions end at `0.5.9` (registry
   query 2026-08-30) — only `0.5.9` satisfies `>=0.5.9`; its
   `peerDependencies` are exactly `{ "solid-js": "1.9.12" }` → both pinned
   exact. In-repo `npm ls @opencode-ai/plugin @opentui/solid solid-js` resolves
   clean with solid-js fully deduped to a single `1.9.12` instance.

## Exact pins — Phase 8 record (superseded 2026-08-30 by the Phase 9 re-pin above)

| Package | Pinned version | Where |
|---|---|---|
| `@opencode-ai/plugin` | `0.0.0-dev-17968` | devDependencies + peerDependencies (exact; dev channel — the live v2 channel) |
| `@opentui/solid` | `0.5.7` | dependencies (exact; max published at the time, sole version satisfying the `>=0.5.7` peer floor; bundler-external, never bundled) |
| `solid-js` | `1.9.12` | dependencies (exact; `@opentui/solid@0.5.7` peers this EXACTLY; bundler-external, never bundled) |
| `kiro-acp-ai-provider` | `3.0.0` | dependencies (exact, unchanged from v1) |

## Tested OpenCode compatibility target — Phase 8 record (superseded)

### Phase 8 re-pin (2026-08-23, task 24) — supersession notes

- Supersedes `@opencode-ai/plugin@0.0.0-next-16420` + OpenCode SHA `b47cfbee7c…`
  (Phase 4 gate iteration 2 pins, evidence retained below for audit).
- **Channel change**: the `next` dist-channel is stale/dead; `dev` is the live v2
  channel. Pinned by exact version string `0.0.0-dev-17968` (published in CI-feed
  correlation with head `1cf61593b5…`), never by dist-tag.
- **Peer changes at this pin**: @opentui peer floor moved `>=0.4.5` → `>=0.5.7`;
  the `@opentui/keymap` peer was DROPPED; solid-js peer relaxed to `>=1.9.0`
  (we stay exact at `1.9.12` per `@opentui/solid@0.5.7`'s exact peer). New
  optional peer `@opencode-ai/theme@0.0.0-dev-17968` (not installed — optional,
  host-provided).
- **Breaking API deltas absorbed by tasks 25/26** (typecheck intentionally RED
  between task 24 and tasks 25/26): slot claims API replaces `SlotName`-keyed
  `ui.slot(name, render)`; integration `prompts` API deleted in favor of
  `Form.Fields`/`Form.Answer`; `session.composer.top` slot REVIVED under the
  claims system.

## Installed tarball verification evidence (`@opencode-ai/plugin@0.0.0-dev-17968`, superseded)

Verified on 2026-08-23 (task 24 gate) against a hermetic temp-dir
`npm install --ignore-scripts` AND re-confirmed on the in-repo
`node_modules/@opencode-ai/plugin` after the re-pin install:

1. **Version**: installed `package.json` reports exactly `0.0.0-dev-17968`.
2. **Exports map** (v2 layout — PASS): `.` → `./dist/promise/index.js`,
   `./effect` → `./dist/effect/index.js`, `./tui` → `./dist/tui/index.js`, plus a
   `./*` → `./dist/*.js` wildcard. `./v1` is **GONE** (no `dist/v1*` files exist);
   stale `./v2/promise` layout ABSENT.
3. **TUI claims API** (PASS): `dist/tui/context.d.ts:158` `export type SlotPath =
   keyof SlotMap`; `:178` `export type SlotClaim<Path extends SlotPath …>`
   (placement kinds prepend/append/before/after/replace, mutually exclusive);
   `:403` `ui.slot: (claim: SlotClaim) => () => void`. `SlotName` is **ABSENT**
   from the d.ts. `SlotMap` (`:142`) includes `"prompt.footer.status"` (`:146`),
   `"session.composer.top"` (`:148`, props `{ sessionID: string }`),
   `"sidebar.content"` (`:151`, props `{ sessionID: string }`).
4. **Integration forms API** (PASS): `dist/promise/integration.d.ts:10`
   `IntegrationOAuthMethod` with `:14` `form?: Form.Fields`; `:46`
   `authorize: (answer: Form.Answer) => Promise<IntegrationOAuthAuthorization>`.
   No `prompt`/`prompts` occurrence anywhere in `integration.d.ts`.
5. **Server plugin TUI auto-load flag** (PASS): `dist/promise/plugin.d.ts:40`
   `readonly tui?: boolean;`.
6. **Peer ranges** (PASS): `@opentui/core >=0.5.7`, `@opentui/solid >=0.5.7`,
   `solid-js >=1.9.0`, `@opencode-ai/theme 0.0.0-dev-17968` (all optional);
   `@opentui/keymap` peer **DROPPED**.
7. **@opentui/solid selection**: published versions end at `0.5.7` (registry query
   2026-08-23) — only `0.5.7` satisfies `>=0.5.7`; its `peerDependencies` are
   exactly `{ "solid-js": "1.9.12" }` → both pinned exact. In-repo
   `npm ls @opencode-ai/plugin @opentui/solid solid-js` resolves clean with
   solid-js fully deduped to a single `1.9.12` instance.

## Exact pins — Phase 4 record (superseded 2026-08-23 by the Phase 8 re-pin above)

| Package | Pinned version | Where |
|---|---|---|
| `@opencode-ai/plugin` | `0.0.0-next-16420` | devDependencies + peerDependencies (exact) |
| `@opentui/solid` | `0.4.5` | dependencies (exact; peer floor AND max published; bundler-external, never bundled) |
| `solid-js` | `1.9.12` | dependencies (exact; `@opentui/solid@0.4.5` peers this EXACTLY; bundler-external, never bundled) |
| `kiro-acp-ai-provider` | `3.0.0` | dependencies (exact, unchanged from v1) |

## Tested OpenCode compatibility target — Phase 4 record (superseded)

| Item | Value |
|---|---|
| Tested OpenCode SHA (`upstream/v2` head) | `b47cfbee7c4fd24e5d73e5753b4755db62a92a63` |
| Prior tested SHA (Phase 1–4 pin, superseded) | `010133f6df21ab273b260327670f19c95e7a167c` (33 commits behind the re-pin) |
| Prior researched-doc SHA | `1be6d94267a4e16b12e5927bb2357ceb83020c85` (migration doc research basis) |
| `engines.opencode` | Removed — v2 host has no stable semver; the tested SHA above is the compatibility target |

### Re-pin rationale (2026-07-29, Phase 4 gate iteration 2)

- `fe91698ed6` — the host now calls `ensureRuntimePluginSupport()`: an OpenTUI loader
  shim redirects external-plugin imports of `solid-js`/`@opentui/*` to the HOST's
  module instances, eliminating the module-identity crash recorded under
  "B2 fix re-verification" below. The plugin's original own-node rendering design
  works as intended at this SHA.
- `44cd984589` — TUI slots became a typed closed set (`SlotMap`): `app`,
  `home.footer`, `sidebar.content` (props `{ sessionID }`), `sidebar.footer`.
  `session.composer.top` no longer exists → the composer credits strip is descoped;
  credits are sidebar-only.
- Promise/Effect plugin API + schemas are byte-identical to the prior pin — server
  code needed zero changes.
- The `session.text.ended` reducer bug is still live at this SHA; the transient-store
  workaround stays.
- Prior SHA history (evidence below recorded at `010133f6df…`) is kept for audit.

## Installed tarball verification evidence (`@opencode-ai/plugin@0.0.0-next-16420`, superseded)

Verified on 2026-07-29 against the published tarball and `node_modules/@opencode-ai/plugin`:

1. **Version**: installed `package.json` reports exactly `0.0.0-next-16420`.
2. **Exports map** (v2 layout — PASS): `.` → `./dist/promise/index.js`, `./effect`,
   `./tui`, `./v1`; stale `./v2/promise` layout **ABSENT**.
3. **Dist types** (post-`44cd984589` slot typing — PASS): `dist/tui/context.d.ts:99`
   declares `SlotMap` with exactly `app`, `home.footer`, `sidebar.content`
   (props `{ sessionID: string }`), `sidebar.footer`; `"session.composer.top"` is
   **ABSENT**; `ui.slot` is `<Name extends SlotName>(name, render: Slot<Name>) => () => void`.
4. `./tui` `Plugin.Definition`/`Plugin.Context`/`Plugin.Cleanup` namespacing unchanged;
   `data.on` is now typed against `OpenCodeEvent["type"]`.

## Prior tarball verification evidence (`@opencode-ai/plugin@0.0.0-next-16383`, superseded)

Verified on 2026-07-28 against `node_modules/@opencode-ai/plugin`:

1. **Version**: installed `package.json` reports exactly `0.0.0-next-16383`.
2. **Exports map** (v2 layout — PASS):
   - `.` → `./dist/promise/index.js` (Promise API)
   - `./effect` → `./dist/effect/index.js`
   - `./tui` → `./dist/tui/index.js`
   - `./v1` → `./dist/v1/index.js`
   - Stale `./v2/promise` layout: **ABSENT** (rejected criterion not triggered).
3. **Dist types** (v2 surface — PASS):
   - Root promise `Plugin.Context` exposes `aisdk`, `catalog`, `integration`, `event` domains
     (`dist/promise/plugin.d.ts`).
   - `./tui` `Context` exposes `ui.slot(name, render)`, `data.session.message.list/sync`,
     `data.on(type, handler)`, and post-head surface: `ToastOptions` (`dist/tui/context.d.ts:101`),
     `ui.toast.show`, `ui.dialog`, `theme`, `attention`, `renderer` — evidence the tarball is the
     post-head build.
4. **Node ESM smoke imports** (PASS):
   - `import('@opencode-ai/plugin')` → keys: `Agent, Command, Connection, Credential, Integration, Model, Plugin, Provider, Reference, Skill, WebSearch`
   - `import('@opencode-ai/plugin/tui')` → keys: `Plugin`

## v1 baseline (recorded by task 01, `main` @ `b4303d6` = v0.4.0)

- `npm run typecheck` (tsc --noEmit): **clean** (exit 0)
- `npm test` (vitest 4.1.8): **3 test files passed, 67 tests passed, 0 failed**

## Host validation evidence (recorded by task 13, `opencode-v2`, 2026-07-29)

- **OpenCode SHA re-confirmed at test time**: `010133f6df21ab273b260327670f19c95e7a167c`
  (detached `git worktree` of the local clone; `git rev-parse HEAD` matched the pin
  exactly, worktree used read-only and removed afterwards — the clone stayed on
  `feat/kiro-provider` @ `3a68247163` with an empty `git status --short` before and
  after).
- **Artifact under test**: `opencode-kiro-0.5.0-beta.1.tgz` (`npm pack`, 10 files,
  dist-only, 12,523 B), installed from scratch by the host itself (arborist) into a
  hermetic `$XDG_CACHE_HOME/opencode/packages/…`, with hermetic `HOME`/XDG dirs.
- **Toolchain observed**: Bun 1.3.14 host runtime, Node 26.3.0 for out-of-band
  probes, kiro-cli 2.15.1, `kiro-acp-ai-provider@3.0.0` resolved from the tarball.
- **Results summary**: 11 PASS, 1 PARTIAL, 2 FAIL of 13 checklist rows.
  - PASS: `./server` + `./tui` entry resolution from the tarball, setup/cleanup
    contract (no orphaned `kiro-cli`/ACP processes), `kiro` integration +
    "Kiro CLI Login" method, already-authed login → stored credential, runtime
    self-registration (19 models with effort variants), key-unwrapped durable
    `part.state.credits` / `part.state.creditsUnit` on a text-only turn, logout
    removing all runtime models, worktree teardown.
  - FAIL: TUI slots never render — packaged `dist/tui.js` `setup()` cannot resolve
    `@opentui/solid`/`solid-js`/`@opentui/core` from the isolated plugin install
    (blocker B2); effort variants are inert — `providerOptions.kiro.reasoningEffort`
    is never populated by the host for third-party AI-SDK packages and the settings
    key is `effort`, not `reasoningEffort` (blocker B3).
  - PARTIAL: credits verified durably server-side; the TUI-live/transient path is
    blocked by B2.
- **Open questions answered empirically**: the pinned models.dev catalog has **no**
  Kiro entry (174 providers, zero "kiro" occurrences) → the self-registration
  fallback is the live branch; `DynamicProviderPlugin` creates **no** extra unowned
  ACP process (identical process counts with it enabled and with
  `"-opencode.provider.dynamic"`).
- Full evidence, root causes and candidate fixes: `HOST_E2E_REPORT.md`.
- **Install-spec correction found here**: package plugins must be declared as
  `"<name>@file:<abs tgz>"`; a bare `file:<abs tgz>` or a bare absolute path fails
  to install/resolve at this SHA (blocker B1).

## B2 fix re-verification (`opencode-v2` @ `7df3ea2`, 2026-07-29)

Re-run of checklist items 9/10 against the same pinned host after `@opentui/solid`
+ `solid-js` moved from devDependencies into `dependencies`. **Result: the move is
necessary but NOT sufficient — it does not make the TUI work.**

- **Resolution half fixed**: the host's isolated plugin tree now really does contain
  `@opentui/solid@0.4.5`, `solid-js@1.9.12` and (transitively) `@opentui/core@0.4.5`
  + native `@opentui/core-darwin-arm64@0.4.5`; `setup()` runs and registers both slots.
- **Render half broken, and worse than before**: the first `createElement` in the
  plugin's own `@opentui/solid` throws `No renderer found` and the whole host TUI
  crashes (`OpenCode crashed`), where the pre-fix failure was merely silent
  non-activation. A control run with the plugin disabled renders normally.
- **The pin table above is not the lever.** The breakage is solid **module-instance
  identity** (`useContext(RendererContext)` depends on solid's module-global `Owner`
  and on a per-copy `createContext` id), not version skew — so pinning the plugin's
  `solid-js` to the host's exact patched `1.9.10` would fail identically. Any plugin
  that ships its own `@opentui/solid` + `solid-js` cannot render into the host's
  renderer at this SHA, whatever the versions say. Note also that the host itself
  runs `@opentui/solid@0.4.5` against patched `solid-js@1.9.10`, violating that
  package's exact `solid-js: "1.9.12"` peer, with no ill effect — further evidence
  that the exact-peer pin is not what matters here.
- Therefore these two `dependencies` entries should be treated as provisional: they
  are correct only if the plugin keeps constructing its own nodes, which the pivot to
  B2 Option 2/3 may remove entirely.
  - **Resolved in gate iteration 2**: the re-pin to `b47cfbee7c…` keeps them as real
    `dependencies` ON PURPOSE. With the host's `ensureRuntimePluginSupport()` loader
    redirection (`fe91698ed6`), the plugin-local copies never load inside the TUI
    host, but declaring them preserves plain-Node loadability of `dist/tui.js` and
    the packed-install resolution lock (B2 regression test).
- Evidence: `HOST_E2E_REPORT.md` → "Fix verification — B2 Option 1 (re-run at 7df3ea2)".

## Rule

Never publish with `next`, `latest`, caret (`^`), tilde (`~`), or asterisk (`*`)
specifiers for v2-sensitive deps (`@opencode-ai/plugin`, `@opentui/solid`,
`solid-js`, `kiro-acp-ai-provider`). Dist-tags `latest`/`beta`/`dev` carry the
stale v1-era layout and must be rejected; re-verify the installed tarball before
each prerelease.

## Host re-verification at the re-pin (`opencode-v2` @ `45e5617` vs host `b47cfbee7c`, 2026-07-29, Phase 4 gate iteration 2)

Full host e2e re-run at the NEW pin. **RE-PIN VERIFIED** — evidence in
`HOST_E2E_REPORT.md` → "Re-verification at b47cfbee7c (re-pin, iteration 2)".

- **Host SHA re-confirmed at test time**: `b47cfbee7c4fd24e5d73e5753b4755db62a92a63`
  (detached read-only worktree; delta commits `fe91698ed6`, `44cd984589`,
  `27e7b0558a` all ancestors; clone stayed on `feat/kiro-provider` @ `3a68247163`,
  clean before and after).
- **Artifact**: fresh `npm pack` at `45e5617` (9 files, 12.6 kB — the composer-chip
  chunk is gone by design).
- **TUI verdict**: the sidebar `Kiro` credits box renders, live-updates
  (`0.08 → … → 0.8 credits`, pyte-verified across six pty runs), never crashes the
  host, never double-counts on reload — `ensureRuntimePluginSupport` redirection
  hands our solid imports the HOST's instances (probe: `createSignal` identity
  TRUE). The pin-table entries for `@opentui/solid`/`solid-js` behave exactly as
  the "Resolved in gate iteration 2" note above predicted: never loaded inside
  the TUI host, still needed for plain-Node loadability.
- **B3 fix verified on the wire**: variants emit `settings.effort`; a `#high` turn
  produced `commands/execute {command:"effort",args:{value:"high"}}` on kiro-cli's
  ACP stdin (main + ephemeral clients).
- **NEW upstream caveat B4**: the host's `name@file:<tgz>` package-install channel
  puts a `:` in the install dirname, which defeats the OpenTUI loader shim's
  exact-path rewrite → TUI crash for tarball-file installs ONLY. Registry-style
  install dirs (`opencode-kiro@0.5.0-beta.1`) are colon-free and verified working.
  Publishing to the registry is unaffected; local tarball TUI validation must load
  the plugin from a colon-free path.
- **Also new at this SHA**: server requires HTTP Basic auth (printed per-boot
  password); `{location,data}` API envelope; prompt API reshaped (model on session
  create / `POST :id/model`, prompt is `POST :id/prompt {text}`).

## Publish record (2026-07-29, USER-executed)

- **Published**: `opencode-kiro@0.5.0-beta.1` on the npm registry (`npm publish
  --tag beta` from `opencode-v2`; the agent never ran `npm publish`).
- **Integrity**: registry `dist.shasum d00dab9eab35425fbe3d06c3e4cd2667842a343e`
  = local `npm pack` tarball shasum (exact match).
- **Dist-tags after publish**: `beta` → `0.5.0-beta.1` (this prerelease's
  channel — the actual channel; the earlier `next-v2` plan was superseded),
  `latest` → `0.4.0` (v1 stable line, untouched), `next` → `0.3.6-rc.1`
  (pre-existing, untouched).
- **Post-publish verification**: bundled-binary smoke rebuilt from the registry
  package PASSED — see `HOST_E2E_REPORT.md` → "Published-package smoke
  (0.5.0-beta.1 @ registry)".

## Host validation evidence — beta.2 candidate (recorded by task 28, `opencode-v2` @ `d3458cc`, 2026-08-23)

Full host e2e at the Phase 8 pin — **BETA.2 E2E VERIFIED** (all 9 checklist rows
PASS); evidence in `HOST_E2E_REPORT.md` → "Beta.2 e2e at 1cf61593b5".

- **OpenCode SHA re-confirmed at test time**: `1cf61593b5ec204619b3f679fe418fec10ca5934`
  (detached read-only worktree; `rev-parse HEAD` matched the pin exactly; clone
  stayed on `feat/kiro-provider` @ `3a68247163` with empty porcelain before AND
  after; worktree removed). Host repo pins `packageManager: bun@1.3.14` at this
  SHA; bun 1.3.14 used.
- **Artifact under test**: `opencode-kiro-0.5.0-beta.2.tgz` (fresh `npm pack` at
  `d3458cc`: 10 files, 12.9 kB, shasum `96eddb597356773620f57ac8655ebadd6de458be`).
  Compare this against `dist.shasum` after the USER publishes.
- **Headline verified**: `tui: true` auto-load — ONE server `plugins` config
  entry, NO cli.json TUI entry; `plugin.list` carries `"tui": true`; the host TUI
  resolves and loads `./tui` itself; sidebar box + composer-top chip both render
  with host theme tokens.
- **B4 status at this pin**: still applies to `name@file:<tgz>` installs (colon
  install dirname defeats the loader shim) BUT the failure is now a contained
  per-slot error notice, not a whole-TUI crash. Registry-layout (colon-free)
  install verified fully green — the shipping channel is unaffected. Local
  tarball TUI validation still needs a colon-free path.
- **Credits**: durable path upstream-FIXED end-to-end (fresh mounts paint correct
  totals from `message.list` state with no transient store); live path still
  requires the transient overlay (`session.text.ended` reducer still copies only
  `text` at this SHA — now in `packages/client/src/solid/data.ts`); no
  double-count across 4 turns; 10 ms client event batching confirmed at source.
- **Effort on the wire**: `#high` variant produced
  `commands/execute {command:"effort",args:{value:"high"}}` on the main ACP
  client's stdin; turn recorded `variant:"high"` + durable credits.
- **Auth**: forms flow (`kiro-cli-login`, no `prompts` anywhere); pending →
  cancel (204 + child cleanup) → complete states observed; credential persists
  across server restarts.
- **Models**: the July models.dev artifact was REUSED unmodified (NOT rejected by
  the hardened resolution at this SHA); enrichment path verified (18 enriched,
  catalog 18 ∩ runtime 19, `claude-opus-5` dropped).
- **Disable**: one `-kiro` directive removes BOTH halves under `tui: true`
  (server plugin gone from plugin.list → TUI auto-load never activates it).

## Pre-publish record — 0.5.0-beta.2 release candidate (task 29, 2026-08-23)

- **Pre-flight pack at the release commit** (docs + release notes staged):
  `npm pack --dry-run` → `opencode-kiro-0.5.0-beta.2.tgz`, 10 files, package size
  13.6 kB (unpacked 40.9 kB), dist-only payload (dist/* + package.json + README.md
  + LICENSE), shasum `b6068466e0d1714826075ef0bcd6122a2ed934ed`. This SUPERSEDES the
  task-28 candidate shasum `96eddb597356773620f57ac8655ebadd6de458be` (packed at
  `d3458cc`, before the beta.2 docs landed in README.md). Compare THIS shasum
  against registry `dist.shasum` after the USER publishes.
- **AMENDMENT (pre-publish, chip placement)**: the credits chip moved
  `session.composer.top` → `prompt.footer.status` (v1 footer-row placement
  restored; user-approved). Fresh repack after the amendment:
  `opencode-kiro-0.5.0-beta.2.tgz` shasum
  `e1a27496cd644c60e688c1f0051b3a7052af2fad` — this SUPERSEDES the task-29
  candidate `b6068466e0d1714826075ef0bcd6122a2ed934ed` above. Compare THIS
  shasum against registry `dist.shasum` after the USER publishes. Placement
  re-verified in the host at the pin (HOST_E2E_REPORT.md row C-10): chip in the
  prompt footer row beside the host cost/context display, live-updating, sidebar
  box unaffected.
- **Publish handoff**: `npm whoami` returned 401 Unauthorized at pre-flight — the
  USER must authenticate (`npm login`) before running `npm publish --tag beta` from
  `opencode-v2`. The agent never publishes; the ACTUAL dist-tag used is recorded
  here post-publish.
- **Wiring-branch modernization (opencode worktree `opencode-v2-kiro`)**: new branch
  `feat/kiro-provider-v2-repin` @ `dd78215940` on base `1cf61593b5ec204619b3f679fe418fec10ca5934`
  — SERVER-ONLY built-in wiring (core dep `opencode-kiro` `0.5.0-beta.2` exact,
  `internal.ts` `pre` append via `PluginPromise.fromPromise`, bunfig age-gate
  excludes, root `@opencode-ai/plugin` `workspace:*` override). TUI half (builtins
  append) DROPPED — obsolete via `tui: true` auto-load. The `solid-js` `catalog:`
  override was DROPPED with it: its sole consumer was the statically bundled TUI
  built-in; re-verify dedupe at post-publish install. `bun install` deferred to
  post-publish (registry package required). UNPUSHED candidate; no PR. Prior branch
  `feat/kiro-provider-v2` kept untouched @ `b5177147cc` as history.

## Post-publish completion — wiring-branch install + dedupe re-check (task 29, 2026-08-23)

`opencode-kiro@0.5.0-beta.2` published to the registry (dist-tag `beta`, registry
`dist.shasum` `e1a27496cd644c60e688c1f0051b3a7052af2fad` — MATCHES the amended
pre-publish pack shasum above). In the wiring worktree (`feat/kiro-provider-v2-repin`,
base `1cf61593b5`), `bun install` succeeded with no age-gate error (bunfig excludes
effective); `bun.lock` resolves `opencode-kiro@0.5.0-beta.2` with registry integrity
`sha512-9S+y7Ft443RjtEruCimQot6yjr5A5U+BbPWYlBNjgUvbRxi9NkbxmZ4PB4wuMb4gecfz4/mWaQHOTbapvo1JQg==`
(matches `npm view dist.integrity`), and lockfile committed as `a655467972`
(`chore(core): lock opencode-kiro 0.5.0-beta.2 from registry (post-publish install)`).
Dedupe re-check with the `solid-js` override DROPPED confirms the server-only wiring
is solid-free at runtime: the published `dist/server.js` contains zero solid/opentui
import specifiers (only dynamic `child_process` and `kiro-acp-ai-provider`), and
`packages/core/node_modules` gains no solid-js/@opentui entries — the plugin's own
`solid-js@1.9.12` and `@opentui/solid@0.5.7` land only in bun's isolated store
(`node_modules/.bun/solid-js@1.9.12`, `@opentui+solid@0.5.7+7671d51c…`) as sibling
links of the `opencode-kiro@0.5.0-beta.2` store entry, never on core's resolution
path. That placement is benign for the `tui: true` auto-load path: the host TUI's
runtime-plugin loader shim (`@opentui/solid` `ensureRuntimePluginSupport`, installed
via `packages/tui/src/plugin/runtime-plugin-support.bun.ts`) registers a Bun plugin
that rewrites `solid-js`, `solid-js/store`, and `@opentui/solid/*` specifiers in
runtime-loaded plugin code to the HOST's module instances (catalog `solid-js@1.9.10`
/ `@opentui/solid@0.5.7`), so the plugin's nested copies are never dual-instanced
into the TUI. `packages/core` `bun run typecheck` (tsgo) passed clean. Branch remains
an UNPUSHED PR candidate; no binaries rebuilt.
