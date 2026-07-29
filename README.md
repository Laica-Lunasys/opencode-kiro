# opencode-kiro

> ⚠️ **Experimental prerelease** — `0.5.0-beta.1` targets the **unreleased OpenCode v2**
> plugin contract at a pinned snapshot. It does **not** work with OpenCode v1.
> v1 users: stay on **`opencode-kiro@0.4.0`** (the `main` branch / npm `latest` line,
> which remains the supported stable release). See
> [RELEASE_NOTES_0.5.0-beta.1.md](./RELEASE_NOTES_0.5.0-beta.1.md) and
> [PINNED_VERSIONS.md](./PINNED_VERSIONS.md) for exact pins and the tested OpenCode SHA.
> No OpenCode v2 release date is known or claimed here.

The ACP-compliant [Kiro](https://kiro.dev) plugin for [opencode](https://opencode.ai).

The plugin supplies:

- **Auth** via the official `kiro-cli` login flow: it registers the `kiro` integration
  with a **Kiro CLI Login** OAuth method (`opencode auth login`)
- **Model discovery**: after auth it captures Kiro's live model lineup and merges it
  into OpenCode's catalog (exact ID intersection, reasoning-effort variants), with a
  minimal self-registration fallback when the catalog lacks a `kiro` entry
- **Provider ownership**: an AISDK hook constructs the provider from
  [`kiro-acp-ai-provider`](https://www.npmjs.com/package/kiro-acp-ai-provider) with the
  right options (`cwd`, `agent`, `trustAllTools`, `mcpTimeout`, `contextWindows`)
- **TUI credits display**: a live Kiro credits box in the sidebar

`kiro-acp-ai-provider` talks to your locally installed `kiro-cli` over Kiro's
[Agent Client Protocol](https://agentclientprotocol.com) (ACP). This is the supported
integration path: requests go through kiro-cli exactly like Kiro's own IDE clients,
with no credential scraping and no reuse of Kiro credentials against other providers.

## Compatibility

This prerelease is built and tested against **one pinned OpenCode v2 snapshot**:

| Item | Value |
|---|---|
| Tested OpenCode commit (`upstream/v2`) | `b47cfbee7c4fd24e5d73e5753b4755db62a92a63` |
| `@opencode-ai/plugin` | `0.0.0-next-16420` (exact) |
| Package version | `0.5.0-beta.1` |

Full pin table and verification evidence: [PINNED_VERSIONS.md](./PINNED_VERSIONS.md).
There is no `engines.opencode` constraint — the v2 host has no stable semver yet; the
tested SHA above is the compatibility target. Other v2 snapshots may or may not work.

## Prerequisites

| Requirement | Notes |
|---|---|
| [kiro-cli](https://kiro.dev/docs/cli/) | Must be installed and on `PATH`; a Kiro subscription / AWS Builder ID account |
| [Node.js](https://nodejs.org) `>= 20` | Enforced via `engines.node`. |
| OpenCode v2 at the tested snapshot | See [Compatibility](#compatibility). This prerelease does not support OpenCode v1. |

## Install and configure

OpenCode v2 splits plugin configuration into **two separate files**, and both entries
are configured manually:

### 1. Server plugin — `plugins` in your OpenCode config

Add the package to the **`plugins`** array (plural) of your OpenCode config
(`opencode.json`, project or global). The object form pins the version and leaves room
for future options:

```json
{
  "plugins": [
    {
      "package": "opencode-kiro@0.5.0-beta.1",
      "options": {}
    }
  ]
}
```

A plain package string is also accepted:

```json
{
  "plugins": ["opencode-kiro@0.5.0-beta.1"]
}
```

This loads the server entry (`./server` export): auth, model discovery, and provider
ownership.

### 2. TUI plugin — `plugins` in your global `cli.json`

To enable the Kiro credits sidebar, add `"opencode-kiro"` to the **`plugins`** array in
your **global `cli.json`** (typically `~/.config/opencode/cli.json`) and restart
opencode:

```json
{
  "plugins": ["opencode-kiro"]
}
```

This loads the TUI entry (`./tui` export): the sidebar credits box. The connect flow
shows these same steps when you answer **Yes** to the
"Enable the Kiro credits sidebar?" prompt during `opencode auth login`.

### Legacy `tui.json` (v1)

`tui.json` is **legacy v1 configuration** and, under v2, is **migration input only**:
the host may read it when migrating old setups, and this plugin **never modifies it**
(the v1 consent-driven update of that file was deleted in v2). Do not add new entries
to `tui.json`; use the global `cli.json` `plugins` array described above.

### Local development (path source)

Run a local checkout without npm — build first, then reference the repo directory by
absolute path in both `plugins` arrays:

```bash
git clone https://github.com/NachoFLizaur/opencode-kiro && cd opencode-kiro
npm install && npm run build
```

```json
{ "plugins": ["/absolute/path/to/opencode-kiro"] }
```

OpenCode resolves the right entrypoint per file from the package `exports`
(`./server` for the server config, `./tui` for `cli.json`). Each entry module exports
its own `id`, which file-source TUI installs require: the server plugin's id is
`kiro` and the TUI plugin's id is `opencode-kiro`. Enable/disable directives and
host logs use `kiro` for the server plugin and `opencode-kiro` for the TUI plugin.

## Auth

```bash
opencode auth login
```

Select the **Kiro** integration, then the **Kiro CLI Login** method:

- **Already logged in to kiro-cli**: immediate success; the existing kiro-cli session is reused.
- **Not logged in**: the plugin launches `kiro-cli login`, which opens a browser window.
  Complete the login there; the plugin polls for up to 120 seconds and stores a minimal
  credential record when kiro-cli reports success.

If the flow times out, authenticate directly with kiro-cli (`kiro-cli login`) and run
`opencode auth login` again; the fast path then completes immediately.

kiro-cli owns credential storage and refresh — OpenCode never stores real AWS tokens,
and the plugin implements no refresh callback.

## Models

After authentication, the plugin captures Kiro's runtime model list and transforms
OpenCode's catalog to the exact, case-sensitive intersection of runtime `modelId`
values and catalog model IDs. Runtime reasoning-effort levels are merged as model
variants (per model family, native levels only); an optional runtime baseline effort
sets the model's base effort. A discovery failure or duplicate runtime ID leaves the
catalog unchanged (fail-open). If the loaded catalog has no `kiro` provider at all, the
plugin self-registers a minimal fallback entry so discovered models remain usable.

List the resulting models with:

```bash
opencode models
opencode run -m kiro/<exact-model-id> "hello"
```

Effort-capable models expose their variants through OpenCode's model-variant selection.
The chosen level reaches the SDK through the provider-settings path: OpenCode overlays
the selected variant's `settings` onto the model's `settings`, hands them to the
plugin's `aisdk` hook as `event.options`, and the plugin passes them verbatim to
`createKiroAcp({ effort })`. That is why the plugin emits the SDK's own `effort` key
(not `reasoningEffort`) — and why the SDK factory setting, not per-call provider
options, is the working carrier: OpenCode builds per-call `providerOptions` only for
the first-party `@ai-sdk/*` provider families, so `providerOptions.kiro.*` is never
populated for an `aisdk:` package provider like this one. Kiro cannot disable thinking,
so even the lowest level still produces a reasoning trail.

## Credits in the TUI

Kiro is subscription-metered: requests consume **credits**, and the dollar cost
OpenCode normally displays for Kiro turns is always $0.00. To surface credits the TUI
plugin renders one surface:

- a Kiro credits box in the sidebar (`sidebar.content` slot), showing the session's
  live credits total and unit

It renders only for sessions that carry Kiro credit data; other sessions are
unchanged. The credits value and unit come from the provider state the SDK attaches to
each message part (`part.state.credits` / `part.state.creditsUnit`); nothing is
hardcoded client-side. The only configuration needed is the `cli.json` `plugins` entry
from [Install](#2-tui-plugin--plugins-in-your-global-clijson).

While a turn is still streaming, credits for just-ended text are picked up live through
a transient store that works around a host reducer bug at the pinned snapshot (the
text-ended event's provider state is dropped by the host); once durable message state
arrives, it is authoritative and nothing is double-counted. See the release notes for
details.

## Known limitations (prerelease)

- **No slot ordering.** OpenCode v2 slots have no order parameter, so the sidebar
  credits box renders where the host places `sidebar.content` contributions (after the
  built-in sidebar sections), not at a plugin-chosen position.
- **Default styling.** The pinned snapshot has no supported theme-token API for plugin
  views, so the credits box uses default/inherited terminal styling instead of
  matching the active theme.
- **Reduced toast feedback.** Auth-flow feedback is delivered as connect-flow text
  (method instructions and the sidebar setup steps) rather than toasts. A toast API
  exists at the pinned snapshot, but this plugin's core deliberately does not depend on
  it — the TUI context surface is churning and toast availability is not guaranteed
  across snapshots.
- **Live text credits use a workaround.** See [Credits in the TUI](#credits-in-the-tui)
  and the release notes.
- **Credits render in the TUI only.** Every other cost surface (ACP clients, web,
  desktop, share pages, CLI cost output) shows $0.00 for Kiro sessions because the
  catalog declares Kiro's per-token `cost` as 0 (subscription-metered, no per-token
  pricing). That is expected, not a defect.

## How it works

- **Auth (Integration + Credential)**: the plugin upserts the `kiro` integration with a
  "Kiro CLI Login" OAuth method. `verifyAuth` from `kiro-acp-ai-provider` is the auth
  authority (it delegates to kiro-cli); success is stored as a minimal
  `Credential.OAuth` presence record.
- **Model discovery (catalog transform)**: after login (and on later login events) the
  plugin runs `listModels()` outside the transform, then applies the validated capture
  via a catalog transform and reload — exact ID matching, catalog metadata preserved,
  effort variants projected, fail-open on any discovery error.
- **Provider ownership (AISDK hook)**: the plugin's SDK hook always constructs the
  provider from `kiro-acp-ai-provider` with the plugin-supplied options and sets it as
  the event's SDK, so the Kiro provider is always plugin-owned. The options relay each
  model's context window into the SDK's `contextWindows` map keyed by model ID.
- **Session affinity & reset (in-SDK)**: the SDK keys kiro-cli sessions off OpenCode's
  session affinity, isolates tool-less utility calls on an ephemeral session, detects
  prompt-history divergence, and starts a fresh kiro session when needed.
- **Credits state**: the SDK reports `credits` / `creditsUnit` in each turn's provider
  metadata; OpenCode persists them key-unwrapped on message part state
  (`part.state.credits`, `part.state.creditsUnit`), and the TUI plugin sums them per
  assistant message (deduped across parts).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `kiro-cli is not installed` during auth | Install kiro-cli from <https://kiro.dev/docs/cli/> and ensure it is on `PATH` for the opencode process. |
| Auth times out after ~120s | Complete the browser login faster, or run `kiro-cli login` yourself, then re-run `opencode auth login` (fast path). |
| No credits line / credits stay 0 | Credits appear after the first **completed** kiro turn; cancelled turns and turns without usage state contribute nothing. Check `"opencode-kiro"` is listed in your global `cli.json` `plugins` array. |
| Credits box never appears | The TUI entry loads from the global `cli.json` `plugins` array only — a server-side `plugins` entry alone does not enable it. Add the `cli.json` entry and restart opencode. |
| `kiro` provider not showing in `opencode models` | Run `opencode auth login` first: models are discovered after auth. If the loaded catalog lacks a `kiro` entry, the plugin self-registers a minimal fallback during discovery. |
| Path install rejected (`must export id`) | Run `npm run build` in your checkout first and reference the repo root (both entry modules export ids). |
| Provider visible but runs fail | The provider can be selectable before any credential exists. Run `opencode auth login` first. |
| Worked yesterday, broken today | This prerelease targets one pinned OpenCode snapshot (see [Compatibility](#compatibility)). If your OpenCode build moved past the tested SHA, the v2 plugin surface may have changed underneath it. |

## Legacy: v1 / OpenCode v1 users (`0.4.0`)

`opencode-kiro@0.4.0` on the `main` branch is the supported stable line for OpenCode
v1 (`opencode >= 1.16.0`). It uses the v1 contract throughout: singular `plugin`
arrays in `opencode.json` and `tui.json`, the `opencode plugin opencode-kiro`
installer, and `part.metadata.kiro` credits. Its full documentation is the README at
the [`v0.4.0` tag](https://github.com/NachoFLizaur/opencode-kiro/tree/v0.4.0)
(equivalently, `main`). Do not install `0.5.0-beta.1` into an OpenCode v1 setup.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsup builds dist/server.js + dist/tui.js (+ d.ts)
npm test            # vitest
```

## License

[MIT](./LICENSE) © Nacho F. Lizaur
