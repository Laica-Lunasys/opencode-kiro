// v2 TUI plugin: appends the Kiro credits surfaces, replaces nothing (immutable req. 17).
// Two ADDITIVE slot claims (`ui.slot({ append, render })` — claims API at the Phase 8 pin):
//   - `sidebar.content`: credits box ("Kiro" header + formatted total).
//   - `prompt.footer.status`: compact chip in the prompt footer row (v1 placement restored)
//     with the same formatted total + unit, composing after the host's status content
//     (spinner / interrupt / location label).
// Data access is v2-only: durable messages via `context.data.session.message.list(sessionID)`
// (content parts are inlined), live text-only credits via the `session.text.ended` transient
// store. The durable path is fixed upstream (server projection persists state on text.ended),
// but the LIVE reducer path still drops `event.data.state`, so the transient store stays as a
// live-overlay; the durable-wins reconcile below remains correct and unchanged.
// `context.data.session.message.sync` stays an explicit-refresh fallback only — it is never
// forced after a text end (latency/churn; the migration doc deprioritizes it) and is not
// wired to any automatic trigger here.
//
// LAZY-IMPORT RULE (preserved from v1): @opentui/core is Bun-native and only exists inside
// the TUI host, so the view modules (./tui/credits-box-view.js, ./tui/credits-chip-view.js)
// and solid-js are imported dynamically INSIDE setup — never at module top level — keeping
// dist/tui.js loadable under plain Node. Inside the TUI host, `ensureRuntimePluginSupport()`
// (loader shim at the pinned SHA) redirects our `solid-js`/`@opentui/*` imports to the HOST's
// module instances, so the signal/render reactivity below shares the host renderer's solid
// runtime by construction.
//
// Installed-types notes:
//   - `@opencode-ai/plugin/tui` namespaces its types as `Plugin.Definition` / `Plugin.Context`
//     / `Plugin.Cleanup` via `export * as Plugin from "./plugin.js"`.
//   - Slots are a typed closed set (`SlotMap`): claim objects carry exactly one placement key
//     (`append` here — additive) plus `render`, whose input is the slot's exact props type
//     (`sidebar.content` is `{ sessionID: string }`; `prompt.footer.status` is
//     `PromptFooterInput` = `{ sessionID?: string; mode: "normal" | "shell" }` — sessionID
//     is OPTIONAL there, and the chip is withheld when it is absent).
//     `ui.slot(claim)` still returns an unregister fn. The render type still uses solid-js's
//     DOM-flavored JSX.Element union; opentui DomNodes and reactive function children are what
//     the host's universal renderer actually accepts, so each registration casts the returned
//     accessor at the boundary (see the deviation note at the first claim).
//   - `context.theme` is typed `ResolvedTheme`, but `@opencode-ai/theme` is an uninstalled
//     peer (types erase to `any` under skipLibCheck) and the delta marks it churn-prone —
//     tokens are FEATURE-DETECTED at render time and views fall back to default styling.
import type { Plugin } from "@opencode-ai/plugin/tui"
import type { JSX } from "@opentui/solid"
import type { CreditThemeTokens } from "./tui/credits-box-view.js"
import type { SessionCredits } from "./tui/credits.js"
import {
  clear,
  createTransientStore,
  mergedMessageCredits,
  reconcile,
  recordTextEnded,
  type TransientCreditStore,
} from "./tui/transient-credits.js"

const EMPTY_CREDITS: SessionCredits = { total: 0, unit: undefined, present: false }

/**
 * Slot props carry a sessionID (typed via `SlotMap`; REQUIRED on `sidebar.content`, OPTIONAL
 * on `prompt.footer.status`); treat anything else as "no session".
 */
function readSessionID(props: { readonly sessionID?: unknown }): string | undefined {
  const sessionID = props.sessionID
  return typeof sessionID === "string" && sessionID.length > 0 ? sessionID : undefined
}

/** Accept a color token only in a shape opentui's `fg` takes: non-empty string or object (RGBA). */
function readColorToken(value: unknown): CreditThemeTokens["default"] {
  if (typeof value === "string" && value.length > 0) return value
  if (typeof value === "object" && value !== null) return value as CreditThemeTokens["default"]
  return undefined
}

/**
 * Feature-detect `context.theme` tokens (`theme.text.default` / `theme.text.subdued` per the
 * ResolvedTheme shape at the pinned SHA). Returns undefined for an absent/misshapen theme so
 * the views keep their default styling — rendering never DEPENDS on the theme (req. 12).
 */
function readThemeTokens(theme: unknown): CreditThemeTokens | undefined {
  if (typeof theme !== "object" || theme === null) return undefined
  const text = (theme as Record<string, unknown>).text
  if (typeof text !== "object" || text === null) return undefined
  const tokens = text as Record<string, unknown>
  const defaultFg = readColorToken(tokens.default)
  const subduedFg = readColorToken(tokens.subdued)
  if (defaultFg === undefined && subduedFg === undefined) return undefined
  return { default: defaultFg, subdued: subduedFg }
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

    // transient store (2026-08-23, storage.memory adoption): hosted in TUI `storage.memory`
    // when available so the live-overlay credits survive plugin hot reloads (`tui: true`
    // installs) — solid stores leave Map values unwrapped, so the store's pure API in
    // transient-credits.ts is unchanged. A memory-backed store is shared with the NEXT plugin
    // generation and therefore intentionally NOT cleared on cleanup; the fallback per-setup
    // store keeps the v1 behavior (registered first so the reverse-order cleanup clears it
    // last, after slots and listeners are gone).
    const memoryStore = context.storage?.memory?.<TransientCreditStore>("transient-credits", {
      initial: createTransientStore(),
    })
    const store: TransientCreditStore = memoryStore ? memoryStore[0] : createTransientStore()
    if (!memoryStore) disposers.push(() => clear(store))

    // lazy import (see LAZY-IMPORT RULE above): the view modules pull Bun-native
    // @opentui/core transitively, so they load only when the TUI host runs setup.
    const [{ createCreditsBoxView }, { createCreditsChipView }, { createSignal }] = await Promise.all([
      import("./tui/credits-box-view.js"),
      import("./tui/credits-chip-view.js"),
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

    // Both claims return a reactive accessor that yields the view node only while the
    // session carries Kiro credit data, so non-kiro sessions contribute nothing.
    // Deviation note: the installed SlotClaim render type's JSX.Element union does not
    // structurally include opentui DomNodes or function children, but the host's universal
    // renderer resolves both — hence the boundary cast.
    const unregisterSidebar = context.ui.slot({
      append: "sidebar.content",
      render: (props) => {
        const credits = creditsFor(readSessionID(props))
        const view = createCreditsBoxView(credits, readThemeTokens(context.theme))
        return (() => (credits().present ? view : null)) as unknown as JSX.Element
      },
    })
    disposers.push(unregisterSidebar)

    // Chip placement (pre-publish amendment): the prompt footer row, restoring the v1
    // placement. The host mounts `prompt.footer.status` inside a `flexDirection="row"
    // gap={2}` footer box and `Slot` renders claims as fragment siblings, so the chip sits
    // beside the host status content with the row gap as its separator (no separator text
    // needed). `sessionID` is optional in `PromptFooterInput` — readSessionID + creditsFor
    // already yield EMPTY_CREDITS then, so the chip is withheld exactly like a credit-less
    // session. `mode` ("normal" | "shell") is deliberately IGNORED: the chip renders in
    // both modes — the host footer children don't change by mode at the pin, the chip is a
    // short non-shrinking string next to a flexGrow/flexShrink host box, and collapsing on
    // shell toggle would only cause a layout jump.
    const unregisterChip = context.ui.slot({
      append: "prompt.footer.status",
      render: (props) => {
        const credits = creditsFor(readSessionID(props))
        const view = createCreditsChipView(credits, readThemeTokens(context.theme))
        return (() => (credits().present ? view : null)) as unknown as JSX.Element
      },
    })
    disposers.push(unregisterChip)

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
