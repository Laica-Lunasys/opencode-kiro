# opencode-kiro 0.5.0-beta.3 — Release Notes

> ⚠️ **EXPERIMENTAL PRERELEASE.** This build targets the **unreleased OpenCode v2**
> plugin contract at one pinned snapshot. It is not compatible with OpenCode v1, is
> not covered by any stability promise, and may break without notice when OpenCode's
> v2 branch moves. **No OpenCode v2 release date is known or claimed.**
>
> OpenCode v1 users: stay on **`opencode-kiro@0.4.0`** — the `main` branch / npm
> `latest` line remains the supported stable release and is untouched by this
> prerelease.
>
> This release **supersedes `0.5.0-beta.2`**
> ([RELEASE_NOTES_0.5.0-beta.2.md](./RELEASE_NOTES_0.5.0-beta.2.md)). If you run
> beta.2 on a current v2 host, **upgrade**: beta.2's login/logout model reactivity
> is silently broken there (see the fix below).

## Upgrading from beta.2

**Is your host affected?** Either check is conclusive — no date guessing needed:

- **Event names.** Connect or disconnect any integration and watch the host event
  stream: if it publishes `credential.updated` (empty payload) / `credential.switched`
  instead of `integration.connection.updated`, beta.2's discovery listener is dead on
  that host.
- **Upstream commits.** If your OpenCode checkout contains `eb1ac54d73` /
  `62d9aa9838` — the multi-account credentials change that removed
  `integration.connection.updated` — your host is affected. Those commits landed
  between the two tested SHAs, i.e. after beta.2's
  `1cf61593b5ec204619b3f679fe418fec10ca5934` (2026-08-23) and at/before beta.3's
  `8ba434b5973856b2f32b8cd3543e154b25c413e6` (2026-08-29).

A host at beta.2's own tested SHA `1cf61593b5…` predates the removal and is **NOT**
affected: beta.2 behaves as documented there.

**How to upgrade (two steps):**

1. In your `plugins` array, change the entry `opencode-kiro@0.5.0-beta.2` to
   `opencode-kiro@0.5.0-beta.3`.
2. Restart opencode.

Nothing else changes: no new config keys, no `cli.json`/`tui.json` entry, and no
re-login (credentials are host-owned and carry over).

## THE FIX: credential-event migration (dual-listen)

**Headline.** Upstream **removed the `integration.connection.updated` event** as part
of the new multi-account credentials feature, replacing it with `credential.updated`
(empty payload) and `credential.switched` (`{integrationID, credentialID}`). beta.2
filters its discovery listener on the removed name, so on any host carrying that
removal (upstream `eb1ac54d73`/`62d9aa9838` — see
[Upgrading from beta.2](#upgrading-from-beta2) for the check) its login/logout model
reactivity is **silently dead**: logging in mid-session never populates the Kiro model
list and logging out never clears it (a restart still picks the state up — which is
what made the breakage silent).

beta.3 **dual-listens**: the discovery filter accepts all three event names —
`integration.connection.updated` (older hosts), `credential.updated`, and
`credential.switched` (current hosts) — and keeps re-checking
`connection.active("kiro")` as the single source of truth, so the behavior is
identical whichever scheme the host speaks. On old hosts the new names never fire;
on new hosts the old name never fires — safe both ways.

**Validated on both event schemes.** Host e2e at the pinned SHA confirmed: start
logged out → 0 kiro models; mid-session Kiro CLI Login → 18 models on the SAME
server process, no restart; logout → models cleared, no restart. The SSE capture
showed reactivity driven entirely by `credential.updated` + `credential.switched`,
with `integration.connection.updated` firing **zero** times — the dual-listen path
is the sole working path on current hosts. Evidence:
[HOST_E2E_REPORT.md](./HOST_E2E_REPORT.md) → "Beta.3 e2e at 8ba434b597".

**Multi-account credentials note.** Current hosts can store multiple Kiro
credentials (auto-labeled "Kiro", "Kiro 2", …). Switching between stored
credentials fires a genuine `credential.switched` and was validated in e2e:
discovery re-checks the active connection and the model list stays correct
throughout. No plugin configuration is involved. Note that `credential.updated`
carries no `integrationID`, so while Kiro is connected **any** credential change on
the host — Kiro's or another integration's — re-runs Kiro discovery; this is benign
(the re-check is coalesced and fail-open, and `connection.active("kiro")` decides the
outcome).

## Compatibility target

| Item | Value |
|---|---|
| Tested OpenCode commit (`upstream/v2` head, 2026-08-29) | `8ba434b5973856b2f32b8cd3543e154b25c413e6` |
| Package version | `0.5.0-beta.3` |

There is no `engines.opencode` constraint: the v2 host has no stable semver yet, so
the tested SHA above is the compatibility target. Snapshots before or after it may
not work. Installed-tarball verification evidence for the pins below and the full
host e2e record are in [PINNED_VERSIONS.md](./PINNED_VERSIONS.md) and
[HOST_E2E_REPORT.md](./HOST_E2E_REPORT.md).

## Exact pins (v2-sensitive dependencies)

| Package | Pinned version | Where |
|---|---|---|
| `@opencode-ai/plugin` | `0.0.0-dev-18686` | devDependencies + peerDependencies (exact; the dev channel is the live v2 channel — pinned by exact version STRING, never by dist-tag) |
| `@opentui/solid` | `0.5.9` | dependencies (exact; sole published version satisfying the new `>=0.5.9` peer floor; bundler-external, never bundled) |
| `solid-js` | `1.9.12` | dependencies (exact; `@opentui/solid@0.5.9` peers this EXACTLY; bundler-external, never bundled) |
| `kiro-acp-ai-provider` | `3.0.0` | dependencies (exact, unchanged from v1) |

package.json, [PINNED_VERSIONS.md](./PINNED_VERSIONS.md), and these notes all carry
the full pin table above; [README.md](./README.md) carries the plugin-API pin, the
package version, and the tested SHA, and defers the full table to those documents.
All four are lock-tested for consistency (`test/scaffold.test.ts`). Never
substitute floating dist-tags or caret (`^`), tilde (`~`), or asterisk (`*`)
specifiers for any of the packages above.

> ⚠️ **Pin your install spec too.** The host now background-auto-refreshes UNPINNED
> npm plugin packages; a bare `"opencode-kiro"` `plugins` entry can silently move you
> off the tested build. Always use the exact `opencode-kiro@0.5.0-beta.3` spec.

## What changed from 0.5.0-beta.2

- **Credential-event fix (dual-listen).** THE headline change — see above.
- **Re-pin to the current v2 head.** Tested OpenCode SHA moved
  `1cf61593b5ec204619b3f679fe418fec10ca5934` → `8ba434b5973856b2f32b8cd3543e154b25c413e6`
  (≈1 week of upstream v2 development, including the credential-event rename); the
  plugin API pin moved `0.0.0-dev-17968` → `@opencode-ai/plugin@0.0.0-dev-18686`
  (the CI build of the pinned head), and `@opentui/solid` moved `0.5.7` → `0.5.9`
  per the new `>=0.5.9` peer floor (`solid-js` stays exactly `1.9.12`).
- **Additive host surface absorbed.** The plugin API at this pin adds optional
  surfaces (`vcs`, location/permission/generate context, `Credential.OAuth.expires`
  widened to `Schema.Int`) — all additive; no plugin behavior change. Everything
  else (slot claims, `tui: true` auto-load, forms auth, effort variants, credits
  surfaces) carries over from beta.2 unchanged and was re-validated end-to-end at
  the new SHA.

## Known limitations

Unchanged from beta.2:

1. **Live text credits still use the transient overlay.** At the tested SHA the live
   `session.text.ended` reducer still drops the event's provider state, so in-turn
   credit updates come from the plugin's transient overlay. Durable state (fixed
   upstream since beta.2) is authoritative on every reconcile; nothing is
   double-counted.
2. **Local `file:` installs render a per-slot TUI error.** The colon in a
   `name@file:<tarball>` install dirname defeats the host's OpenTUI loader shim; the
   failure is contained to the plugin's slots. Registry installs are colon-free and
   fully verified — this caveat affects local tarball validation only.
3. **No dollar cost anywhere.** Kiro is subscription-metered; the catalog declares
   per-token `cost` 0, so every non-TUI cost surface shows $0.00 for Kiro sessions.
   Credits render in the TUI surfaces only. Expected, not a defect.
4. **Prerelease pins are rigid.** All v2-sensitive pins are exact and the
   compatibility target is the single tested SHA above; host integration testing at
   that SHA is a mandatory pre-publish gate.

## Install / configuration summary

One entry (`opencode.json`, project or global):

```json
{
  "plugins": ["opencode-kiro@0.5.0-beta.3"]
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
  actually happened in [PINNED_VERSIONS.md](./PINNED_VERSIONS.md) (beta.1 and beta.2
  shipped under the `beta` dist-tag; this release is expected to update the same tag).
- Before publishing, re-verify the installed `@opencode-ai/plugin` tarball per the
  checklist in [PINNED_VERSIONS.md](./PINNED_VERSIONS.md), and re-run the full
  validation suite against the pins above.
- **No GA date claims.** Stable promotion (`0.5.0`) requires the stable definition of
  done in `OPENCODE_V2_MIGRATION.md` — a confirmed OpenCode v2 compatibility target,
  mutually published package versions, the upstream live-path text-ended fix, and
  upgrade testing from `0.4.0`. Do not promote merely because the prerelease compiles
  against one beta snapshot.
