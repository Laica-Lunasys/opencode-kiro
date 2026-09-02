// AISDK `sdk` + `language` hooks: deterministic plugin-owned Kiro provider
// shared per real configuration (v2 task 07; beta.4 allowlist atom).
//
// `DynamicProviderPlugin` is registered BEFORE package plugins at the pinned
// SHA, so by the time the `sdk` hook runs it may already have created an
// unowned provider and populated `event.sdk`. The Kiro hook therefore ALWAYS
// assigns its own owned `createKiroAcp(settings)` instance — even when
// `event.sdk` is already set — so Kiro's options and ownership stay
// deterministic. The overwritten instance is not plugin-owned and has no
// public shutdown handoff; that residual duplicate-ACP-process risk is
// measured in the host (task 13).
//
// beta.4 atom (Items 1+2+5, inseparable):
// - The host's `prepareOptions` unconditionally injects an `options.fetch`
//   function (host aisdk.ts:119-131 at the pinned SHA), so the beta.3
//   JSON-safety cache key rejected EVERY production event → cache bypass → a
//   distinct owned ACP process per event. The key is now derived from an
//   ALLOWLIST-sanitized settings object, so fetch-injection (or any unknown
//   key) can no longer bypass reuse — and because the same sanitized object is
//   what reaches `createKiroAcp`, a dropped key can never silently configure a
//   provider either.
// - `effort`/`efforts` are deliberately excluded from the settings/key so ONE
//   provider is shared across effort variants; effort reaches kiro-cli
//   per-request via the `language` hook's `languageModel(id, { effort })`
//   override instead (SDK precedence: overrides?.effort ??
//   settings.efforts?.[modelId] ?? settings.effort).
// - `clientInfo` is merged as a process constant so kiro-cli's ACP initialize
//   identifies this plugin (never per-request or timestamp-like, so it
//   participates in the cache key harmlessly).
//
// Every instance this plugin creates is tracked in a per-setup registry and
// `shutdown()` exactly once from the aggregated server cleanup. No
// LanguageModel wrapper and no plugin-side language-instance cache: the host
// memoizes language instances per settings-key (host aisdk.ts:249-291), which
// is naturally per-effort because variant settings differ.
//
// The SDK import stays lazy so dist/server.js loads under plain Node without
// touching kiro-acp-ai-provider at module import time (v1 discipline).
import type { Model, Plugin } from "@opencode-ai/plugin"
import type { KiroACPModelOverrides, KiroACPProvider, KiroACPProviderSettings } from "kiro-acp-ai-provider"
// NAMED import on purpose: esbuild converts top-level JSON properties into
// named exports and tree-shakes the rest, so dist/server.js inlines ONLY the
// version string (a default import would inline the whole package.json —
// dependency-name residue the scaffold zero-residue lock rejects).
import { version as PKG_VERSION } from "../../package.json"
import { KIRO_PROVIDER_ID } from "./discovery.js"

// bare package name — core normalizes `Provider.Info.package`
// ("aisdk:kiro-acp-ai-provider") to the package name for the SDK event
export const KIRO_SDK_PACKAGE = "kiro-acp-ai-provider"

// process-constant client identification forwarded to kiro-cli's ACP
// initialize (KiroACPProviderSettings.clientInfo). The version is inlined from
// package.json at build time (tsup/esbuild JSON import), so dist/server.js
// stays free of runtime file reads.
const CLIENT_INFO = { name: "opencode-kiro", version: PKG_VERSION } as const

// structural mirror of the installed d.ts `AISDKHooks["sdk"]` event
// (dist/promise/aisdk.d.ts) — AISDKHooks is not exported from the package
// root, so we keep a local alias that stays assignable to it.
type SdkHookEvent = {
  readonly model: Model.Info
  readonly package: string
  readonly options: Record<string, unknown>
  sdk?: unknown
}

// structural mirror of the installed d.ts `AISDKHooks["language"]` event
// (dist/promise/aisdk.d.ts:11-16) — same local-alias pattern as SdkHookEvent.
// `language` is typed `unknown` here (host: LanguageModelV3) so this module
// does not import @ai-sdk/provider types directly.
type LanguageHookEvent = {
  readonly model: Model.Info
  readonly sdk: unknown
  readonly options: Record<string, unknown>
  language?: unknown
}

// aisdk resources tracked for the aggregated cleanup (same pattern as
// AuthResources/DiscoveryResources): hook registration disposers (sdk +
// language, in registration order), the owned provider registry (each
// instance shut down exactly once), and the reuse cache keyed by a stable
// sanitized-settings key (per setup = per location, so the location component
// of the cache key is implicit).
export interface AisdkResources {
  ownedSdks: Set<KiroACPProvider>
  cache: Map<string, KiroACPProvider>
  disposeHooks: Array<() => Promise<void>>
}

export function createAisdkResources(): AisdkResources {
  return {
    ownedSdks: new Set(),
    cache: new Map(),
    disposeHooks: [],
  }
}

// accept the normalized bare name and (defensively) the raw `aisdk:`-prefixed
// catalog value, in case a future core stops normalizing before the event
function isKiroPackage(pkg: string): boolean {
  return pkg === KIRO_SDK_PACKAGE || pkg === `aisdk:${KIRO_SDK_PACKAGE}`
}

// Allowlist of KiroACPProviderSettings keys the factory consumes (installed
// d.ts). EXCLUDED on purpose:
//  - effort / efforts: carried per-request via the language hook's
//    KiroACPModelOverrides — including them in the settings/key would defeat
//    provider sharing across efforts (Req 1/3).
//  - onPermission: function-valued (unkeyable) and never set by our catalog.
//  - everything else (e.g. the host-injected `fetch`): not consumed by
//    createKiroAcp — dropping unknown keys is the allowlist's point (Req 2).
// The `satisfies` clause is the compile pin: an SDK key rename breaks the
// build here.
const SETTINGS_ALLOWLIST = [
  "cwd",
  "model",
  "agent",
  "trustAllTools",
  "agentPrompt",
  "env",
  "clientInfo",
  "sessionId",
  "contextWindow",
  "contextWindows",
  "mcpTimeout",
] as const satisfies readonly (keyof KiroACPProviderSettings)[]

// pick the allowlisted keys present on the event options (skip undefined).
// The returned object is used for BOTH the cache key and the `createKiroAcp`
// argument, so key and factory input can never diverge. Values are trusted:
// they originate from this plugin's own catalog transform (discovery.ts
// provider settings), the same trust the beta.3 verbatim pass-through had.
function sanitizeSettings(options: Record<string, unknown>): Record<string, unknown> {
  const settings: Record<string, unknown> = {}
  for (const key of SETTINGS_ALLOWLIST) {
    const value = options[key]
    if (value !== undefined) settings[key] = value
  }
  return settings
}

// JSON-safe = only null/boolean/number/string and arrays/plain objects
// thereof. Function or exotic-object identities cannot be represented in a
// string key — never JSON-stringify those.
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

// stable cache key for the sanitized+merged settings. Allowlisted values are
// JSON-safe by construction, so the key is defined for every production
// event; the isJsonSafe check is pure paranoia — if a non-JSON-safe value
// ever slips through the allowlist, the undefined key makes the hook create
// and track a DISTINCT owned instance instead of incorrectly reusing one
// (functions/exotic identities cannot be keyed).
export function stableSettingsKey(settings: Record<string, unknown>): string | undefined {
  return isJsonSafe(settings) ? stableStringify(settings) : undefined
}

// register the `sdk` + `language` hooks; returns one disposer that
// unregisters both hooks and shuts down every owned provider exactly once,
// attempting all even if some fail (combined AggregateError).
export async function registerAisdkHook(
  context: Plugin.Context,
  resources: AisdkResources,
): Promise<() => Promise<void>> {
  // providerID scoping per installed d.ts ModelHookOptions
  // (dist/promise/registration.d.ts:4-9): the hooks only fire for the kiro
  // provider. The isKiroPackage guard stays as defense in depth, and the
  // always-overwrite-owned-`event.sdk` discipline is unchanged
  // (DynamicProviderPlugin risk).
  const sdkRegistration = await context.aisdk.hook(
    "sdk",
    async (event: SdkHookEvent) => {
      if (!isKiroPackage(event.package)) return

      // sanitize BEFORE keying: the host spreads model settings into
      // event.options and injects `fetch` (host aisdk.ts:119-131); only the
      // allowlisted subset plus the constant clientInfo may configure a
      // provider, and the key derives from that SAME merged object.
      const settings = { ...sanitizeSettings(event.options), clientInfo: CLIENT_INFO }
      const key = stableSettingsKey(settings)
      let sdk = key === undefined ? undefined : resources.cache.get(key)
      if (sdk === undefined) {
        const { createKiroAcp } = await import("kiro-acp-ai-provider")
        sdk = createKiroAcp(settings as KiroACPProviderSettings)
        resources.ownedSdks.add(sdk)
        if (key !== undefined) resources.cache.set(key, sdk)
      }

      // ALWAYS assign, even when DynamicProviderPlugin already populated it
      event.sdk = sdk
    },
    { providerID: KIRO_PROVIDER_ID },
  )
  resources.disposeHooks.push(sdkRegistration.dispose)

  // the host calls the language hook AFTER the sdk hook with the resolved
  // `event.sdk` (host aisdk.ts:286) — the owned provider is always the
  // receiver. Per-request effort travels here as a KiroACPModelOverrides
  // override, precedent: host gitlab.ts:50-61.
  let languageRegistration: Awaited<ReturnType<typeof context.aisdk.hook>>
  try {
    languageRegistration = await context.aisdk.hook(
      "language",
      async (event: LanguageHookEvent) => {
        // effort arrives via the host's variant-settings overlay on
        // event.options (model-resolver.ts withVariant). String-guard only —
        // no 4-way fallback (Req 3: simplicity; the SDK's own precedence
        // handles settings-level efforts).
        const effort = typeof event.options.effort === "string" ? event.options.effort : undefined
        const overrides =
          effort === undefined ? undefined : ({ effort } satisfies Pick<KiroACPModelOverrides, "effort">)
        // String(...) coercion local to this module on purpose: the branded
        // Model.ID reads as a plain string at runtime, and discovery.ts's
        // asString helper is private (non-exported).
        event.language = (event.sdk as KiroACPProvider).languageModel(String(event.model.modelID), overrides)
      },
      { providerID: KIRO_PROVIDER_ID },
    )
  } catch (error) {
    // no leaked sdk-hook registration when the second registration fails
    // mid-setup (registerAisdkHook has not returned its disposer yet)
    await sdkRegistration.dispose().catch(() => {})
    resources.disposeHooks.length = 0
    throw error
  }
  resources.disposeHooks.push(languageRegistration.dispose)

  return async () => {
    const errors: unknown[] = []

    // drain the disposer list BEFORE disposing (same discipline as ownedSdks)
    const disposeHooks = resources.disposeHooks.splice(0)
    for (const dispose of disposeHooks) {
      try {
        await dispose()
      } catch (error) {
        errors.push(error)
      }
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
