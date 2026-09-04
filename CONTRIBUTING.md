# Contributing to opencode-kiro

Thanks for helping out. This is a small, single-maintainer plugin, so contributions stay lightweight and practical.

## Reporting bugs and requesting features

- Search [existing issues](https://github.com/NachoFLizaur/opencode-kiro/issues) first.
- Open a new issue using the templates:
  - **Bug report** for something broken. Include your opencode, kiro-cli, and opencode-kiro versions plus OS.
  - **Feature request** for an idea or enhancement.
- Blank issues are disabled, please pick a template.

## Dev setup

Requirements: Node.js `>= 20` and npm. A local `kiro-cli` install is needed to exercise the auth flow end to end.

```bash
git clone https://github.com/NachoFLizaur/opencode-kiro
cd opencode-kiro
npm install
```

## Build, test, typecheck

These map directly to the scripts in `package.json`:

```bash
npm run build       # tsup -> dist/server.js + dist/tui.js (+ d.ts)
npm test            # vitest run (single pass)
npm run test:watch  # vitest (watch mode)
npm run typecheck   # tsc --noEmit
```

Run `npm run typecheck` and `npm test` before opening a PR. All tests must pass.

Runtime model discovery changes must treat the SDK's normalized `runtimeEfforts` and optional `baselineEffort` as authoritative, keep the exact, case-sensitive runtime `modelId` to catalog `model.api.id` intersection, preserve matching catalog keys and metadata, and omit unmatched IDs after success. A thrown discovery or duplicate runtime ID must fail open to the original catalog unchanged; add focused coverage to the existing server test file.

## Running the plugin locally against opencode

Build and pack first, then reference the tarball with ONE `plugins` entry in `opencode.json` (the project's `.opencode/opencode.json` or the global `~/.config/opencode/opencode.json`). The server plugin declares `tui: true`, so the TUI half (sidebar credits box and footer chip) auto-loads from that same entry; there is no `cli.json` step. If a `cli.json` `plugins` entry is left over from `0.5.0-beta.1`, remove it:

```bash
npm run build && npm pack
```

```json
{ "plugins": ["opencode-kiro@file:/absolute/path/to/opencode-kiro-0.5.0-beta.5.tgz"] }
```

The `name@file:` form is required at the tested commit; a bare path or bare `file:` spec is rejected. opencode resolves both entrypoints from the package `exports` (`./server` for the server half, `./tui` for the auto-loaded TUI half). If the catalog opencode loads has no `kiro` entry, the plugin self-registers the provider and the runtime-discovered models after `opencode auth login`, so no custom catalog is required for basic testing:

```bash
opencode models | grep '^kiro/'
```

See the README's "Local development (path source)" section for the full details.

## Testing against a local models.dev catalog (`OPENCODE_MODELS_PATH`)

`OPENCODE_MODELS_PATH=<path>/api.json` points opencode at a local models.dev catalog build. It is the highest-precedence catalog source: file > baked catalog > network fetch (see `packages/cli/src/server-process.ts` at the tested OpenCode commit `8ba434b5973856b2f32b8cd3543e154b25c413e6`).

Use it to run the plugin against a models.dev build that contains the `kiro` provider entry. That exercises the enrichment path, where the catalog supplies rich model metadata (context windows, reasoning effort) that the plugin merges with runtime discovery, instead of the self-registration fallback above:

```bash
OPENCODE_MODELS_PATH=/abs/path/to/api.json opencode
```

## Beware of stale plugin caches

opencode does not run your working copy directly. It resolves plugins from its package cache at `~/.cache/opencode/packages/<spec>` (honoring `$XDG_CACHE_HOME`). Unpinned specs (bare or `@latest`) are refreshed in the background by the host, so a cached copy can silently move to a newer publish. Exact-pinned specs are installed once and then frozen - bump the pin, or remove the cache entry, to pick up a rebuild. When iterating locally:

- Prefer a local tarball source (`"plugins": ["opencode-kiro@file:/abs/path/to/opencode-kiro-<version>.tgz"]`, re-packed after each build), or pin an exact version and bump it on each change.
- If a stale build or a stale bundled `kiro-acp-ai-provider` is in use (symptom: `sdk.languageModel is not a function`), remove the cached copies and retry:

  ```bash
  rm -r "${XDG_CACHE_HOME:-$HOME/.cache}/opencode/packages/opencode-kiro"*
  rm -r "${XDG_CACHE_HOME:-$HOME/.cache}/opencode/packages/kiro-acp-ai-provider"*
  ```

- The TUI half (sidebar credits box and footer chip) is loaded from the same cached package via `tui: true`, so it is subject to the same caching; there is no separate `cli.json` entry to clear.

## Verifying in a clean-room sandbox

To exercise auth, runtime model and reasoning-effort discovery, and (with a registry install) the credits display without touching your real opencode config or first-run state, run opencode against an isolated XDG sandbox while keeping your real `HOME` (the `kiro-cli` login and its SSO token live under `~/.aws`, not under XDG, so they keep working):

```bash
SANDBOX="$(mktemp -d)"
export XDG_CONFIG_HOME="$SANDBOX/config"
export XDG_DATA_HOME="$SANDBOX/data"
export XDG_STATE_HOME="$SANDBOX/state"
export XDG_CACHE_HOME="$SANDBOX/cache"
mkdir -p "$XDG_CONFIG_HOME/opencode"

# Set this placeholder to the absolute path of the tarball produced by `npm pack`.
export OPENCODE_KIRO_TGZ="/absolute/path/to/opencode-kiro-0.5.0-beta.5.tgz"

# One plugins entry in opencode.json loads the server half; the TUI half
# (sidebar credits box, footer chip) auto-loads from it via tui: true.
# No cli.json entry is needed.
printf '{"plugins":["opencode-kiro@file:%s"]}\n' "$OPENCODE_KIRO_TGZ" > "$XDG_CONFIG_HOME/opencode/opencode.json"
```

Then build a standalone opencode and run it against the sandbox. Because `HOME` is untouched, `kiro-cli` auth still works; because XDG is sandboxed, opencode starts from a fresh, empty config, so you can verify first-run behavior (no stored credential, auth-gated runtime model discovery). Local `file:` installs render a contained per-slot error notice in place of the TUI credits views (the colon-path caveat described in the README); use a registry install to verify the credits surfaces themselves.

Notes for macOS:

- There is no `timeout`. Wrap long-running probes with `perl -e 'alarm 30; exec @ARGV' -- <command>`.
- Copying the opencode binary invalidates its Bun single-file signature. Re-sign it with `codesign --force --sign - /path/to/opencode` before running.

## Pull requests

- Link an issue. Use `Fixes #123` or `Closes #123` in the description.
- Keep PRs small and focused. One logical change per PR.
- Include tests for new behavior and make sure `npm test` passes.
- Explain what changed and how you verified it (tests run, manual steps).
- Update the README if you change user-facing behavior.

## Commit and PR title style

Use conventional commit style for commit messages and PR titles. A clear title is usually enough, a long body is not required:

```
type: short summary
```

Common types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`.

Examples:

- `fix: handle auth path on Windows`
- `feat: show credits unit in the sidebar box`
- `docs: clarify local development setup`

## Style

- Plain hyphens only. No em-dashes or en-dashes anywhere in code or docs.
- Match the existing code and README tone: terse and practical.

## Releasing

Maintainer notes for the `0.5.0` prerelease line (branch `opencode-v2`).

- **Two release lines, two dist-tags.** `latest` must keep pointing at `0.4.0`, the OpenCode v1 stable line on `main`. Prereleases publish only under the `beta` dist-tag; `package.json` sets `publishConfig.tag` to `beta` so a bare `npm publish` cannot move `latest`. Still pass the tag explicitly:

  ```bash
  npm publish --tag beta
  ```

- **Exact pins only.** `@opencode-ai/plugin` (dev and peer), `@opentui/solid`, `solid-js`, and `kiro-acp-ai-provider` are pinned to exact version strings, never dist-tags or ranges. When re-pinning, verify the installed `@opencode-ai/plugin` tarball matches the tested OpenCode commit (exports map, TUI slot types, event union) and keep `docs/COMPATIBILITY.md`, the current `CHANGELOG.md` section, and the README in step; `test/scaffold.test.ts` fails on any drift between them and `package.json`.
- **Before publishing.** Run `npm run typecheck` and `npm test` (the suite includes a real `npm pack` and a hermetic install), then run the built tarball against the tested OpenCode commit end to end (auth, model discovery, effort on the wire, credits surfaces). Fill the version's `CHANGELOG.md` section and update `docs/COMPATIBILITY.md` before the pack, since README and docs are part of the release tree.
- **After publishing.** Confirm `npm view opencode-kiro dist-tags` shows `beta` on the new version and `latest` still on `0.4.0`, and that the registry `dist.shasum` matches the pre-flight `npm pack` shasum.
- **No GA claims.** Stable promotion (`0.5.0`) requires a confirmed OpenCode v2 compatibility target, mutually published host and plugin package versions, the upstream fix for the live text-ended credits path, and upgrade testing from `0.4.0`. Do not promote because a prerelease compiles against one snapshot, and do not claim an OpenCode v2 release date.
