// Pure transient-credit store: works around the live TUI `session.text.ended` reducer, which
// copies the completed text but omits `event.data.state` (the reasoning branch does copy state).
// A text-only response therefore lacks credits in live TUI state even though the durable record
// has them; this module retains the event's credit state and merges it with durable data under
// the one-carrier-per-assistant-message rule. The SDK's stall status (`state.status`) rides the
// same metadata object and is retained alongside the credits. Because the SDK attaches that
// metadata to whichever part closes the turn (the last text part, or the stall notice's reasoning
// part when one is still open), both `session.text.ended` and `session.reasoning.ended` feed this
// store through the same recording function.
//
// Invariants:
//   - Content parts are ID-less: tuples key by (sessionID, assistantMessageID, ordinal) only —
//     never by a content-part ID (see the KeyParts type-level guard below).
//   - Durable `part.state` is authoritative: when any durable part of a message carries valid credit
//     or stall metadata, the durable value is used and transient values for that message are ignored
//     (merge) and deleted (reconcile). Transient and durable are never summed for one message.
//   - No solid/opentui/plugin imports: stays plain-Node testable.

import {
  addMessageMetadata,
  messageMetadata,
  readPartMetadata,
  type CreditPart,
  type PartMetadata,
  type SessionCredits,
} from "./credits.js"

// Type-level guard rail: a transient key derives from exactly (sessionID, assistantMessageID, ordinal).
// There is no content-part-ID position; adding one would change this tuple and every call site.
type KeyParts = readonly [sessionID: string, assistantMessageID: string, ordinal: number]

/** Opaque tuple key: `${sessionID}\u0000${assistantMessageID}\u0000${ordinal}`. Build via `transientKey` only. */
export type TransientKey = `${string}\u0000${string}\u0000${number}`

const SEPARATOR = "\u0000"

/** Transient credit and stall metadata keyed by (sessionID, assistantMessageID, ordinal). */
export interface TransientCreditStore {
  readonly entries: Map<TransientKey, PartMetadata>
}

/**
 * Minimal structural shape shared by the `session.text.ended` and `session.reasoning.ended` events
 * (per the installed `@opencode-ai/client` d.ts: `data: { sessionID, assistantMessageID, ordinal, text,
 * state? }`). Kept local so this module never imports the plugin package.
 */
export interface TextEndedEvent {
  readonly data: {
    readonly sessionID: string
    readonly assistantMessageID: string
    readonly ordinal: number
    readonly state?: object
  }
}

/**
 * Minimal structural shape of a durable v2 session message (`SessionMessageInfo`):
 * assistant messages carry `type: "assistant"` and inlined `content` parts.
 */
export interface DurableMessage {
  readonly id: string
  readonly type: string
  readonly content?: ReadonlyArray<CreditPart>
}

/** Creates an empty transient store instance (all functions here operate on an explicit instance). */
export function createTransientStore(): TransientCreditStore {
  return { entries: new Map() }
}

function transientKey(...parts: KeyParts): TransientKey {
  const [sessionID, assistantMessageID, ordinal] = parts
  return `${sessionID}${SEPARATOR}${assistantMessageID}${SEPARATOR}${ordinal}` as TransientKey
}

function parseKey(key: TransientKey): KeyParts | undefined {
  const parts = key.split(SEPARATOR)
  if (parts.length !== 3) return undefined
  return [parts[0]!, parts[1]!, Number(parts[2])]
}

function isValidKeyPart(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes(SEPARATOR)
}

/**
 * Record the metadata carried by a `session.text.ended` or `session.reasoning.ended` event. Stores
 * only when the tuple identifiers are valid and the state passes the same validation as durable part
 * reads (`readPartMetadata`: finite numeric credits with a non-empty string unit, and/or a stall
 * status with a positive `stalledMs`). A stalled turn is recorded even when the state carries no
 * credits. No-op otherwise.
 */
export function recordTextEnded(store: TransientCreditStore, event: TextEndedEvent): void {
  const data: unknown = event?.data
  if (typeof data !== "object" || data === null) return
  const { sessionID, assistantMessageID, ordinal, state } = data as Record<string, unknown>
  // Runtime guard rail: only the (sessionID, assistantMessageID, ordinal) tuple may key an entry.
  if (!isValidKeyPart(sessionID) || !isValidKeyPart(assistantMessageID)) return
  if (typeof ordinal !== "number" || !Number.isInteger(ordinal) || ordinal < 0) return
  const metadata = readPartMetadata(state)
  if (!metadata) return
  store.entries.set(transientKey(sessionID, assistantMessageID, ordinal), metadata)
}

/**
 * Last-carrier-wins transient metadata for one assistant message: credits from the highest-ordinal
 * entry that carries credits, stall status from the highest-ordinal entry that carries one. Undefined
 * when the message has no transient entries.
 */
function transientForMessage(
  store: TransientCreditStore,
  sessionID: string,
  assistantMessageID: string,
): PartMetadata | undefined {
  const entries: Array<[ordinal: number, value: PartMetadata]> = []
  for (const [key, value] of store.entries) {
    const parsed = parseKey(key)
    if (!parsed || parsed[0] !== sessionID || parsed[1] !== assistantMessageID) continue
    entries.push([parsed[2], value])
  }
  if (entries.length === 0) return undefined
  entries.sort((a, b) => a[0] - b[0])
  const credits = entries.findLast(([, value]) => value.credits !== undefined)?.[1]
  const status = entries.findLast(([, value]) => value.status !== undefined)?.[1]?.status
  return {
    ...(credits ? { credits: credits.credits, unit: credits.unit } : {}),
    ...(status ? { status } : {}),
  }
}

/**
 * Session rollup over durable messages merged with transient tuples, one carrier per assistant
 * message: if any durable part of a message carries valid credit or stall metadata, the durable value
 * is used (authoritative); otherwise the message's transient value applies. Transient and durable are
 * never summed for the same message, and transient tuples for messages absent from `durableMessages`
 * never count. Same result shape as `sumSessionCredits`, including the last turn's stall status.
 */
export function mergedMessageCredits(
  store: TransientCreditStore,
  sessionID: string,
  durableMessages: ReadonlyArray<DurableMessage>,
): SessionCredits {
  return durableMessages
    .filter((message) => message.type === "assistant")
    .reduce<SessionCredits>(
      (acc, message) => {
        const durable = messageMetadata(message.content ?? [])
        return addMessageMetadata(acc, durable ?? transientForMessage(store, sessionID, message.id))
      },
      { total: 0, unit: undefined, present: false },
    )
}

/**
 * Drop transient tuples of `sessionID` that durable data has superseded or orphaned:
 *   - the message's durable parts now carry credit or stall metadata (durable is authoritative), or
 *   - the message no longer exists in `durableMessages` (deleted message — or deleted session, when
 *     the caller passes an empty array for a session that is gone).
 * Because `mergedMessageCredits` already prefers durable values and ignores tuples without a durable
 * message, reconciliation never changes displayed totals.
 */
export function reconcile(
  store: TransientCreditStore,
  sessionID: string,
  durableMessages: ReadonlyArray<DurableMessage>,
): void {
  const byID = new Map(durableMessages.map((message) => [message.id, message]))
  for (const key of [...store.entries.keys()]) {
    const parsed = parseKey(key)
    if (!parsed || parsed[0] !== sessionID) continue
    const message = byID.get(parsed[1])
    if (!message) {
      store.entries.delete(key)
      continue
    }
    if (messageMetadata(message.content ?? []) !== undefined) store.entries.delete(key)
  }
}

/** Drops every transient tuple (e.g. on TUI cleanup). */
export function clear(store: TransientCreditStore): void {
  store.entries.clear()
}
