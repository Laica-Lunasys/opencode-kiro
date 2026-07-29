# opencode-kiro 0.5.0-beta.1 — Release Notes

> ⚠️ **EXPERIMENTAL PRERELEASE.** This build targets the **unreleased OpenCode v2**
> plugin contract at one pinned snapshot. It is not compatible with OpenCode v1, is
> not covered by any stability promise, and may break without notice when OpenCode's
> v2 branch moves. **No OpenCode v2 release date is known or claimed.**
>
> OpenCode v1 users: stay on **`opencode-kiro@0.4.0`** — the `main` branch / npm
> `latest` line remains the supported stable release and is untouched by this
> prerelease.

## Compatibility target

| Item | Value |
|---|---|
| Tested OpenCode commit (`upstream/v2` head) | `b47cfbee7c4fd24e5d73e5753b4755db62a92a63` |
| Package version | `0.5.0-beta.1` |

> Re-pinned 2026-07-29 from `010133f6df21ab273b260327670f19c95e7a167c` (33 commits
> behind): upstream `fe91698ed6` adds host runtime-plugin support (loader shim
> redirecting external-plugin `solid-js`/`@opentui/*` imports to host module
> instances — fixes external-plugin TUI rendering), and `44cd984589` makes TUI slots
> a typed closed set that removes `session.composer.top` (see "What changed").

There is no `engines.opencode` constraint: the v2 host has no stable semver yet, so
the tested SHA above is the compatibility target. Snapshots before or after it may
not work. Installed-tarball verification evidence for the pins below is recorded in
[PINNED_VERSIONS.md](./PINNED_VERSIONS.md).

## Exact pins (v2-sensitive dependencies)

| Package | Pinned version | Where |
|---|---|---|
| `@opencode-ai/plugin` | `0.0.0-next-16420` | devDependencies + peerDependencies (exact) |
| `@opentui/solid` | `0.4.5` | dependencies (exact; peer floor AND max published; bundler-external, never bundled) |
| `solid-js` | `1.9.12` | dependencies (exact; `@opentui/solid@0.4.5` peers this EXACTLY; bundler-external, never bundled) |
| `kiro-acp-ai-provider` | `3.0.0` | dependencies (exact, unchanged from v1) |

`@opencode-ai/plugin@0.0.0-next-16420` is the only published layout matching the v2
contract at the tested SHA. The `latest` / `beta` / `dev` dist-tags carry the stale
v1-era layout and must not be used. Never substitute `next`, `latest`, caret (`^`),
tilde (`~`), or asterisk (`*`) specifiers for any of the packages above.

## What changed from 0.4.0

- **Plugin contract**: both entries moved from v1 wrapper properties to v2
  `{ id, setup(context) }` with aggregated, idempotent cleanup.
- **Auth**: registers Integration `kiro` with the "Kiro CLI Login" OAuth method.
  Success stores a minimal `Credential.OAuth` presence record (`expires: 0`, no
  refresh callback) — kiro-cli owns credential storage and refresh. Deleted v1
  behaviors: synthetic token expiry, `auth.json` sniffing, startup toast checks, and
  all consent-driven host-config file mutation.
- **Models**: discovery runs `listModels()` outside catalog transforms and applies the
  validated capture via transform + reload; exact ID intersection, effort-variant
  merge, and fail-open discipline are preserved from v1. A minimal self-registration
  fallback covers catalogs without a `kiro` entry.
- **Provider ownership**: the AISDK `sdk` hook always sets a plugin-owned
  `kiro-acp-ai-provider` instance (guarding against the host's dynamic provider
  creating an unowned one), with `cwd`, `agent`, `trustAllTools`, `mcpTimeout`, and
  `contextWindows` options.
- **Credits**: read key-unwrapped from `part.state.credits` / `part.state.creditsUnit`
  (v1 read `part.metadata.kiro`). The TUI credits surface is **sidebar-only**: a live
  credits box in the v2 `sidebar.content` slot. v1's right-of-prompt chip has no v2
  equivalent — the tested SHA's typed slot set (`SlotMap`) removed
  `session.composer.top`, so the interim composer strip was descoped and its
  information folded into the sidebar box.
- **Configuration**: server plugin config uses the plural `plugins` array in OpenCode
  config; TUI plugin config uses the `plugins` array in the global `cli.json`.
  `tui.json` is legacy migration input only — the plugin never touches it in v2.

## Known limitations

1. **No slot ordering.** V2 slots have no order parameter; the sidebar credits box
   renders where the host places `sidebar.content` contributions (after built-in
   sections), not at a plugin-chosen position.
2. **Default styling instead of theme tokens.** The pinned snapshot exposes no
   supported theme-token API to plugin views, so the credits box uses
   default/inherited terminal styling and will not match the active theme.
3. **Reduced toast feedback.** Auth feedback is connect-flow text: the login method's
   instructions and, on consent, the manual sidebar setup steps ("add `opencode-kiro`
   to the `plugins` array in your global `cli.json` and restart opencode"). A toast
   API (`ui.toast.show`) is present at the pinned snapshot — verified in the installed
   `@opencode-ai/plugin@0.0.0-next-16420` tarball — but this plugin's core
   deliberately does not depend on it: the TUI context surface is churning and toast
   availability is not guaranteed across snapshots.
4. **Live text-credits workaround is active.** At the tested SHA, the host TUI's
   `session.text.ended` reducer copies the ended text but drops the event's provider
   state (`packages/tui/src/context/data.tsx`, text branch), so credits attached to a
   just-ended text part never reach durable TUI state during a live turn. The plugin
   works around this with a transient per-session store keyed by
   `(sessionID, assistantMessageID, ordinal)`: text-ended credits render immediately,
   and every durable read reconciles the store first so durable state stays
   authoritative and nothing is ever double-counted. The workaround is removed (or
   scoped to a documented compatibility range) once the upstream fix ships.
5. **Prerelease pins are rigid.** `@opentui/solid@0.4.5` is both the peer floor and
   the maximum published version, and it peers `solid-js@1.9.12` exactly; the host
   patches its own solid-js in-workspace, which an external pin cannot replicate —
   host integration testing at the tested SHA is a mandatory pre-publish gate.

## Install / configuration summary

Server (`opencode.json`):

```json
{
  "plugins": [
    { "package": "opencode-kiro@0.5.0-beta.1", "options": {} }
  ]
}
```

TUI (global `cli.json`):

```json
{
  "plugins": ["opencode-kiro"]
}
```

Full instructions: [README.md](./README.md).

## Publishing guidance (maintainers)

- Publish this prerelease **only under an explicit prerelease dist-tag** — never the
  default `latest`:

  ```bash
  npm publish --tag beta
  ```

  (Published 2026-07-29: `opencode-kiro@0.5.0-beta.1` is live under the `beta`
  dist-tag.)

- `latest` must keep pointing at `0.4.0` (the v1 stable line on `main`).
- Before publishing, re-verify the installed `@opencode-ai/plugin` tarball per the
  checklist in [PINNED_VERSIONS.md](./PINNED_VERSIONS.md) (exports map, TUI types),
  and re-run the full validation suite against the pins above.
- Stable promotion (`0.5.0`) requires the stable definition of done in
  `OPENCODE_V2_MIGRATION.md` — a confirmed OpenCode v2 compatibility target,
  mutually published package versions, the upstream text-ended fix, and upgrade
  testing from `0.4.0`. Do not promote merely because the prerelease compiles
  against one beta snapshot.
