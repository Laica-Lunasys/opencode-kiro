// v2 server plugin: final setup composition (task 07). Task 05 registered the
// Integration/auth flow, task 06 the catalog transform + discovery lifecycle,
// task 07 the AISDK `sdk` hook plus the per-location ServerState and the
// aggregated cleanup builder (src/server/lifecycle.ts). Remaining v1 hook
// logic lives at `git show main:src/server.ts`.
//
// Installed-types note: `@opencode-ai/plugin` (root promise export) namespaces its
// types as `Plugin.Plugin` / `Plugin.Context` / `Plugin.Cleanup` via
// `export * as Plugin from "./plugin.js"`.
import type { Plugin } from "@opencode-ai/plugin"
import { registerAisdkHook } from "./server/aisdk.js"
import { registerAuth } from "./server/auth.js"
import { type KiroPluginOptions, registerDiscovery } from "./server/discovery.js"
import { buildCleanup, createServerState } from "./server/lifecycle.js"

// Plugin options (npm channel only — bundled/builtin plugins receive {}).
// Both v2 mock contexts omit `options` entirely, and older hosts may too:
// the ?? {} guard is REQUIRED. No `cwd` option by design — per-location
// integration.list() derivation is strictly better (discovery.ts).
//
// Exactly three options (Req 9): `agent` (default "opencode"), `mcpTimeout`
// (default 45), `discover` (default true). Type-invalid values fall back to
// the defaults and unknown keys are ignored silently (fail-open, consistent
// with plugin discipline). `trustAllTools` is NOT exposed.
function resolveOptions(raw: Record<string, unknown>): KiroPluginOptions {
  return {
    agent: typeof raw.agent === "string" && raw.agent !== "" ? raw.agent : "opencode",
    mcpTimeout:
      typeof raw.mcpTimeout === "number" && Number.isFinite(raw.mcpTimeout) ? raw.mcpTimeout : 45,
    discover: typeof raw.discover === "boolean" ? raw.discover : true,
  }
}

// setup order: resolve plugin options -> build per-location state ->
// registerAuth (Integration `kiro` + Kiro CLI Login OAuth) -> registerDiscovery
// (captures cwd from integration.list().location, registers the catalog
// transform + event consumer, kicks off one initial discovery when already
// connected and `discover` is not false) -> registerAisdkHook (plugin-owned
// createKiroAcp provider) -> return the ONE aggregated, idempotent cleanup.
//
// Failure path: if any registration throws mid-setup, the partial cleanup runs
// over the disposers registered so far (no leaked registrations) and the
// ORIGINAL setup error is rethrown; cleanup failures during that unwind are
// swallowed so they cannot mask it.
const plugin: Plugin.Plugin = {
  id: "kiro",
  // tui: true (dist/promise/plugin.d.ts:40) — the host auto-loads this
  // package's `./tui` entrypoint for npm-channel installs (single config entry)
  tui: true,
  async setup(context: Plugin.Context): Promise<Plugin.Cleanup> {
    // `PluginOptions` is a loose Readonly<Record<string, any>> in the installed
    // d.ts; the runtime typeof checks in resolveOptions are the real guard
    const options = resolveOptions((context.options ?? {}) as Record<string, unknown>)
    const state = createServerState()
    const cleanup = buildCleanup(state)

    try {
      state.disposers.push(await registerAuth(context, state.auth))
      state.disposers.push(await registerDiscovery(context, state.discovery, options))
      state.disposers.push(await registerAisdkHook(context, state.aisdk))
    } catch (error) {
      await Promise.resolve(cleanup()).catch(() => {})
      throw error
    }

    return cleanup
  },
}

// default export drives opencode's plugin loader via the `./server` exports
// subpath. The exports map deliberately has no "." key, so there is no root
// fallback (HOST_E2E O1).
export default plugin

// named export, same reference as the default so the two can't drift (kept for v1 compatibility)
export const KiroAuthPlugin = plugin
