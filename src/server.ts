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
import { registerDiscovery } from "./server/discovery.js"
import { buildCleanup, createServerState } from "./server/lifecycle.js"

// setup order: build per-location state -> registerAuth (Integration `kiro` +
// Kiro CLI Login OAuth) -> registerDiscovery (captures cwd from
// integration.list().location, registers the catalog transform + event
// consumer, kicks off one initial discovery when already connected) ->
// registerAisdkHook (plugin-owned createKiroAcp provider) -> return the ONE
// aggregated, idempotent cleanup.
//
// Failure path: if any registration throws mid-setup, the partial cleanup runs
// over the disposers registered so far (no leaked registrations) and the
// ORIGINAL setup error is rethrown; cleanup failures during that unwind are
// swallowed so they cannot mask it.
const plugin: Plugin.Plugin = {
  id: "kiro",
  async setup(context: Plugin.Context): Promise<Plugin.Cleanup> {
    const state = createServerState()
    const cleanup = buildCleanup(state)

    try {
      state.disposers.push(await registerAuth(context, state.auth))
      state.disposers.push(await registerDiscovery(context, state.discovery))
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
