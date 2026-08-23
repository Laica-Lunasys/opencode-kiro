# opencode-kiro

> ⚠️ **Experimental prerelease** — `0.5.0-beta.2` targets the **unreleased OpenCode v2**
> plugin contract at a pinned snapshot. It does **not** work with OpenCode v1.
> v1 users: stay on **`opencode-kiro@0.4.0`** (the `main` branch / npm `latest` line,
> which remains the supported stable release). See
> [RELEASE_NOTES_0.5.0-beta.2.md](./RELEASE_NOTES_0.5.0-beta.2.md) and
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
- **TUI credits display**: a live Kiro credits box in the sidebar and a compact
  credits chip in the prompt footer row beside the host cost/context display, both
  styled with the host's active theme tokens — auto-loaded from the same single
  config entry (`tui: true`)

`kiro-acp-ai-provider` talks to your locally installed `kiro-cli` over Kiro's
[Agent Client Protocol](https://agentclientprotocol.com) (ACP). This is the supported
integration path: requests go through kiro-cli exactly like Kiro's own IDE clients,
with no credential scraping and no reuse of Kiro credentials against other providers.

## Compatibility

This prerelease is built and tested against **one pinned OpenCode v2 snapshot**:

| Item | Value |
|---|---|
| Tested OpenCode commit (`upstream/v2`) | `1cf61593b5ec204619b3f679fe418fec10ca5934` |
| `@opencode-ai/plugin` | `0.0.0-dev-17968` (exact) |
| Package version | `0.5.0-beta.2` |

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

**One config entry — that's the whole setup.** Add the package to the **`plugins`**
array (plural) of your OpenCode config (`opencode.json`, project or global):

```json
{
  "plugins": ["opencode-kiro@0.5.0-beta.2"]
}
```

The object form pins the same version and leaves room for future options:

```json
{
  "plugins": [
    {
      "package": "opencode-kiro@0.5.0-beta.2",
      "options": {}
    }
  ]
}
```

This loads the server entry (`./server` export): auth, model discovery, and provider
ownership. The server plugin declares **`tui: true`**, so the host TUI **auto-loads the
package's `./tui` entrypoint by itself** — the sidebar credits box and the prompt footer
credits chip appear with no further configuration. **No `cli.json` TUI entry is
needed.** (The beta.1 two-file setup is obsolete: if you added `"opencode-kiro"` to
your global `cli.json` `plugins` array for beta.1, remove it.)

### Disabling

One `"-kiro"` directive in the same `plugins` array disables **everything**: it removes
the server plugin, and with it the `tui: true` auto-load, so the TUI half never
activates either:

```json
{
  "plugins": ["opencode-kiro@0.5.0-beta.2", "-kiro"]
}
```

### Legacy `tui.json` (v1)

`tui.json` is **legacy v1 configuration** and, under v2, is **migration input only**:
the host may read it when migrating old setups, and this plugin **never modifies it**.
Do not add new entries to `tui.json` (or to `cli.json` — neither is used by this
plugin anymore); the single `plugins` entry above is the only configuration.

### Local development (path source)

Run a local checkout without npm — build and pack first, then reference the tarball
with the `name@file:` form in the `plugins` array:

```bash
git clone https://github.com/NachoFLizaur/opencode-kiro && cd opencode-kiro
npm install && npm run build && npm pack
```

```json
{ "plugins": ["opencode-kiro@file:/absolute/path/to/opencode-kiro-0.5.0-beta.2.tgz"] }
```

A bare path or bare `file:` spec is rejected at the tested SHA — the `name@file:` form
is required. **Caveat (local `file:` installs only)**: the colon in the resulting
install dirname defeats the host's OpenTUI loader shim, so the TUI surfaces render a
contained per-slot error notice instead of the credits views (the rest of the TUI keeps
working). Registry installs (`opencode-kiro@0.5.0-beta.2`) use colon-free paths and are
fully green — this affects local tarball validation only.

The host resolves entrypoints from the package `exports` (`./server` for the server
half, `./tui` for the auto-loaded TUI half). Each entry module exports its own `id`:
the server plugin's id is `kiro` and the TUI plugin's id is `opencode-kiro`. Under
`tui: true` there is no separate TUI directive to manage — `-kiro` (the server id) is
the single kill-switch, and host logs use `kiro` for the server half and
`opencode-kiro` for the TUI half.

## Auth

```bash
opencode auth login
```

Select the **Kiro** integration, then the **Kiro CLI Login** method:

- **Already logged in to kiro-cli**: immediate success; the existing kiro-cli session is reused.
- **Not logged in**: the plugin launches `kiro-cli login`, which opens a browser window.
  Complete the login there; the plugin polls for up to 120 seconds and stores a minimal
  credential record when kiro-cli reports success.

There is no configuration prompt during login anymore: the beta.1
"Enable the Kiro credits sidebar?" consent select was removed (upstream deleted the
prompts API in favor of forms — and the sidebar no longer needs consent-driven config,
since `tui: true` auto-loads it).

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
plugin renders two surfaces:

- a Kiro credits box in the sidebar (`sidebar.content` claim), showing the session's
  live credits total and unit
- a compact credits chip in the prompt footer row beside the host cost/context
  display (`prompt.footer.status` claim, v1 placement restored) with the same total

Both are additive `append` claims — they compose with the host's built-in content and
never replace it — and both pick up the active theme's text tokens (feature-detected;
with no theme they fall back to default terminal styling). They render only for
sessions that carry Kiro credit data; other sessions are unchanged. The credits value
and unit come from the provider state the host persists on each message part
(`part.state.credits` / `part.state.creditsUnit`); nothing is hardcoded client-side.
The only configuration needed is the single `plugins` entry from
[Install](#install-and-configure) — the TUI half auto-loads via `tui: true`.

Durable credits are read straight from host message state (the host persists provider
state on text end — fixed upstream since beta.1). While a turn is still streaming,
credits for just-ended text are picked up live through a transient overlay that works
around a host reducer bug at the pinned snapshot (the live event path still drops
provider state); once durable state arrives it is authoritative and nothing is
double-counted. See the release notes for details.

## Known limitations (prerelease)

- **Live text credits use a transient overlay.** The durable credits path is fixed
  upstream, but the live `session.text.ended` reducer still drops provider state at
  the tested SHA, so in-turn updates come from the plugin's transient overlay
  (durable state always wins on reconcile). See
  [Credits in the TUI](#credits-in-the-tui) and the release notes.
- **Credits render in the TUI only.** Every other cost surface (ACP clients, web,
  desktop, share pages, CLI cost output) shows $0.00 for Kiro sessions because the
  catalog declares Kiro's per-token `cost` as 0 (subscription-metered, no per-token
  pricing). That is expected, not a defect.
- **Local `file:` installs show a per-slot TUI error.** The colon in a `name@file:`
  install dirname defeats the host's OpenTUI loader shim; the failure is contained to
  the plugin's slots (dismissible error notice, host TUI unaffected). Registry
  installs are colon-free and fully working — this affects local tarball validation
  only.
- **Reduced toast feedback.** Auth-flow feedback is delivered as connect-flow text
  rather than toasts; this plugin's core deliberately does not depend on the churning
  TUI toast API.
- **One tested snapshot.** All pins are exact and the compatibility target is a single
  OpenCode v2 SHA (see [Compatibility](#compatibility)); other snapshots may not work.

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
| No credits line / credits stay 0 | Credits appear after the first **completed** kiro turn; cancelled turns and turns without usage state contribute nothing. Check the plugin is active (no stray `"-kiro"` directive — note that directive residue can persist on a reused data dir). |
| Credits surfaces never appear | The TUI half auto-loads from the server `plugins` entry via `tui: true` — no separate TUI config exists. If the box/chip are missing, the server plugin itself is not loading (check your `plugins` entry and restart opencode). For local `name@file:` tarball installs, a contained per-slot error notice instead of the credits views is the known colon-path caveat; use a registry install. |
| `kiro` provider not showing in `opencode models` | Run `opencode auth login` first: models are discovered after auth. If the loaded catalog lacks a `kiro` entry, the plugin self-registers a minimal fallback during discovery. |
| Path install rejected (`must export id`) | Use the `name@file:<absolute tarball path>` form after `npm run build && npm pack` in your checkout (both entry modules export ids). |
| Provider visible but runs fail | The provider can be selectable before any credential exists. Run `opencode auth login` first. |
| Worked yesterday, broken today | This prerelease targets one pinned OpenCode snapshot (see [Compatibility](#compatibility)). If your OpenCode build moved past the tested SHA, the v2 plugin surface may have changed underneath it. |

## Legacy: v1 / OpenCode v1 users (`0.4.0`)

`opencode-kiro@0.4.0` on the `main` branch is the supported stable line for OpenCode
v1 (`opencode >= 1.16.0`). It uses the v1 contract throughout: singular `plugin`
arrays in `opencode.json` and `tui.json`, the `opencode plugin opencode-kiro`
installer, and `part.metadata.kiro` credits. Its full documentation is the README at
the [`v0.4.0` tag](https://github.com/NachoFLizaur/opencode-kiro/tree/v0.4.0)
(equivalently, `main`). Do not install `0.5.0-beta.2` into an OpenCode v1 setup.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsup builds dist/server.js + dist/tui.js (+ d.ts)
npm test            # vitest
```

## License

[MIT](./LICENSE) © Nacho F. Lizaur
