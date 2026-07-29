// v2 TUI plugin: appends the Kiro credits surface, replaces nothing.
//   - `sidebar.content`: credits-only box (v2 has no slot ordering; renders after built-ins).
//     This is the ONLY registered surface: the pinned SHA's typed slot set (`SlotMap`)
//     removed `session.composer.top`, so the interim composer strip is descoped and its
//     content (formatted total + unit) lives in the sidebar box.
// Data access is v2-only: durable messages via `context.data.session.message.list(sessionID)`
// (content parts are inlined), live text-only credits via the `session.text.ended` transient
// store (upstream reducer bug workaround: the text-ended reducer drops `event.data.state`).
// `context.data.session.message.sync` stays an explicit-refresh fallback only — it is never
// forced after a text end (latency/churn; the migration doc deprioritizes it) and is not
// wired to any automatic trigger here.
//
// LAZY-IMPORT RULE (preserved from v1): @opentui/core is Bun-native and only exists inside
// the TUI host, so the view module (./tui/credits-box-view.js) and solid-js are imported
// dynamically INSIDE setup — never at module top level — keeping dist/tui.js loadable under
// plain Node. Inside the TUI host, `ensureRuntimePluginSupport()` (loader shim at the pinned
// SHA) redirects our `solid-js`/`@opentui/*` imports to the HOST's module instances, so the
// signal/render reactivity below shares the host renderer's solid runtime by construction.
//
// Installed-types notes:
//   - `@opencode-ai/plugin/tui` namespaces its types as `Plugin.Definition` / `Plugin.Context`
//     / `Plugin.Cleanup` via `export * as Plugin from "./plugin.js"`.
//   - Slots are a typed closed set: `SlotMap` keys name the slots and give each its exact
//     props type (`sidebar.content` → `{ sessionID: string }`); the render type
//     `Slot<Name> = (props: SlotMap[Name]) => JSX.Element` still uses solid-js's DOM-flavored
//     Element union; opentui DomNodes and reactive function children are what the host's
//     universal renderer actually accepts, so the registration casts the returned accessor
//     at the boundary (see the deviation note at `context.ui.slot`).
import type { Plugin } from "@opencode-ai/plugin/tui"
import type { JSX } from "@opentui/solid"
import type { SessionCredits } from "./tui/credits.js"
import {
  clear,
  createTransientStore,
  mergedMessageCredits,
  reconcile,
  recordTextEnded,
} from "./tui/transient-credits.js"

const EMPTY_CREDITS: SessionCredits = { total: 0, unit: undefined, present: false }

/** Slot props carry `{ sessionID }` (typed via `SlotMap`); treat anything else as "no session". */
function readSessionID(props: { readonly sessionID?: unknown }): string | undefined {
  const sessionID = props.sessionID
  return typeof sessionID === "string" && sessionID.length > 0 ? sessionID : undefined
}

// setup returns ONE aggregated, idempotent cleanup: the first call marks the instance
// disposed, attempts every disposer (reverse registration order) even when one fails, then
// reports combined failures via AggregateError; later calls are no-ops.
const plugin: Plugin.Definition = {
  // `id` is required for file-source installs (opencode rejects them without one);
  // matching the package name keeps it identical across path and npm installs
  id: "opencode-kiro",
  async setup(context: Plugin.Context): Promise<Plugin.Cleanup> {
    const disposers: Array<() => void | Promise<void>> = []
    let disposed = false

    // per-setup transient store — no module-global state. Registered first so the
    // reverse-order cleanup clears it last, after slots and listeners are gone.
    const store = createTransientStore()
    disposers.push(() => clear(store))

    // lazy import (see LAZY-IMPORT RULE above): the view module pulls Bun-native
    // @opentui/core transitively, so it loads only when the TUI host runs setup.
    const [{ createCreditsBoxView }, { createSignal }] = await Promise.all([
      import("./tui/credits-box-view.js"),
      import("solid-js"),
    ])

    // Transient writes go into a plain Map (not reactive); this signal makes render-path
    // reads re-run after a text-ended record, independent of host reducer ordering.
    const [transientVersion, setTransientVersion] = createSignal(0)

    const unsubscribeTextEnded = context.data.on("session.text.ended", (event) => {
      // never-throw UI side effects (v1 discipline): invalid payloads are swallowed by
      // recordTextEnded's guards, and anything unexpected is ignored here.
      try {
        recordTextEnded(store, event)
        setTransientVersion((version) => version + 1)
      } catch {
        // ignore — a bad event must never break host event dispatch
      }
    })
    disposers.push(unsubscribeTextEnded)

    // Render-path data assembly (views stay presentation-only): every fresh durable read
    // reconciles the transient store first, so durable state stays authoritative and
    // totals never count a transient and durable copy together.
    const creditsFor =
      (sessionID: string | undefined) =>
      (): SessionCredits => {
        if (!sessionID) return EMPTY_CREDITS
        transientVersion()
        const messages = context.data.session.message.list(sessionID) ?? []
        reconcile(store, sessionID, messages)
        return mergedMessageCredits(store, sessionID, messages)
      }

    // The registration returns a reactive accessor that yields the view node only while
    // the session carries Kiro credit data, so non-kiro sessions contribute nothing.
    // Deviation note: the installed Slot type's JSX.Element union does not structurally
    // include opentui DomNodes or function children, but the host's universal renderer
    // resolves both — hence the boundary cast.
    const unregisterSidebar = context.ui.slot("sidebar.content", (props) => {
      const credits = creditsFor(readSessionID(props))
      const view = createCreditsBoxView(credits)
      return (() => (credits().present ? view : null)) as unknown as JSX.Element
    })
    disposers.push(unregisterSidebar)

    return async () => {
      if (disposed) return
      disposed = true
      const errors: unknown[] = []
      for (const dispose of disposers.reverse()) {
        try {
          await dispose()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, "opencode-kiro tui cleanup failures")
    }
  },
}

export default plugin
