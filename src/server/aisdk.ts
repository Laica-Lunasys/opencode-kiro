// AISDK `sdk` hook: deterministic plugin-owned Kiro provider (v2, task 07).
//
// `DynamicProviderPlugin` is registered BEFORE package plugins at the pinned
// SHA, so by the time this hook runs it may already have created an unowned
// provider and populated `event.sdk`. The Kiro hook therefore ALWAYS assigns
// its own `createKiroAcp(event.options)` instance — even when `event.sdk` is
// already set — so Kiro's options and ownership stay deterministic. The
// overwritten instance is not plugin-owned and has no public shutdown handoff;
// that residual duplicate-ACP-process risk is measured in the host (task 13).
//
// Every instance this plugin creates is tracked in a per-setup registry and
// `shutdown()` exactly once from the aggregated server cleanup. No
// LanguageModel wrapper: kiro-acp-ai-provider@3.0.0 is LanguageModelV3 and
// v2's default fallback calls `sdk.languageModel(modelID)`.
//
// The SDK import stays lazy so dist/server.js loads under plain Node without
// touching kiro-acp-ai-provider at module import time (v1 discipline).
import type { Model, Plugin } from "@opencode-ai/plugin"
import type { KiroACPProvider, KiroACPProviderSettings } from "kiro-acp-ai-provider"

// bare package name — core normalizes `Provider.Info.package`
// ("aisdk:kiro-acp-ai-provider") to the package name for the SDK event
export const KIRO_SDK_PACKAGE = "kiro-acp-ai-provider"

// structural mirror of the installed d.ts `AISDKHooks["sdk"]` event
// (dist/promise/aisdk.d.ts) — AISDKHooks is not exported from the package
// root, so we keep a local alias that stays assignable to it.
type SdkHookEvent = {
  readonly model: Model.Info
  readonly package: string
  readonly options: Record<string, unknown>
  sdk?: unknown
}

// aisdk resources tracked for the aggregated cleanup (same pattern as
// AuthResources/DiscoveryResources): hook registration disposer, the owned
// provider registry (each instance shut down exactly once), and the reuse
// cache keyed by a stable settings key (per setup = per location, so the
// location component of the cache key is implicit).
export interface AisdkResources {
  ownedSdks: Set<KiroACPProvider>
  cache: Map<string, KiroACPProvider>
  disposeHook: (() => Promise<void>) | undefined
}

export function createAisdkResources(): AisdkResources {
  return {
    ownedSdks: new Set(),
    cache: new Map(),
    disposeHook: undefined,
  }
}

// accept the normalized bare name and (defensively) the raw `aisdk:`-prefixed
// catalog value, in case a future core stops normalizing before the event
function isKiroPackage(pkg: string): boolean {
  return pkg === KIRO_SDK_PACKAGE || pkg === `aisdk:${KIRO_SDK_PACKAGE}`
}

// JSON-safe = only null/boolean/number/string and arrays/plain objects
// thereof. Function or exotic-object identities (e.g. `fetch`) cannot be
// represented in a string key — never JSON-stringify those.
function isJsonSafe(value: unknown): boolean {
  if (value === null) return true
  const kind = typeof value
  if (kind === "string" || kind === "number" || kind === "boolean") return true
  if (Array.isArray(value)) return value.every(isJsonSafe)
  if (kind === "object") {
    const proto: unknown = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return false
    return Object.values(value as Record<string, unknown>).every(isJsonSafe)
  }
  return false
}

// deterministic stringify (sorted keys) — only ever called on JSON-safe data
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    return `{${entries.join(",")}}`
  }
  return JSON.stringify(value)
}

// stable cache key for the event options, or undefined when the options carry
// function/object identities that cannot be keyed safely — in that case the
// hook creates and tracks a DISTINCT owned instance instead of incorrectly
// reusing one.
export function stableOptionsKey(options: Record<string, unknown>): string | undefined {
  return isJsonSafe(options) ? stableStringify(options) : undefined
}

// register the `sdk` hook; returns one disposer that unregisters the hook and
// shuts down every owned provider exactly once, attempting all even if some
// fail (combined AggregateError).
export async function registerAisdkHook(
  context: Plugin.Context,
  resources: AisdkResources,
): Promise<() => Promise<void>> {
  const registration = await context.aisdk.hook("sdk", async (event: SdkHookEvent) => {
    if (!isKiroPackage(event.package)) return

    const { createKiroAcp } = await import("kiro-acp-ai-provider")
    const key = stableOptionsKey(event.options)
    let sdk = key === undefined ? undefined : resources.cache.get(key)
    if (sdk === undefined) {
      // options arrive from provider settings set by the catalog transform:
      // { cwd, agent: "opencode", trustAllTools: true, mcpTimeout: 45, contextWindows }
      sdk = createKiroAcp(event.options as KiroACPProviderSettings)
      resources.ownedSdks.add(sdk)
      if (key !== undefined) resources.cache.set(key, sdk)
    }

    // ALWAYS assign, even when DynamicProviderPlugin already populated it
    event.sdk = sdk
  })
  resources.disposeHook = registration.dispose

  return async () => {
    const errors: unknown[] = []

    resources.disposeHook = undefined
    try {
      await registration.dispose()
    } catch (error) {
      errors.push(error)
    }

    // drain the registry BEFORE shutting down so a second cleanup pass (or a
    // failure mid-loop) can never shutdown() the same instance twice
    const owned = Array.from(resources.ownedSdks)
    resources.ownedSdks.clear()
    resources.cache.clear()
    for (const sdk of owned) {
      try {
        await sdk.shutdown()
      } catch (error) {
        errors.push(error)
      }
    }

    if (errors.length > 0) throw new AggregateError(errors, "kiro aisdk cleanup failures")
  }
}
