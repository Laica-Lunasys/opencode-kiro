// Catalog transform + async runtime model discovery lifecycle (v2, task 06).
//
// The catalog transform is a SYNCHRONOUS mutation phase: it reads ONLY the
// captured last-known-good discovery snapshot and never performs I/O. The
// asynchronous `listModels({ cwd })` discovery runs OUTSIDE transforms,
// guarded by a generation token (stale completions after logout or a newer
// discovery are discarded silently) and coalesced (concurrent discover()
// calls share one in-flight `listModels` invocation). `catalog.reload()` is
// only ever called from discovery code paths, NEVER from inside the
// transform callback itself.
//
// v1 fail-open discipline is preserved: empty/undefined snapshot, duplicate
// runtime modelIds, or a discovery exception leave the previous catalog data
// untouched — no partial results are ever published.
//
// The SDK import stays lazy so dist/server.js loads under plain Node without
// touching kiro-acp-ai-provider at module import time (v1 discipline).
import type { Integration, Model, Plugin } from "@opencode-ai/plugin"
import type { KiroACPProviderSettings, ModelWithEfforts } from "kiro-acp-ai-provider"
import { KIRO_INTEGRATION_ID, KIRO_INTEGRATION_NAME } from "./auth.js"

// v2 has no `model.api` structure: the provider is resolved via
// `Provider.Info.package` (normalized to the package name for the SDK event).
export const KIRO_PROVIDER_ID = "kiro"
export const KIRO_PROVIDER_PACKAGE = "aisdk:kiro-acp-ai-provider"

// derive draft/model/event types from the installed d.ts (CatalogDraft and
// the event union are not exported from the package root)
type CatalogDraft = Parameters<Parameters<Plugin.Context["catalog"]["transform"]>[0]>[0]
type MutableModel = Parameters<Parameters<CatalogDraft["model"]["update"]>[2]>[0]
type ServerEvent =
  ReturnType<Plugin.Context["event"]["subscribe"]> extends AsyncIterable<infer E> ? E : never

// DeepMutable maps over branded-string intersections and yields a non-string
// mapped type; at runtime these values ARE plain strings, so reads coerce back
function asString(value: unknown): string {
  return value as string
}

// per-location discovery state, shared with tasks 05/07 via `src/server.ts`
// setup. `cwd` comes from a public location-bearing response during setup —
// never from `process.cwd()` captured at module load.
export interface DiscoveryState {
  cwd: string
  snapshot: readonly ModelWithEfforts[] | undefined
  generation: number
  inflight: Promise<void> | undefined
}

// discovery resources tracked for the aggregated cleanup (task 07 extends the
// same pattern as AuthResources): transform disposer, event iterator + its
// consumer task, and the state carrying the inflight promise + generation
// counter (invalidated on cleanup by a final bump).
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

// v1 effort-variant merge algorithm ported to v2 shapes (`git show
// main:src/server.ts`): empty runtime efforts → model untouched (no invented
// variants); a defined baseline effort lands in `model.settings.effort`;
// each runtime effort upserts a `variants[]` entry whose `settings.effort`
// carries the effort string unchanged. Existing catalog variants not named by
// the runtime are preserved.
//
// B3 fix (HOST_E2E_REPORT.md): the settings key MUST be the SDK's own
// `KiroACPProviderSettings.effort` key, not the v1-era `reasoningEffort`.
// This is the single effort-plumbing mechanism: the host overlays the selected
// variant's settings onto `model.settings` (`withVariant`,
// model-resolver.ts:126-133 at the pinned SHA), which becomes the aisdk hook's
// `event.options` and is passed verbatim to `createKiroAcp` — the aisdk hook
// performs NO key mapping. The `satisfies` pin below makes a key rename in the
// SDK a compile error here.
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

// synchronous catalog transform body. Reads ONLY the captured snapshot:
// - empty/undefined snapshot → catalog left untouched (fail open)
// - rich models.dev Kiro entry → exact case-sensitive intersection of catalog
//   `Model.Info.modelID` against runtime `modelId`, metadata preserved
// - no rich entry → minimal self-registration of ONLY runtime-returned models
// Provider settings carry the deterministic SDK factory inputs that become
// `event.options` for task 07's AISDK hook; `contextWindows` is keyed by the
// API model ID (`Model.Info.modelID`), not the catalog key.
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
    // fallback: publish ONLY models actually returned by the runtime; the
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
      agent: "opencode",
      trustAllTools: true,
      mcpTimeout: 45,
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
//    previous snapshot, NO reload of partial data (fail open)
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

// DUAL-LISTEN credential-event filter (Phase 9 fix). Upstream removed
// `integration.connection.updated` (multi-account credentials feature),
// replacing it with `credential.updated` + `credential.switched`. The
// published plugin must react on BOTH generations of hosts, so we accept all
// three names: old hosts never fire the new names and new hosts never fire
// the old one — dual-listen is safe both ways.
//
// TYPE NOTE: the legacy name is ABSENT from the pinned d.ts event-type union,
// so a typed literal comparison would not compile (TS2367). We read
// `event.type` through a widened `string` for the legacy check — deliberate
// backward-compat, NOT dead code; do not "clean up" to the typed union.
function isKiroCredentialEvent(event: ServerEvent): boolean {
  const type: string = event.type

  // legacy hosts (pre multi-account): kiro-scope on the payload as before
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

  // new hosts: EMPTY payload (`Struct<{}>`) — cannot scope by integration;
  // the `connection.active("kiro")` re-check inside discover() IS the scoping
  // (over-firing on multi-integration hosts is absorbed by coalescing)
  return type === "credential.updated"
}

// setup-owned event consumer: filters the dual-listen credential events for
// Kiro and runs a discovery. Login/logout is never inferred from the event —
// discover() re-checks `connection.active`. Never rejects (cleanup awaits
// this task).
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
// initial discovery when Kiro is already connected. Returns one disposer that
// invalidates pending generations, stops/awaits the event consumer, and
// unregisters the transform. An in-flight `listModels` has no documented
// cancellation — it is NOT awaited; the final generation bump guarantees its
// completion is discarded.
export async function registerDiscovery(
  context: Plugin.Context,
  resources: DiscoveryResources,
): Promise<() => Promise<void>> {
  // per-location cwd from a public location-bearing response (doc "Location
  // and lifecycle") — never process.cwd() at module load
  const { location } = await context.integration.list()
  const state: DiscoveryState = {
    cwd: location.directory,
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
  // not block on model listing; discover() never rejects past this guard
  if (await context.integration.connection.active(KIRO_INTEGRATION_ID)) {
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
