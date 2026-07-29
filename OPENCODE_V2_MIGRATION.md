# OpenCode v2 migration plan

## Document status and research basis

This document is the implementation handoff for migrating `opencode-kiro` to
OpenCode v2 without disrupting the existing v1 release. It is a plan, not a
claim that the migration has been implemented.

| Item | Value |
|---|---|
| Document status | Implementation-ready migration plan |
| Research date | 2026-07-28 |
| OpenCode v2 snapshot | `1be6d94267a4e16b12e5927bb2357ceb83020c85` (`upstream/v2`, latest fetched at research time) |
| Prior OpenCode v2 snapshot | `fd97d789ef47980f70581b161c50adfe27c55fb4` |
| Stable OpenCode observed | `v1.18.8` |
| OpenCode v2 release status | No confirmed GA or RC date at research time |
| Current `opencode-kiro` release | `0.4.0`, using the v1 plugin contract |
| Sibling SDK | `kiro-acp-ai-provider@3.0.0` |

Statements marked **Verified** describe the repositories and snapshot above.
Statements marked **Recommendation** are implementation or release choices.
Statements marked **Open question** must be rechecked against the exact v2
packages selected for the prerelease. All OpenCode v2 observations are
time-sensitive until v2 is stable.

## Purpose and scope

The goal is to produce an `opencode-v2` branch and prerelease that preserves
Kiro authentication, runtime model discovery, reasoning variants, per-location
working directories, and TUI credit reporting on OpenCode v2.

The migration includes both published entry modules:

- The server entry in `src/server.ts`.
- The TUI entry in `src/tui.ts` and `src/tui/*`.
- Package exports and v2-specific dependency/build configuration.
- Tests and host-level validation against one exact OpenCode v2 snapshot.

It does not include changing the stable `0.4.0` release in place, claiming that
OpenCode v2 has shipped, or replacing the ACP SDK's AI model implementation.

## Decisions already made

1. **Recommendation, accepted:** develop in a separate `opencode-v2` branch.
   Keep the v1-compatible `0.4.0` line stable.
2. **Recommendation, accepted:** publish v2 work only under a prerelease version
   and prerelease dist-tag, with exact dependency versions. Never depend on a
   floating `next` tag.
3. **Verified:** SDK changes are allowed if genuinely needed, but
   `kiro-acp-ai-provider@3.0.0` already supplies a compatible LanguageModelV3 and
   credit metadata. No model adapter or synthetic reasoning workaround is
   currently required.
4. **Recommendation, accepted:** port the TUI even though v2 cannot provide
   exact v1 ordering, theme-token, and toast parity. Ordering and theme losses
   are cosmetic; toast loss reduces immediate user feedback and must be replaced
   by actionable connect-flow errors, instructions, and installation docs.

## Executive summary

**Verified:** A prerelease migration is feasible against the researched v2
snapshot. The sibling SDK already implements AI SDK LanguageModelV3, so no
LanguageModel adapter is needed.

The plugin contracts are not source-compatible. Both entrypoints require a
rewrite from declarative v1 return objects to v2 imperative `setup(context)`
registration. Server auth moves to Integration and Credential domains, provider
configuration moves to AISDK and catalog hooks, and the old `config` hook is
gone. The TUI must move to v2 data and slot APIs.

**Verified API names at the pinned SHA:** the Promise, Effect, and TUI sources
are under `packages/plugin/src/promise/*`, `packages/plugin/src/effect/*`, and
`packages/plugin/src/tui/*`. The server registrations used by this migration are
exactly `context.aisdk.hook("sdk", callback)`,
`context.catalog.transform(callback)`, and
`context.integration.transform(callback)`.

**Verified:** credit transport is now viable end to end. Current v2 persists text and
reasoning content-part state and exposes it in client types. One live-update bug
remains: the TUI text-ended reducer copies text but omits state. A durable reload
restores it. The preferred solution is a small upstream fix, with plugin-owned
live state as the prerelease workaround.

## Release strategy

**Recommendation:**

1. Branch `opencode-v2` from the stable plugin baseline.
2. Leave the v1 package release at `0.4.0` and leave its normal dist-tag
   untouched.
3. Use a semver prerelease such as `0.5.0-beta.1`. This communicates a new
   compatibility target and sorts after `0.4.0`; reusing a version such as
   `0.4.0-beta` would sort before the already released `0.4.0` and obscure the
   contract break.
4. Publish only to an explicit prerelease tag until OpenCode v2 and this plugin
   pass the stable definition of done.
5. Pin the exact v2-compatible `@opencode-ai/plugin`, OpenTUI, Solid, and related
   package versions in the prerelease. Record the OpenCode commit used for host
   integration testing.

Do not infer or advertise an OpenCode v2 release date. No GA or RC date was
confirmed on 2026-07-28.

## Current v1 inventory

### Server entry

`src/server.ts` currently exports `default { id: "kiro", server }` and the named
`KiroAuthPlugin`. The central `server(input)` function returns v1 `Hooks` and
contains several responsibilities that must be separated in v2.

| Current function or hook | Current responsibility | v2 disposition |
|---|---|---|
| `server(input)` | Captures `client`, `directory`, and `worktree`; returns all hooks | Replace with `{ id, setup(context) }` and domain registrations |
| `auth.provider` and `auth.methods` | Registers Kiro and the "Kiro CLI Login" OAuth method | Register Integration `kiro` and its OAuth method |
| `auth.loader` | Supplies `cwd`, agent, tool trust, timeout, and context windows; calls the auth notification helper | Put deterministic options in v2 settings and construct the plugin-owned provider in the AISDK SDK hook |
| `provider.models` | Calls `listModels()`, intersects runtime and catalog IDs, and adds effort variants | Capture discovery asynchronously, then transform and reload the v2 catalog |
| `config` | Adds a crash-guard provider after sniffing stored credentials | Remove; v2 has no corresponding config hook and catalog registration replaces this workaround |
| `readToken()` | Reads token-file cosmetics and creates a synthetic future expiration | Replace with a minimal Credential.OAuth result based on `verifyAuth()` |
| `notifyIfTokenExpired()` | Uses the v1 client toast and console warning | Remove from startup/provider loading; rely on connect-flow errors and explicit auth checks |
| `hasStoredKiroCredential()` / `authJsonPaths()` | Reads OpenCode's private `auth.json` storage | Delete; use Integration/Credential services only |
| `tuiConfigPath()` / `enableSidebarConfig()` | Writes legacy `tui.json` after a login consent prompt | Delete direct writes; v2 TUI configuration belongs in global `cli.json` |

The loader currently couples provider creation to `input.directory ??
input.worktree`, resolved catalog models, the private credential file, TUI toast
availability, and `tui.json`. These are all v1-specific boundaries.

### TUI entry and credit helpers

`src/tui.ts` exports `default { id: "opencode-kiro", tui }`. Its v1 `tui(api)`
callback registers ordered `sidebar_content` and `session_prompt_right` slots.

- `src/tui/credits-box-view.ts` reads `api.state.session.messages()` and
  `api.state.part()`, and uses external theme tokens.
- `src/tui/credits-chip-view.ts` uses the same state accessors and theme.
- `src/tui/credits.ts` deduplicates credits once per assistant message, but
  `readPartCredits()` currently reads `part.metadata.kiro`.

The pure formatting and message-level dedupe rules remain useful. State access,
metadata extraction, component registration, and styling must be ported.

### Package surface

`package.json` publishes `./server` and `./tui`. **Verified:** v2 server loading
tries `./server` and then the package root, while v2 TUI loading resolves
`./tui`. The export names can remain. The JavaScript values behind those exports
must implement the v2 contracts.

## V1 to v2 architecture mapping

| v1 contract | v2 contract | Migration action |
|---|---|---|
| Server `{ id, server }` returning `Hooks` | `{ id, setup(context) }` | Imperatively register callbacks with the relevant domains during setup |
| `auth.provider` and `auth.methods` | Integration and Credential | Upsert Integration `kiro`; register its OAuth method and return Credential.OAuth |
| `auth.loader` | `context.aisdk.hook("sdk", callback)` | Construct and own the Kiro provider, assign `event.sdk`, and retain it for shutdown; no language hook adapter is expected |
| `provider.models` | `context.catalog.transform(callback)` plus `context.catalog.reload()` | Capture runtime discovery outside the synchronous transform and apply provider/model updates in the transform |
| `config` | No replacement hook | Remove the private config crash guard |
| `input.client`, `input.directory`, `input.worktree` | Removed from plugin setup | Use public domains; capture cwd from a location-bearing domain response at the point of use |
| TUI `{ id, tui }` | TUI `{ id, setup(context) }` | Read `context.data`, register v2 slots, and retain disposers |
| `api.state.session.messages/part` | `context.data.session.message.list/sync` | Consume inlined message content and content-part state |
| `sidebar_content` | `sidebar.content` | Render the credits box after built-in sidebar content |
| `session_prompt_right` | `session.composer.top` | Move the credit chip above the composer |

## Server migration design

### Integration and authentication

**Verified target contract:** use
`context.integration.transform(callback)` to register an Integration with ID
`kiro`, display name `Kiro`, and an OAuth method. The current select prompt can
remain:

- Message: `Enable the Kiro credits sidebar?`
- Choices: Yes and No.

**Recommendation:** retain the prompt temporarily as an onboarding decision,
but change its effect. It must not write `tui.json`. The result may explain how
to add the TUI plugin to global `cli.json`, or the prompt may be removed if the
installer can configure both v2 plugin lists. Decide this before finalizing the
auth copy.

Authorization should preserve these behaviors:

1. Dynamically import `verifyAuth()`.
2. If `kiro-cli` is absent, fail with the current installation guidance.
3. If already authenticated, return an automatic attempt immediately.
4. Otherwise spawn `kiro-cli login`, return `mode: "auto"`, and poll
   `verifyAuth()` in the callback for up to 120 seconds.
5. Kill the spawned process on success, timeout, cancellation, or plugin
   disposal. Preserve Windows command resolution behavior.
6. On timeout, fail with guidance to run `kiro-cli login` manually.

**Verified:** an OAuth authorization result requires `url`, `instructions`,
`mode`, and callback. A Credential.OAuth requires:

- `type: "oauth"`
- `methodID`
- `refresh`
- `access`
- `expires`
- Optional `metadata`

**Recommendation:** return `expires: 0`, an empty `refresh`, and a stable
non-secret presence value for `access` after `verifyAuth()` succeeds. Do not
implement the optional Integration refresh callback. `kiro-cli` owns credential
storage and refresh; OpenCode does not need copied AWS token data.

Delete the synthetic eight-hour expiry, token-file parsing, `auth.json`
inspection, and startup expiration toast. Authentication authority remains
`verifyAuth()`, which delegates to `kiro-cli`.

> **Open question:** The v2 OAuth attempt schema requires a URL even though
> `kiro-cli login` opens the browser itself. Confirm whether an empty string is
> accepted by the exact v2 server/TUI packages. If not, use a truthful Kiro
> documentation URL or request explicit support for CLI-driven OAuth. Do not
> invent a callback URL.

### Catalog registration and runtime models

**Verified:** inside `context.catalog.transform(callback)`, v2 catalog
`provider.update()` and `model.update()` have upsert semantics. Missing records
are initialized before the callback runs. Register:

- Provider ID `kiro`.
- `integrationID: "kiro"`.
- Name `Kiro`.
- `Provider.Info.package` as `aisdk:kiro-acp-ai-provider`.
- Provider/model settings needed by the SDK factory.

There are two viable sources for the initial catalog:

1. **models.dev first:** keep Kiro in models.dev and transform that provider.
   This preserves centrally maintained names, capabilities, context windows,
   status, and other metadata.
2. **Self-registration:** upsert the provider and discovered models from the
   plugin so a lagging models.dev snapshot cannot hide Kiro.

**Recommendation:** prefer models.dev when a verified Kiro entry exists, but
make the prerelease self-register a minimal provider/model fallback if v2's
bundled catalog does not yet include it. Preserve rich catalog fields whenever
present. Track the models.dev entry on the watchlist and remove redundant
fallback data only after the entry is reliable.

**Verified:** catalog transforms are synchronous mutation phases. Runtime
`listModels()` is asynchronous and must not run inside a transform callback.
The Promise plugin exposes the public event stream as
`context.event.subscribe()`; external plugins must not use core's private
`Bus`/`Event` services.

**Recommendation, required discovery lifecycle:**

1. Register the Integration, catalog transform, AISDK hook, and event consumer.
   The catalog transform reads only a captured, last-known-good discovery
   snapshot.
2. During setup, obtain the current location from a public location-bearing
   response such as `(await context.integration.list()).location`; use its
   `directory` as `cwd`. Then inspect
   `await context.integration.connection.active("kiro")`.
3. If Kiro is connected, start one coalesced `listModels({ cwd })` operation for
   that location. Validate unique, case-sensitive runtime `modelId` values,
   atomically replace the snapshot, and call `context.catalog.reload()` only
   after successful validation. On failure, retain the previous snapshot or
   fail open to untouched catalog data; never expose a partial result.
4. Consume `context.event.subscribe()` and filter for
   `integration.connection.updated` where `event.data.integrationID === "kiro"`.
   Re-check `connection.active("kiro")` rather than inferring login/logout from
   the event alone. On login, rediscover and reload. On logout, clear the
   captured Kiro runtime snapshot and reload so stale runtime-only models are no
   longer advertised.
5. Coalesce concurrent setup/event discoveries and catalog reloads. Guard each
   async completion with a generation token so a discovery started before
   logout cannot republish stale data afterward.
6. On cleanup, stop the event iterator (call/await its `return()` when present),
   invalidate pending generations, and dispose any timers or fallback polling.
   `listModels()` has no documented cancellation input at this snapshot, so an
   already-running call may finish; its stale result must be ignored.

Preserve the current exact, case-sensitive intersection behavior when a rich
models.dev catalog exists. If self-registering a fallback, only publish models
actually returned by the runtime.

#### Model field mapping

| v1/catalog field | v2 field | Rule |
|---|---|---|
| Provider package | `Provider.Info.package` | Set `aisdk:kiro-acp-ai-provider`; a model may inherit this provider package |
| Catalog key | `Model.Info.id` | Keep the stable catalog identity used by the catalog draft |
| v1 `model.api.id` | `Model.Info.modelID` | Map v1 `api.id` here and match it exactly against runtime `modelId` |
| v1 `model.options` | `Model.Info.settings` (`model.settings`) | Copy supported defaults, including baseline reasoning effort |
| v1 variants object | `Model.Info.variants[]` | Create array entries with `{ id, settings }` |
| Variant `reasoningEffort` | `variant.settings.reasoningEffort` | Keep the runtime effort string unchanged |
| `limit.context` | SDK `contextWindows[model.modelID]` | Relay positive context windows by API model ID, not catalog ID |

**Verified:** v2 has no `model.api.id` or `model.api` structure. The SDK and
default language fallback resolve `Model.Info.modelID`. When a variant is
selected, core overlays `variant.settings` onto `model.settings`; the resulting
`reasoningEffort` reaches the request as
`providerOptions.kiro.reasoningEffort`. The SDK already reads that per-call
override. Test the whole path rather than only the catalog shape.

### AISDK provider resolution

**Verified:** `Provider.Info.package` carries
`aisdk:kiro-acp-ai-provider`. Core normalizes that value to the package name for
the SDK event. The built-in `DynamicProviderPlugin` handles an unresolved SDK
event by:

1. Returning immediately if an earlier hook already supplied `event.sdk`.
2. Installing or resolving `event.package`.
3. Importing the package.
4. Selecting the first runtime export whose name starts with `create`.
5. Calling that factory with `event.options` and assigning `event.sdk`.

At this SHA, internal provider plugins, including `DynamicProviderPlugin`, are
registered before configured package plugins. Dynamic loading may therefore
install/import the package and create an SDK before the Kiro hook runs.

The returned Kiro provider is callable and also has `.languageModel(modelID)`.
After SDK resolution, v2's default language fallback calls
`sdk.languageModel(modelID)`. No `.chat` or `.responses` method is needed.

**Recommendation, required ownership design for Kiro:** place all deterministic
Kiro factory inputs in the provider/model settings that become `event.options`,
including:

- `cwd`
- `agent: "opencode"`
- `trustAllTools: true`
- `mcpTimeout: 45`
- `contextWindows`

Register `context.aisdk.hook("sdk", callback)`. For Kiro models, call
`createKiroAcp(event.options)` in that callback and always assign the returned
provider to `event.sdk`, even if an earlier hook populated it. Track every
provider instance created by this plugin, optionally caching by the current
location plus a stable settings/options key, and call each instance's
`shutdown()` from setup cleanup. This makes Kiro's options and ownership
deterministic and avoids relying on dynamic export-name selection. Do not add a
LanguageModel wrapper.

**Caveat:** because the built-in dynamic hook currently runs first, it may have
already created a provider that Kiro then overwrites. That earlier instance is
not plugin-owned and cannot be shut down through this plugin's public API. No
public ownership handoff for it is visible at this SHA, so treat duplicate ACP
process creation as a release risk and recheck hook ordering before release.
Also avoid unsafe JSON-only cache keys when `event.options` contains function or
object identities (for example `fetch`); if identity cannot be represented
safely, create and track a distinct owned instance rather than incorrectly
reusing one.

### Location and lifecycle

The v1 `directory` and `worktree` setup fields no longer exist. **Verified:** v2
domain responses such as `context.integration.list()` include
`location.directory`. Capture that cwd for this location-scoped setup and
associate discovery and owned SDK instances with it. Do not capture
`process.cwd()` once at module load and reuse it for every workspace.

**Recommendation:** keep per-location state containing:

- Cwd.
- Last known-good runtime model snapshot.
- In-flight discovery promise or cancellation handle.
- SDK/provider instances requiring shutdown.
- Transform/hook registrations, event iterator/task, and polling/timer handles.

**Recommendation, required server cleanup contract:** setup must return one
aggregated, idempotent cleanup function. On its first call it marks the instance
disposed, then attempts every cleanup even if one fails: dispose each
registration via `registration.dispose()`, stop and await event subscription
work, cancel login/discovery polling and timers, kill any login child process,
and call `shutdown()` once on every plugin-owned Kiro provider. Later calls are
no-ops (or await the same cleanup promise). Registration disposers are resources
collected by setup; they are not a substitute for the final returned cleanup.
Report combined failures after all resources have been attempted. Never call
catalog reload from inside its transform.

## SDK compatibility assessment

**Verified against `kiro-acp-ai-provider@3.0.0`:**

- `KiroACPLanguageModel` implements `LanguageModelV3` and reports
  `specificationVersion: "v3"`.
- The package peers on `@ai-sdk/provider >=3.0.0`.
- `createKiroAcp()` returns a callable factory with `.languageModel()`,
  `.shutdown()`, and other Kiro helpers.
- It does not expose `.chat` or `.responses`, and v2's default
  `.languageModel(modelID)` fallback is sufficient.
- Root exports include `verifyAuth`, `listModels`, `getQuota`, `createKiroAcp`,
  and the model/provider types needed by this migration.
- Per-call `providerOptions.kiro.reasoningEffort` overrides configured effort.
- Credit metadata is already emitted on completed text and reasoning parts.

**Verified conclusion:** no AI model adapter is required. Do not fork or wrap the SDK to
bridge LanguageModel versions. SDK changes remain in scope only if integration
testing discovers a concrete v2 incompatibility not represented here.

## Credits metadata pipeline

### Verified current-latest behavior

The SDK emits the same turn total on completed carriers:

```ts
{ kiro: { credits, creditsUnit } }
```

It is emitted as `providerMetadata` on `text-end` and, when reasoning occurred,
`reasoning-end`. Consumers must count at most one carrier per assistant message
because both carriers contain the same turn total.

At the researched v2 snapshot, core selects
`metadata[providerMetadataKey]` before storing content-part state. The resulting
stored shape is key-unwrapped:

```ts
part.state.credits
part.state.creditsUnit
```

It is **not** `part.state.kiro`. Current v2 persists text and reasoning state
durably, and generated client types expose the state field.

The remaining defect is specifically in the live TUI reducer. For
`session.text.ended`, `packages/tui/src/context/data.tsx` copies the completed
text but omits `event.data.state`. The reasoning-ended branch does copy state.
Consequences:

- Reasoning-carried credits can appear live.
- A text-only response can lack credits in live TUI state.
- A durable sync/reload restores the text part and its state.
- The transport and persistence path is intact; this is a live reducer bug.

### Required plugin port

Port `readPartCredits()` from `part.metadata.kiro` to content-part `state`:

1. Narrow the content part to text or reasoning.
2. Read finite numeric `part.state.credits`.
3. Read a non-empty string `part.state.creditsUnit` when present.
4. Keep last-carrier-wins dedupe within each assistant message.
5. Sum one value per assistant message across the session.

Do not read `part.state.kiro`, and do not sum text and reasoning carriers.

### Upstream fix and prerelease workaround

**Recommendation, preferred:** submit a one-line or few-line upstream change in
`packages/tui/src/context/data.tsx` so the `session.text.ended` reducer copies
`event.data.state` onto the matching text content part, mirroring reasoning.
Add a focused reducer test if the upstream package has a suitable harness.

**Recommendation, prerelease workaround:** until the fix is available in the
pinned v2 package, subscribe with
`context.data.on("session.text.ended", callback)` and retain the event's credit
state under `(sessionID, assistantMessageID, ordinal)`, or aggregate transient
state by `(sessionID, assistantMessageID)`. Text and reasoning content parts do
**not** have IDs at this SHA, so no workaround may key them by a content-part ID.

Merge transient values with durable
`context.data.session.message.list(sessionID)` data using the existing
one-carrier-per-assistant-message rule. Durable `part.state` is authoritative:
after normal data sync/reload, or after an explicit
`context.data.session.message.sync(sessionID)`, detect the durable credit carrier
for that assistant message, use it, and delete all matching transient tuples.
Also delete transient entries for messages/sessions no longer present. This
reconciliation must keep the displayed total unchanged and must never count the
transient and durable copies together.

Forcing `message.sync()` or a full reload after each text end is a fallback only.
It is less desirable because it adds latency, network/storage work, and possible
UI churn. Do not restore the SDK's former synthetic-reasoning workaround; v2 now
persists text state, so that workaround is neither required nor recommended.

## TUI migration

**Verified target:** `@opencode-ai/plugin/tui` modules export
`{ id, setup(context) }`. Implement setup by registering the sidebar and
composer surfaces, subscribing to any needed live events, and retaining all
disposers.

### Data access

- Use `context.data.session.message.list` to read the session's messages.
- Use `context.data.session.message.sync` when an explicit durable refresh is
  required.
- Message content is inlined; do not call the v1 `api.state.part(messageID)`.
- Read credits from text/reasoning content-part `state` as described above.

### Slots and styling

| v1 behavior | v2 behavior | User-visible result |
|---|---|---|
| Ordered `sidebar_content` at 150 | `sidebar.content` with no external ordering API | Sidebar credits remain functional, but external content renders after built-ins |
| `session_prompt_right` credit chip | `session.composer.top` | Credit chip moves above the composer |
| `api.theme.current` tokens | No supported external theme-token API | Inherit terminal/default styling rather than matching host tokens exactly |
| `client.tui.showToast()` | No supported external toast method | Immediate feedback is reduced; connect-flow errors/instructions and docs must carry actionable guidance |

Ordering and theme differences are cosmetic. Toast loss is a feedback
limitation, not merely cosmetic. The sidebar still reports session credits and
the composer indicator remains visible; validate the replacement connect-flow
copy before accepting the toast limitation.

### TUI cleanup contract

**Recommendation, required:** TUI setup must also return one aggregated,
idempotent cleanup function. Retain the unregister functions returned by both
`context.ui.slot(...)` calls and by every `context.data.on(...)` or
`context.data.listen(...)` subscription. On cleanup, unregister slots, remove
all data listeners, stop any timers/tasks, and clear transient credit state.
Attempt every disposer even if one fails, and make repeated cleanup calls safe.
The individual slot/listener disposers are registration resources; the returned
setup cleanup owns and aggregates them.

### Build compatibility

The current views use Solid and `@opentui/solid` universal-renderer calls.
**Verified:** the observed v2 plugin package peers on OpenTUI `>=0.4.5`.

**Recommendation:** pin a mutually compatible Solid/OpenTUI set and verify both
type generation and runtime loading under the actual TUI host. Avoid bundling a
second incompatible Solid runtime. Preserve lazy loading where it prevents
Bun-native OpenTUI modules from being imported by the server or plain Node test
process.

## Plugin loading, configuration, and packaging

### Entry resolution

**Verified:**

- Server loading resolves package `./server`, then falls back to the package
  root.
- TUI loading resolves `./tui`.
- Existing export subpath names can stay.
- Both modules must change from v1 wrapper properties to v2 `{ id, setup }`.

Keep server and TUI implementations isolated so loading one entry does not pull
the other's host-only dependencies.

### Configuration files

**Verified:** OpenCode v2 uses plural `plugins`:

- Server plugins belong in `plugins` in OpenCode configuration.
- TUI plugins belong in `plugins` in global `cli.json`.
- `tui.json` is legacy migration input, not the v2 write target.

Delete all direct `tui.json` writing. Do not inspect or mutate OpenCode private
configuration from the auth callback.

The v2 server config accepts either a package string or an object:

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

The object form allows future plugin options without a separate config hook.
If the pinned snapshot supports disable directives, document their exact syntax
after testing; they are not required for this migration and must not be guessed.

### Installation and onboarding implications

The v1 login flow can opt in and write `tui.json`. V2 separates server config
from global TUI `cli.json`, so authentication cannot silently preserve that
behavior.

**Recommendation:** update the installer/onboarding flow to configure both
locations explicitly, with user consent. If the host installer only installs
the server entry, show concise manual `cli.json` instructions. Treat legacy
`tui.json` as migration input only: read it through a host-supported migration,
not plugin-owned file writes. Test upgrades from a configured v1 installation.

## Dependencies and prerelease controls

**Verified, time-sensitive observations:**

- Public package dist-tags may be unsynchronized across OpenCode packages.
- At the pinned source, `@opencode-ai/plugin` exports Promise API from `.`,
  Effect API from `/effect`, and TUI API from `/tui`; source lives under
  `src/promise`, `src/effect`, and `src/tui`, not `src/v2/*`.
- Published package contents can still differ from a source checkout or an
  unsynchronized dist-tag, so installed exports must be verified.
- The observed OpenTUI compatibility floor is `>=0.4.5`.

**Recommendation:** at implementation time, resolve and record one exact set of
package versions that corresponds to OpenCode commit
`1be6d94267a4e16b12e5927bb2357ceb83020c85`, or to a deliberately newer reviewed
snapshot. Pin every version. Do not publish with `next`, `latest`, caret, or
asterisk ranges for v2-specific host dependencies.

Before each prerelease:

1. Inspect installed package exports, not only source-tree paths.
2. Verify root Promise, `/effect`, and `/tui` import paths and TUI types; reject
   stale `/v2/promise` or `/v2/effect` assumptions.
3. Verify OpenTUI peer versions and the host's bundled versions.
4. Run clean-cache package resolution for both `./server` and `./tui`.
5. Record exact package versions and the tested OpenCode SHA in release notes.

## Phased implementation checklist

### Phase 1: branch and baseline

- [ ] Create `opencode-v2` from the intended stable plugin commit.
- [ ] Confirm `main` remains the v1-compatible `0.4.0` line.
- [ ] Record the exact OpenCode v2 SHA and package versions in the branch.
- [ ] Capture the current v1 test baseline before changing contracts.

### Phase 2: dependencies and build

- [ ] Pin exact v2 plugin, SDK type, Solid, and OpenTUI versions.
- [ ] Update TypeScript imports to the selected root Promise or `/effect` API.
- [ ] Keep `./server` and `./tui` as separate outputs.
- [ ] Verify no TUI-native module is eagerly loaded from the server output.

### Phase 3: server auth

- [ ] Replace `{ id, server }` with `{ id, setup }`.
- [ ] Upsert Integration `kiro` with display name `Kiro`.
- [ ] Register "Kiro CLI Login" and the existing select prompt decision.
- [ ] Implement installed, already-authenticated, login, timeout, and cleanup paths.
- [ ] Return Credential.OAuth with `expires: 0`; do not implement refresh.
- [ ] Remove token-file parsing, synthetic expiration, `auth.json` sniffing, and startup toast logic.
- [ ] Resolve the required OAuth URL behavior.

### Phase 4: catalog, models, and AISDK

- [ ] Register or enrich the Kiro catalog provider.
- [ ] Decide models.dev-first behavior and minimal self-registration fallback.
- [ ] Run `listModels()` outside transforms and reload after validated capture.
- [ ] Inspect active Kiro connection on setup and react to public
      `integration.connection.updated` login/logout events.
- [ ] Preserve exact model matching, duplicate detection, and failure fallback.
- [ ] Convert effort variants to the v2 variants array and settings shape.
- [ ] Relay context windows and per-location cwd to `createKiroAcp()`.
- [ ] Set `event.sdk` from plugin-owned `createKiroAcp(event.options)` and verify
      default `.languageModel(modelID)` resolution.
- [ ] Dispose all owned SDK instances and coalesce discovery/catalog reloads.

### Phase 5: credits and TUI

- [ ] Port credit extraction to unwrapped content-part state.
- [ ] Retain per-assistant-message dedupe for dual carriers.
- [ ] Implement `sidebar.content` and `session.composer.top`.
- [ ] Use `context.data.session.message.list/sync` and inlined content.
- [ ] Implement plugin-owned live text-ended state until the upstream fix lands.
- [ ] Verify inherited/default styling and replacement connect-flow feedback.
- [ ] Return aggregated idempotent TUI cleanup for slots, listeners, tasks, and
      transient state.
- [ ] Submit or track the upstream text-ended reducer fix.

### Phase 6: packaging and config migration

- [ ] Preserve `./server` and `./tui` exports with v2 module values.
- [ ] Update installation documentation from singular `plugin` to plural `plugins`.
- [ ] Document server config and global `cli.json` separately.
- [ ] Remove all plugin-owned `tui.json` writes.
- [ ] Test migration from legacy `tui.json` input.

### Phase 7: tests and release validation

- [ ] Add unit tests for transforms, credentials, credits, login/logout refresh,
      transient reconciliation, and idempotent server/TUI disposal.
- [ ] Run build, typecheck, lint, and tests using the pinned dependency set.
- [ ] Run clean-room host integration tests against the exact OpenCode v2 SHA.
- [ ] Publish only a prerelease such as `0.5.0-beta.1` to a prerelease tag.
- [ ] Keep stable promotion blocked until the stable definition of done is met.

## Test matrix

| Area | Scenario | Expected result |
|---|---|---|
| Auth | `kiro-cli` absent | Connect flow fails with installation URL; no credential is stored |
| Auth | Installed but unauthenticated | `kiro-cli login` starts and callback polls without blocking setup |
| Auth | Login completes | Poll observes `verifyAuth().authenticated`, child stops, Credential.OAuth is stored |
| Auth | Login timeout | Child stops and actionable manual-login guidance is shown |
| Auth | Already authenticated | No login process starts; automatic callback succeeds immediately |
| Auth | Plugin/connect cancellation | Polling and child process are cleaned up |
| Models | Successful discovery | Exact case-sensitive runtime/catalog intersection is available |
| Models | Runtime duplicate ID | No partial update; original or last known-good catalog remains |
| Models | Discovery exception | Plugin fails open without hiding valid catalog data |
| Models | Active Kiro connection at setup | One coalesced discovery runs with the location cwd and reloads the catalog |
| Models | Kiro login event | Public connection-updated event triggers active-state check, discovery, and catalog refresh |
| Models | Kiro logout event | Captured runtime models reset and catalog reload removes stale runtime-only models |
| Models | Discovery completes after logout | Generation guard discards stale result and does not republish models |
| Models | Catalog lacks Kiro | Minimal self-registration fallback works if that strategy is enabled |
| Models | Catalog contains rich Kiro data | Names, limits, capabilities, status, and unrelated metadata survive |
| Variants | Empty runtime efforts | Model has no invented variants and preserves valid catalog defaults |
| Variants | Runtime efforts and baseline | Variants array and base settings use exact runtime values |
| Request | User selects effort | `settings.reasoningEffort` arrives as `providerOptions.kiro.reasoningEffort` |
| Location | Two locations with different cwd | Discovery and ACP requests use the correct cwd per location |
| AISDK | SDK hook ownership | Kiro hook sets a plugin-owned `createKiroAcp(event.options)` provider and `.languageModel(modelID)` resolves |
| AISDK | Hook ordering | Any earlier dynamic creation is detected in host tests; Kiro's final SDK and options remain deterministic |
| Credits | Text-only response, live | Credits appear once without waiting for reload, using workaround or upstream fix |
| Credits | Text-only response, reload | Durable state restores the same total and unit |
| Credits | Transient-to-durable reconciliation | Durable sync replaces and clears matching `(sessionID, assistantMessageID, ordinal)` transient state without changing or doubling the total |
| Credits | Reasoning response, live | Credits appear once even though text and reasoning both carry metadata |
| Credits | Reasoning response, reload | Total remains deduplicated and equals live total |
| Credits | Multiple assistant messages | Session total is the sum of one credit value per assistant message |
| TUI | Kiro session | Sidebar and composer-top indicator render value and reported unit |
| TUI | Non-Kiro/no metadata session | Credit surfaces collapse or remain absent |
| Packaging | Server resolution | Host loads `./server`; root fallback is also understood |
| Packaging | TUI resolution | Host loads `./tui` without loading server-only behavior |
| Config | Fresh install | Server `plugins` and global `cli.json` TUI `plugins` are documented/configured |
| Config | Legacy install | `tui.json` is treated only as migration input and is not rewritten by auth |
| Lifecycle | Server disposal | Hooks/transforms unregister, event iteration and polling stop, and every plugin-owned SDK shuts down |
| Lifecycle | TUI disposal | Slots and data listeners unregister and transient state/timers are cleared |
| Lifecycle | Repeated cleanup | Calling either cleanup twice is safe and each underlying resource is disposed at most once |

### Automated and host checks

Run at minimum:

```text
npm run typecheck
npm run build
npm test
```

Also run any configured linter. Then execute host integration tests against the
recorded OpenCode SHA and exact package versions, including clean package-cache
resolution. Unit tests alone cannot validate plugin entry loading, TUI slots,
location scoping, or dist-tag synchronization.

## Acceptance criteria

- [ ] V1 `0.4.0` remains available and unchanged on its stable release line.
- [ ] V2 work is isolated on `opencode-v2` and published only as a prerelease.
- [ ] Every v2-sensitive dependency is pinned exactly.
- [ ] Both exported modules use `{ id, setup }` and resolve in the v2 host.
- [ ] Authentication handles all five primary states: absent CLI,
  unauthenticated, timeout, success, and already authenticated.
- [ ] No private `auth.json` sniffing, token copying, synthetic expiration,
  direct `tui.json` writing, or unsupported toast remains.
- [ ] Runtime discovery is asynchronous outside catalog transforms and reloads
  only after a validated snapshot; setup, login, and logout triggers are covered.
- [ ] Catalog failure and duplicate handling cannot publish partial models.
- [ ] Selected reasoning effort reaches the SDK provider options exactly.
- [ ] Cwd is correct for each location.
- [ ] Text-only and reasoning credits work live and after durable reload without
  double counting.
- [ ] Server and TUI cleanup are aggregated, idempotent, and tested, including
  event subscriptions, polling, slots/listeners, and plugin-owned SDK shutdown.
- [ ] Sidebar and composer credit surfaces remain functional with documented
  visual differences and documented toast-feedback limitation.
- [ ] Build, typecheck, tests, and exact-SHA host integration checks pass.

## Risk register and watchlist

| Risk | Impact | Mitigation / watch item |
|---|---|---|
| Beta API churn or renamed domains | Compile or runtime break between snapshots | Pin exact packages and SHA; re-audit imports before every prerelease |
| TUI slot API changes | Credits fail to render or move again | Test `sidebar.content` and `session.composer.top` in the real host |
| No external theme API | Visual mismatch | Inherit terminal/default styling; treat as cosmetic |
| No external toast API | Reduced auth/configuration feedback | Put actionable failures and instructions in the connect flow and onboarding docs; test the copy |
| Live text state reducer bug | Text-only credits absent until reload | Upstream state-copy fix; plugin-owned live state meanwhile |
| Upstream fix not included in pinned package | Workaround remains necessary | Track exact package containing the fix before removing workaround |
| Plugin config or loader changes | Package installs but one entry is not active | Clean-room tests for `./server`, root fallback, `./tui`, and both config files |
| Provider metadata schema changes | Credit extraction silently breaks | Contract tests from SDK event through durable client content-part state |
| models.dev Kiro entry missing or stale | Provider/models hidden or incomplete | Verify entry at build time; retain minimal self-registration fallback |
| Dynamic hook runs before Kiro hook | Duplicate provider/ACP process and an earlier instance the plugin cannot own | Kiro always sets its owned SDK; test process count and re-audit ordering/public lifecycle options |
| Public dist-tags out of sync | Types and runtime disagree | Never use floating tags; inspect exports in installed tarballs |
| Solid/OpenTUI version mismatch | TUI type, bundle, or runtime failure | Pin a compatible set and test under the host's OpenTUI `>=0.4.5` environment |
| Catalog reload loop or race | High CPU, stale models, or repeated process work | Keep discovery outside transforms, atomically capture results, coalesce reloads |
| Per-location state leakage | Wrong cwd or orphaned `kiro-cli` process | Key state by location and verify disposal with two-location tests |

## Definition of done

### Prerelease definition of done

The prerelease is ready only when every acceptance criterion and applicable test
matrix row passes against the pinned dependency set and OpenCode SHA. Release
notes must call it experimental, document visual and feedback limitations, and
must not claim an OpenCode v2 release date.

### Stable release definition of done

Stable promotion requires all prerelease criteria plus:

- OpenCode v2 has a confirmed stable compatibility target.
- Plugin, TUI, SDK, and OpenTUI package versions are mutually published and no
  longer depend on an uncoordinated prerelease layout.
- The live text-state bug is fixed upstream in the supported host version; the
  plugin workaround is removed or retained only for a documented compatibility
  range.
- The Kiro models.dev strategy is settled and reliable for supported hosts.
- Installation supports both server and global TUI configuration without
  private file mutation.
- Upgrade testing from v1 `0.4.0` succeeds with documented rollback steps.
- At least one release-candidate soak validates auth renewal, long sessions,
  multiple locations, model reloads, and credit totals.

Do not promote merely because the prerelease compiles against one beta snapshot.

## Unresolved questions

1. What non-empty URL, if any, must v2 receive for a CLI-driven OAuth attempt
   where `kiro-cli login` opens the browser itself?
2. Which exact published `@opencode-ai/plugin` and TUI package versions map to
   researched SHA `1be6d94267a4e16b12e5927bb2357ceb83020c85`?
3. Will the pinned OpenCode v2 catalog contain a complete Kiro models.dev entry,
   or must the prerelease self-register a fallback provider and models?
4. Will the upstream text-ended state fix be accepted and included in the
   supported package before this plugin's prerelease or stable promotion?
5. Can the v2 installer configure both server `plugins` and global `cli.json`
   TUI `plugins`, or must onboarding provide a manual second step?
6. Does the chosen snapshot support plugin disable directives, and what is their
   tested syntax? This is optional and must not block migration.
7. Can OpenCode expose ordering or ownership control that prevents the built-in
   dynamic hook from creating an unowned Kiro provider before the package hook?

## Primary source references

OpenCode references below were researched against fetched `upstream/v2` at
`1be6d94267a4e16b12e5927bb2357ceb83020c85` unless noted. Paths are used instead
of volatile line numbers.

### OpenCode

- `packages/plugin/src/promise/plugin.ts`, `packages/plugin/src/promise/index.ts`,
  and `packages/plugin/src/promise/registration.ts` - Promise `{ id, setup }`
  context and registration disposal contracts.
- `packages/plugin/src/promise/aisdk.ts`,
  `packages/plugin/src/promise/catalog.ts`,
  `packages/plugin/src/promise/integration.ts`, and
  `packages/plugin/src/promise/event.ts` - exact Promise hooks, transforms,
  connection access, reloads, and public event stream.
- `packages/plugin/src/effect/plugin.ts`,
  `packages/plugin/src/effect/aisdk.ts`,
  `packages/plugin/src/effect/catalog.ts`,
  `packages/plugin/src/effect/integration.ts`, and
  `packages/plugin/src/effect/event.ts` - corresponding Effect contracts.
- `packages/plugin/src/tui/plugin.ts`, `packages/plugin/src/tui/context.ts`, and
  `packages/plugin/src/tui/index.ts` - TUI setup, data, slot, and cleanup types.
- `packages/schema/src/credential.ts` - Credential.OAuth fields.
- `packages/schema/src/integration.ts` and
  `packages/schema/src/event-manifest.ts` - Integration schemas and the public
  `integration.connection.updated` event.
- `packages/schema/src/provider.ts` and `packages/schema/src/model.ts` -
  `Provider.Info.package`, `Model.Info.modelID`, settings, and variants.
- `packages/schema/src/session-message.ts` and
  `packages/schema/src/session-event.ts` - ID-less text/reasoning content,
  provider state, ordinals, and ended events.
- `packages/core/src/aisdk.ts` - SDK resolution, option preparation, and default
  `.languageModel(modelID)` behavior.
- `packages/core/src/plugin/provider/dynamic.ts` - DynamicProviderPlugin import
  and factory-selection behavior.
- `packages/core/src/plugin/internal.ts` and
  `packages/core/src/plugin/supervisor.ts` - internal/configured plugin ordering,
  loading, and cleanup scope.
- `packages/core/src/integration.ts` and
  `packages/core/src/integration/connection.ts` - active connections and
  connection-updated publication.
- `packages/core/src/catalog.ts` and `packages/core/src/model-resolver.ts` -
  provider/model upsert, package/settings overlay, variant overlay, and reload.
- `packages/core/src/session/runner/publish-llm-event.ts` and
  `packages/core/src/session/message-updater.ts` - provider-state selection,
  durable event publication, and message projection.
- `packages/core/src/config.ts` and `packages/core/src/config/plugin.ts` - plural
  `plugins` and `{ package, options }` config.
- `packages/tui/src/context/data.tsx` - live text/reasoning reducers and the
  remaining text state-copy issue.
- `packages/tui/src/plugin/context.tsx` - v2 TUI package loader, setup, slot
  registration, and cleanup aggregation.
- `packages/tui/src/routes/session/sidebar.tsx`,
  `packages/tui/src/routes/session/index.tsx`, and
  `packages/tui/src/routes/session/composer/index.tsx` - sidebar and composer
  slot locations.
- `packages/tui/src/config/index.tsx` - global TUI `plugins` configuration.
- `packages/core/test/plugin/promise.test.ts` and
  `packages/core/test/plugin/provider-dynamic.test.ts` - Promise adaptation and
  dynamic provider behavior.
- `packages/tui/test/plugin/runtime.test.ts`,
  `packages/tui/test/plugin/slots.test.tsx`,
  `packages/tui/test/cli/tui/data.test.tsx`, and
  `packages/tui/test/config-v2.test.tsx` - TUI loading/lifecycle, slots, data
  reduction, and configuration behavior.

### opencode-kiro v1

- `src/server.ts` - v1 auth loader, OAuth flow, runtime model transform,
  notifications, `auth.json` coupling, and `tui.json` writing.
- `src/tui.ts` - v1 TUI registration and slot names.
- `src/tui/credits.ts` - credit extraction, formatting, and per-message dedupe.
- `src/tui/credits-box-view.ts` - sidebar state and theme usage.
- `src/tui/credits-chip-view.ts` - prompt credit chip.
- `package.json` - version `0.4.0`, exports, dependencies, and build scripts.
- `test/server.test.ts`, `test/tui-credits.test.ts`, and
  `test/scaffold.test.ts` - current behavior and package scaffold coverage.

### kiro-acp-ai-provider 3.0.0

- `package.json` - version, AI SDK peer range, and exports.
- `src/index.ts` - `createKiroAcp`, `verifyAuth`, `listModels`, and `getQuota`
  exports.
- `src/kiro-acp-provider.ts` - callable provider, `.languageModel()`, settings,
  and shutdown behavior.
- `src/kiro-acp-model.ts` - LanguageModelV3 implementation, effort option
  handling, and dual credit metadata emission.
- `src/kiro-models.ts` - runtime model and effort discovery.
- `src/kiro-auth.ts` - `kiro-cli` installation and authentication checks.
