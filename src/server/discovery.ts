// Catalog transform + async runtime model discovery lifecycle.
//
// The catalog transform is a synchronous mutation phase: it reads only the
// captured last-known-good discovery snapshot and never performs I/O. The
// asynchronous `listModels({ cwd })` discovery runs outside transforms, guarded
// by a generation token (stale completions after logout or a newer discovery
// are discarded) and coalesced (concurrent discover() calls share one in-flight
// call). `catalog.reload()` is only ever called from discovery code paths, never
// from inside the transform. Discovery fails open: an empty snapshot, duplicate
// runtime modelIds, or an exception leave the previous catalog data untouched.
// The SDK import stays lazy so dist/server.js loads under plain Node.
import type { Integration, Model, Plugin } from "@opencode-ai/plugin"
import type { KiroACPProviderSettings, ModelWithEfforts } from "kiro-acp-ai-provider"
import { KIRO_INTEGRATION_ID, KIRO_INTEGRATION_NAME } from "./auth.js"

// the provider is resolved via `Provider.Info.package` (normalized to the
// package name for the SDK event).
export const KIRO_PROVIDER_ID = "kiro"
export const KIRO_PROVIDER_PACKAGE = "aisdk:kiro-acp-ai-provider"

// derive draft/model/event types from the installed d.ts (CatalogDraft and
// the event union are not exported from the package root)
type CatalogDraft = Parameters<Parameters<Plugin.Context["catalog"]["transform"]>[0]>[0]
type MutableModel = Parameters<Parameters<CatalogDraft["model"]["update"]>[2]>[0]
type ServerEvent =
  ReturnType<Plugin.Context["event"]["subscribe"]> extends AsyncIterable<infer E> ? E : never

// DeepMutable maps over branded-string intersections and yields a non-string
// mapped type; at runtime these values are plain strings, so reads coerce back
function asString(value: unknown): string {
  return value as string
}

// resolved plugin options (defaults applied by src/server.ts `resolveOptions`).
// Exactly three keys — `trustAllTools` stays hardcoded and `cwd` is not an
// option by design: the per-location `integration.list().location.directory`
// derivation is strictly better than a user-supplied path.
export interface KiroPluginOptions {
  agent: string
  mcpTimeout: number
  discover: boolean
}

// per-location discovery state, created during `src/server.ts` setup. `cwd`
// comes from a public location-bearing response during setup — never from
// `process.cwd()` captured at module load. `options` are the resolved plugin
// options the transform emits into `provider.settings`.
export interface DiscoveryState {
  cwd: string
  options: KiroPluginOptions
  snapshot: readonly ModelWithEfforts[] | undefined
  generation: number
  inflight: Promise<void> | undefined
}

// discovery resources tracked for the aggregated cleanup (same pattern as
// AuthResources): transform disposer, event iterator + its consumer task, and
// the state carrying the inflight promise + generation counter (invalidated
// on cleanup by a final bump).
export interface DiscoveryResources {
  state: DiscoveryState | undefined
  disposeTransform: (() => Promise<void>) | undefined
  eventIterator: AsyncIterator<ServerEvent, unknown, unknown> | undefined
  eventTask: Promise<void> | undefined
}

export function createDiscoveryResources(): DiscoveryResources {
  return {
    state: undefined,
    disposeTransform: undefined,
    eventIterator: undefined,
    eventTask: undefined,
  }
}

// effort-variant merge: empty runtime efforts → model untouched (no invented
// variants); a defined baseline effort lands in `model.settings.effort`; each
// runtime effort upserts a `variants[]` entry whose `settings.effort` carries
// the effort string unchanged. Existing catalog variants not named by the
// runtime are preserved.
//
// The variant settings key must be the SDK's own `KiroACPProviderSettings.effort`
// key: the host overlays the selected variant's settings onto `model.settings`,
// which becomes the aisdk hooks' `event.options`, and the `language` hook in
// src/server/aisdk.ts reads `event.options.effort` to forward it per request.
// The `satisfies` pin makes an SDK key rename a compile error here.
function effortSettings(effort: string): { effort: string } {
  return { effort } satisfies Pick<KiroACPProviderSettings, "effort">
}

function applyEfforts(model: MutableModel, runtimeModel: ModelWithEfforts): void {
  if (runtimeModel.runtimeEfforts.length === 0) return

  if (runtimeModel.baselineEffort !== undefined) {
    model.settings = { ...model.settings, ...effortSettings(runtimeModel.baselineEffort) }
  }

  for (const effort of runtimeModel.runtimeEfforts) {
    const existing = model.variants.find((variant) => asString(variant.id) === effort)
    if (existing !== undefined) {
      existing.settings = { ...existing.settings, ...effortSettings(effort) }
    } else {
      model.variants.push({
        id: effort as Model.VariantID,
        settings: effortSettings(effort),
      })
    }
  }
}

// synchronous catalog transform body. Reads only the captured snapshot:
// - empty/undefined snapshot → catalog left untouched (fail open)
// - rich models.dev Kiro entry → exact case-sensitive intersection of catalog
//   `Model.Info.modelID` against runtime `modelId`, metadata preserved
// - no rich entry → minimal self-registration of only runtime-returned models
// Provider settings carry the deterministic SDK factory inputs that become
// `event.options` for the aisdk hooks; `contextWindows` is keyed by the API
// model ID (`Model.Info.modelID`), not the catalog key. `agent` and
// `mcpTimeout` come from the resolved plugin options; both keys are on the
// sdk hook's SETTINGS_ALLOWLIST (src/server/aisdk.ts), so custom values reach
// `createKiroAcp` through catalog → host overlay → `event.options` unchanged.
export function applyCatalogSnapshot(draft: CatalogDraft, state: DiscoveryState): void {
  const snapshot = state.snapshot
  if (snapshot === undefined || snapshot.length === 0) return

  const runtime = new Map(snapshot.map((model) => [model.modelId, model]))

  // rich = a models.dev Kiro entry with models is already in the draft
  // (`provider.get` does not upsert; only `update` initializes missing records)
  const record = draft.provider.get(KIRO_PROVIDER_ID)
  const rich = record !== undefined && record.models.size > 0

  const contextWindows: Record<string, number> = {}

  if (rich) {
    // snapshot the entries first: removal mutates the underlying map
    for (const [catalogKey, catalogModel] of Array.from(record.models.entries())) {
      const runtimeModel = runtime.get(asString(catalogModel.modelID))
      if (runtimeModel === undefined) {
        draft.model.remove(KIRO_PROVIDER_ID, catalogKey)
        continue
      }
      draft.model.update(KIRO_PROVIDER_ID, catalogKey, (model) => {
        applyEfforts(model, runtimeModel)
        if (model.limit.context > 0) contextWindows[asString(model.modelID)] = model.limit.context
      })
    }
  } else {
    // fallback: publish only models actually returned by the runtime; the
    // draft initializes missing records before the callback runs (upsert)
    for (const runtimeModel of snapshot) {
      draft.model.update(KIRO_PROVIDER_ID, runtimeModel.modelId, (model) => {
        model.name = runtimeModel.name || runtimeModel.modelId
        model.modelID = runtimeModel.modelId as Model.ID
        applyEfforts(model, runtimeModel)
        if (model.limit.context > 0) contextWindows[asString(model.modelID)] = model.limit.context
      })
    }
  }

  draft.provider.update(KIRO_PROVIDER_ID, (provider) => {
    provider.name = KIRO_INTEGRATION_NAME
    provider.integrationID = KIRO_INTEGRATION_ID as Integration.ID
    provider.package = KIRO_PROVIDER_PACKAGE
    provider.settings = {
      ...provider.settings,
      cwd: state.cwd,
      agent: state.options.agent,
      trustAllTools: true, // intentionally not exposed as a plugin option
      mcpTimeout: state.options.mcpTimeout,
      contextWindows,
    }
  })
}

// discovery operation factory. The returned `discover(reason)`:
// 1. re-checks `connection.active("kiro")` — not active → clear snapshot,
//    bump generation (invalidates in-flight completions), reload
// 2. coalesces onto an existing in-flight discovery
// 3. runs `listModels({ cwd })` under a captured generation token
// 4. validates unique case-sensitive modelIds; duplicates/exceptions → keep
//    previous snapshot, no reload of partial data (fail open)
// 5. discards stale completions (`gen !== state.generation`) silently
// 6. atomically replaces the snapshot, then reloads (outside the transform)
export function createDiscover(
  context: Plugin.Context,
  state: DiscoveryState,
): (reason: string) => Promise<void> {
  async function runDiscovery(gen: number): Promise<void> {
    try {
      const { listModels } = await import("kiro-acp-ai-provider")
      const discovered = await listModels({ cwd: state.cwd })
      // stale: logout or a newer discovery bumped the generation mid-flight
      if (gen !== state.generation) return
      const uniqueIds = new Set(discovered.map((model) => model.modelId))
      if (uniqueIds.size !== discovered.length) return
      state.snapshot = discovered
      await context.catalog.reload()
    } catch {
      // fail open: previous snapshot retained, no reload
    }
  }

  return async function discover(_reason: string): Promise<void> {
    const active = await context.integration.connection.active(KIRO_INTEGRATION_ID)
    if (!active) {
      state.generation += 1
      state.snapshot = undefined
      await context.catalog.reload()
      return
    }

    if (state.inflight !== undefined) return state.inflight

    const gen = ++state.generation
    const run = runDiscovery(gen).finally(() => {
      if (state.inflight === run) state.inflight = undefined
    })
    state.inflight = run
    return run
  }
}

// Credential-event filter covering both host generations. Older hosts emit
// `integration.connection.updated`; newer hosts replaced it with
// `credential.updated` + `credential.switched` (multi-account credentials).
// The plugin accepts all three names: a host never fires both generations, so
// listening for both is safe either way.
//
// The legacy name is absent from the installed d.ts event-type union, so a
// typed literal comparison would not compile (TS2367). `event.type` is read
// through a widened `string` for the legacy check; this is deliberate
// backward compatibility, not dead code.
function isKiroCredentialEvent(event: ServerEvent): boolean {
  const type: string = event.type

  // legacy hosts (pre multi-account): kiro-scope on the payload
  if (type === "integration.connection.updated") {
    const data = (event as { data?: { integrationID?: unknown } }).data
    return data?.integrationID === KIRO_INTEGRATION_ID
  }

  // new hosts: `{integrationID, credentialID(nullable)}` — kiro-scope on
  // integrationID; credentialID (null on sign-out of the active credential)
  // is irrelevant here — discover() re-checks connection.active anyway
  if (event.type === "credential.switched") {
    return asString(event.data.integrationID) === KIRO_INTEGRATION_ID
  }

  // new hosts: empty payload (`Struct<{}>`) — cannot scope by integration;
  // the `connection.active("kiro")` re-check inside discover() is the scoping
  // (over-firing on multi-integration hosts is absorbed by coalescing)
  return type === "credential.updated"
}

// setup-owned event consumer: filters the credential events for Kiro and runs
// a discovery. Login/logout is never inferred from the event — discover()
// re-checks `connection.active`. Never rejects (cleanup awaits this task).
async function consumeEvents(
  iterator: AsyncIterator<ServerEvent, unknown, unknown>,
  discover: (reason: string) => Promise<void>,
): Promise<void> {
  try {
    while (true) {
      const result = await iterator.next()
      if (result.done) return
      const event = result.value
      if (isKiroCredentialEvent(event)) {
        try {
          await discover(event.type)
        } catch {
          // discovery failures must not kill the event loop
        }
      }
    }
  } catch {
    // subscription ended (cleanup called return()) or transport error
  }
}

// register the catalog transform + event consumer and kick off one coalesced
// initial discovery when Kiro is already connected and `options.discover` is
// not false. Returns one disposer that invalidates pending generations,
// stops/awaits the event consumer, and unregisters the transform. An
// in-flight `listModels` has no documented cancellation — it is not awaited;
// the final generation bump guarantees its completion is discarded.
export async function registerDiscovery(
  context: Plugin.Context,
  resources: DiscoveryResources,
  options: KiroPluginOptions,
): Promise<() => Promise<void>> {
  // per-location cwd from a public location-bearing response — never
  // process.cwd() at module load, and never a plugin option
  const { location } = await context.integration.list()
  const state: DiscoveryState = {
    cwd: location.directory,
    options,
    snapshot: undefined,
    generation: 0,
    inflight: undefined,
  }
  resources.state = state

  const discover = createDiscover(context, state)

  const registration = await context.catalog.transform((draft) =>
    applyCatalogSnapshot(draft, state),
  )
  resources.disposeTransform = registration.dispose

  const iterator = context.event.subscribe()[Symbol.asyncIterator]()
  resources.eventIterator = iterator
  resources.eventTask = consumeEvents(iterator, discover)

  // setup kick-off: one coalesced discovery, fire-and-forget so setup does
  // not block on model listing; discover() never rejects past this guard.
  // `discover: false` gates only this setup-time kick-off — the event-driven
  // path (consumeEvents → discover) stays live so a user who logs in later
  // still gets models.
  if (options.discover && (await context.integration.connection.active(KIRO_INTEGRATION_ID))) {
    void discover("setup").catch(() => {})
  }

  return async () => {
    // final bump: any in-flight discovery completion becomes stale
    state.generation += 1

    const errors: unknown[] = []

    const eventIterator = resources.eventIterator
    resources.eventIterator = undefined
    if (eventIterator?.return !== undefined) {
      try {
        await eventIterator.return()
      } catch (error) {
        errors.push(error)
      }
    }

    const eventTask = resources.eventTask
    resources.eventTask = undefined
    if (eventTask !== undefined) await eventTask // never rejects

    const disposeTransform = resources.disposeTransform
    resources.disposeTransform = undefined
    if (disposeTransform !== undefined) {
      try {
        await disposeTransform()
      } catch (error) {
        errors.push(error)
      }
    }

    if (errors.length > 0) throw new AggregateError(errors, "kiro discovery cleanup failures")
  }
}
