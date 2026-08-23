# opencode-kiro 0.5.0-beta.2 — Release Notes

> ⚠️ **EXPERIMENTAL PRERELEASE.** This build targets the **unreleased OpenCode v2**
> plugin contract at one pinned snapshot. It is not compatible with OpenCode v1, is
> not covered by any stability promise, and may break without notice when OpenCode's
> v2 branch moves. **No OpenCode v2 release date is known or claimed.**
>
> OpenCode v1 users: stay on **`opencode-kiro@0.4.0`** — the `main` branch / npm
> `latest` line remains the supported stable release and is untouched by this
> prerelease.
>
> This release **supersedes `0.5.0-beta.1`**
> ([RELEASE_NOTES_0.5.0-beta.1.md](./RELEASE_NOTES_0.5.0-beta.1.md)), which targeted an
> older v2 snapshot and an older plugin API channel.

## Compatibility target

| Item | Value |
|---|---|
| Tested OpenCode commit (`upstream/v2` head, 2026-08-23) | `1cf61593b5ec204619b3f679fe418fec10ca5934` |
| Package version | `0.5.0-beta.2` |

There is no `engines.opencode` constraint: the v2 host has no stable semver yet, so
the tested SHA above is the compatibility target. Snapshots before or after it may
not work. Installed-tarball verification evidence for the pins below and the full
host e2e record are in [PINNED_VERSIONS.md](./PINNED_VERSIONS.md) and
[HOST_E2E_REPORT.md](./HOST_E2E_REPORT.md).

## Exact pins (v2-sensitive dependencies)

| Package | Pinned version | Where |
|---|---|---|
| `@opencode-ai/plugin` | `0.0.0-dev-17968` | devDependencies + peerDependencies (exact; the dev channel is the live v2 channel — pinned by exact version STRING, never by dist-tag) |
| `@opentui/solid` | `0.5.7` | dependencies (exact; sole published version satisfying the new `>=0.5.7` peer floor; bundler-external, never bundled) |
| `solid-js` | `1.9.12` | dependencies (exact; `@opentui/solid@0.5.7` peers this EXACTLY; bundler-external, never bundled) |
| `kiro-acp-ai-provider` | `3.0.0` | dependencies (exact, unchanged from v1) |

The `next` dist-channel that beta.1 pinned from (`0.0.0-next-16420`) is stale/dead.
Never substitute floating dist-tags or caret (`^`), tilde (`~`), or asterisk (`*`)
specifiers for any of the packages above.

## What changed from 0.5.0-beta.1

- **Re-pin to the current v2 head.** Tested OpenCode SHA moved
  `b47cfbee7c4fd24e5d73e5753b4755db62a92a63` → `1cf61593b5ec204619b3f679fe418fec10ca5934`
  (≈4 weeks of upstream v2 development); the plugin API pin moved from the dead
  `next` channel to `@opencode-ai/plugin@0.0.0-dev-17968`, and `@opentui/solid` moved
  `0.4.5` → `0.5.7` per the new peer floor.
- **Single-config install via `tui: true`.** The server plugin now declares the new
  `tui: true` flag, so the host TUI auto-loads the package's `./tui` entrypoint from
  the ONE server `plugins` entry. The beta.1 two-file setup (server `plugins` entry
  PLUS a TUI entry in the global `cli.json`) is obsolete — remove any old
  `"opencode-kiro"` `cli.json` entry. A single `"-kiro"` directive now disables both
  halves.
- **TUI slot claims.** The host replaced the `SlotName`-keyed `ui.slot(name, render)`
  API with claims (`ui.slot({ append: "<path>", render })`). Both surfaces are
  additive `append` claims — they compose with built-in content and never replace it.
- **Credits chip REVIVED — in the prompt footer row.** The compact credits chip
  (descoped in beta.1 when `session.composer.top` was removed upstream) renders again:
  one line with the session's credits total, in the prompt footer row beside the host
  cost/context display (v1 placement restored), alongside the sidebar box. It claims
  `prompt.footer.status` additively; the footer's `sessionID` is optional, so the chip
  is simply withheld on session-less footers, and it renders in both normal and shell
  prompt modes.
- **Theme-aware styling.** `context.theme` is now a typed `ResolvedTheme`; the box and
  chip pick up the host theme's text tokens (header = default text token, totals =
  subdued token), feature-detected — with no/misshapen theme the views keep default
  terminal styling. This reverses beta.1's documented "default styling" limitation.
- **Sidebar consent prompt REMOVED.** Upstream deleted the integration prompts API in
  favor of forms (`Form.Fields`/`Form.Answer`), which forced the removal of the
  beta.1 "Enable the Kiro credits sidebar?" select during `opencode auth login` —
  removal we already wanted, since `tui: true` auto-load makes consent-driven TUI
  config pointless. The "Kiro CLI Login" method now carries no form and no prompts;
  login behavior is otherwise unchanged.
- **Credits workaround NARROWED to a live-only overlay.** The durable path is fixed
  upstream: the server now persists provider state (`part.state.credits` /
  `part.state.creditsUnit`) on text end, so `message.list` carries credits after
  sync/reload and fresh TUI mounts paint correct totals with no plugin store
  (e2e-verified across three fresh mounts). The live event path still drops provider
  state at this SHA, so the transient store remains — now purely as a live overlay
  during streaming turns; the existing durable-wins reconcile keeps totals exact and
  never double-counts.
- **Transient overlay hosted in TUI `storage.memory`.** The live-overlay state now
  lives in the host's TUI memory storage (feature-detected, falls back to a local
  map), so it survives plugin hot reloads under the new npm-channel plugin
  management.
- **Provider activation audit.** The catalog transform was audited against the new
  required `Provider.Info.activation` field; providerID-scoped `aisdk` hooks are used
  where the promise API exposes them.

## Known limitations

1. **Live text credits still use the transient overlay.** At the tested SHA the live
   `session.text.ended` reducer copies only the ended text and drops the event's
   provider state (`packages/client/src/solid/data.ts`), so in-turn credit updates
   come from the plugin's transient overlay keyed by
   `(sessionID, assistantMessageID, ordinal)`. Durable state (fixed upstream) is
   authoritative on every reconcile; nothing is double-counted. The overlay is removed
   once the live-path fix ships upstream.
2. **Local `file:` installs render a per-slot TUI error.** The colon in a
   `name@file:<tarball>` install dirname defeats the host's OpenTUI loader shim. New
   at this snapshot: the failure is CONTAINED — a dismissible per-slot error notice
   instead of the beta.1 whole-TUI crash; transcript, composer, and built-ins keep
   working. Registry installs are colon-free and fully verified — this caveat affects
   local tarball validation only.
3. **No dollar cost anywhere.** Kiro is subscription-metered; the catalog declares
   per-token `cost` 0, so every non-TUI cost surface (ACP clients, web, desktop,
   share pages, CLI cost output) shows $0.00 for Kiro sessions. Credits render in the
   TUI surfaces only. Expected, not a defect.
4. **Prerelease pins are rigid.** All v2-sensitive pins are exact and the
   compatibility target is the single tested SHA above; host integration testing at
   that SHA is a mandatory pre-publish gate.

## Install / configuration summary

One entry (`opencode.json`, project or global):

```json
{
  "plugins": ["opencode-kiro@0.5.0-beta.2"]
}
```

No `cli.json` TUI entry, no `tui.json` — `tui: true` auto-loads the TUI half from the
same entry. Full instructions: [README.md](./README.md).

## Publishing guidance (maintainers)

- Publish this prerelease **only under an explicit prerelease dist-tag** — never the
  default `latest`:

  ```bash
  npm publish --tag beta
  ```

- `latest` must keep pointing at `0.4.0` (the v1 stable line on `main`).
- The actual dist-tag used at publish time is a runtime decision — record what
  actually happened in [PINNED_VERSIONS.md](./PINNED_VERSIONS.md) (beta.1 shipped
  under the `beta` dist-tag; this release is expected to update the same tag).
- Before publishing, re-verify the installed `@opencode-ai/plugin` tarball per the
  checklist in [PINNED_VERSIONS.md](./PINNED_VERSIONS.md) (exports map, claims API,
  forms API, `tui` flag), and re-run the full validation suite against the pins above.
- **No GA date claims.** Stable promotion (`0.5.0`) requires the stable definition of
  done in `OPENCODE_V2_MIGRATION.md` — a confirmed OpenCode v2 compatibility target,
  mutually published package versions, the upstream live-path text-ended fix, and
  upgrade testing from `0.4.0`. Do not promote merely because the prerelease compiles
  against one beta snapshot.
