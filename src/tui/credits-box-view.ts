// credits-only sidebar box for the v2 `sidebar.content` slot, appended after the built-in
// sections (v2 exposes no slot-ordering API). This is the plugin's ONLY credits surface:
// the pinned SHA's typed slot set removed `session.composer.top`, and the descoped composer
// strip's entire content — the live formatted total + unit line — is carried here under the
// "Kiro" header, updating live as durable/transient credits change. Presentation only:
// tui.ts assembles the merged durable+transient rollup and passes it in as an accessor;
// this module never touches the TUI context. Default/inherited styling throughout — v2 has
// no supported theme-token API, so nothing sets foreground colors and the terminal/host
// defaults apply.
// built with @opentui/solid's universal-renderer calls (what compiled Solid JSX lowers to)
// so dist needs no solid transform; @opentui/solid and solid-js stay external (and, inside
// the TUI host, resolve to the HOST's module instances via its runtime-plugin loader shim).
import { createElement, insert, insertNode, type DomNode } from "@opentui/solid"
import { createMemo } from "solid-js"
import { formatCredits, type SessionCredits } from "./credits.js"

/**
 * Build the Kiro credits box for one session. `credits` is the merged durable+transient
 * session rollup assembled in tui.ts (reconciled on every fresh durable read).
 */
export function createCreditsBoxView(credits: () => SessionCredits): DomNode {
  const current = createMemo(credits)

  // stable nodes with reactive strings: both render "" with no credits, so the box collapses
  // to nothing (tui.ts additionally withholds the node entirely for credit-less sessions).
  // one stable node + reactive string sidesteps opentui child-list reconciliation
  // (version-dependent in the old clone view).
  const root = createElement("box")
  insertNode(
    root,
    headerLine(() => (current().present ? "Kiro" : "")),
  )
  insertNode(
    root,
    plainLine(() => (current().present ? formatCredits(current().total, current().unit) : "")),
  )
  return root
}

/** `<text><b>{content()}</b></text>` — bold header on the default foreground. */
function headerLine(content: () => string): DomNode {
  const line = createElement("text")
  const bold = createElement("b")
  insert(bold, content)
  insertNode(line, bold)
  return line
}

/** `<text>{content()}</text>` — inherited/default styling. */
function plainLine(content: () => string): DomNode {
  const line = createElement("text")
  insert(line, content)
  return line
}
