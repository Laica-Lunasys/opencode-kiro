// pure credit helpers (no opentui/solid imports, so they test under plain Node).
// The host stores metadata[providerMetadataKey] key-unwrapped, so credits live at part.state.credits /
// part.state.creditsUnit on text and reasoning content parts — never nested under a provider key.
// The SDK's stall status rides the same state object as `part.state.status` (`{ stalledMs, hint? }`),
// attached only to turns that stalled.
// dedupe: count once per message; text and reasoning parts carry the same turn total (dual emission), so last-carrier-wins and parts are never summed.

/** Any part-like object. `object` (not `{ state?: unknown }`) so state-less content-part variants stay assignable. */
export type CreditPart = object

/** Minimal message shape; SDK `Message` is assignable. */
export interface CreditMessage {
  readonly id: string
  readonly role: string
}

/** One part's credit metadata: the turn total plus the SDK-reported unit. */
export interface PartCredits {
  credits: number
  unit?: string
}

/**
 * Stall status the SDK attaches to a turn's final part when the turn stalled: total stalled
 * wall-clock milliseconds plus, when available, the last kiro-cli ERROR log line as a hint.
 */
export interface StallStatus {
  stalledMs: number
  hint?: string
}

/**
 * Everything the credits path reads off one part's state: the credits (with unit) when the part
 * carries them, and the stall status when the turn stalled. At least one of the two is present.
 */
export interface PartMetadata extends Partial<PartCredits> {
  status?: StallStatus
}

/** Session-wide rollup. `unit` stays undefined until metadata reports one. */
export interface SessionCredits {
  total: number
  unit?: string
  /**
   * True once any assistant message carried kiro metadata (credits or stall status). Lets the view pick
   * credits over the "$X spent" fallback, since a 0-credit kiro turn is indistinguishable from no
   * metadata by `total` alone.
   */
  present: boolean
  /** Stall status of the most recent completed kiro turn; absent when that turn did not stall. */
  status?: StallStatus
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * Validate key-unwrapped credit state (`{ credits, creditsUnit }`); only finite numeric credits count,
 * and only non-empty string units. Shared by durable part reads and the transient text-ended store so
 * both paths accept exactly the same shapes.
 */
export function readCreditState(state: unknown): PartCredits | undefined {
  if (!isRecord(state)) return undefined
  if (typeof state.credits !== "number" || !Number.isFinite(state.credits)) return undefined
  return {
    credits: state.credits,
    unit: typeof state.creditsUnit === "string" && state.creditsUnit.length > 0 ? state.creditsUnit : undefined,
  }
}

/**
 * Validate a stall status value (`{ stalledMs, hint? }`): only a finite, positive `stalledMs` counts,
 * and only a non-empty string hint is kept. Anything else (absent, malformed, or a turn that did not
 * stall) reads as undefined.
 */
export function readStallStatus(status: unknown): StallStatus | undefined {
  if (!isRecord(status)) return undefined
  const { stalledMs, hint } = status
  if (typeof stalledMs !== "number" || !Number.isFinite(stalledMs) || stalledMs <= 0) return undefined
  return typeof hint === "string" && hint.length > 0 ? { stalledMs, hint } : { stalledMs }
}

/**
 * Read both credits and stall status from key-unwrapped part state. Undefined when the state carries
 * neither, so callers can treat "no kiro metadata" uniformly. Shared by durable part reads and the
 * transient store.
 */
export function readPartMetadata(state: unknown): PartMetadata | undefined {
  if (!isRecord(state)) return undefined
  const credits = readCreditState(state)
  const status = readStallStatus(state.status)
  if (!credits && !status) return undefined
  return { ...credits, ...(status ? { status } : {}) }
}

/** Only text and reasoning content parts carry kiro metadata. */
function carrierState(part: CreditPart): unknown {
  if (!isRecord(part)) return undefined
  if (part.type !== "text" && part.type !== "reasoning") return undefined
  return part.state
}

/** Read key-unwrapped `state.credits`/`state.creditsUnit` from a text or reasoning content part. */
export function readPartCredits(part: CreditPart): PartCredits | undefined {
  return readCreditState(carrierState(part))
}

/** Read key-unwrapped `state.status` from a text or reasoning content part. */
export function readPartStatus(part: CreditPart): StallStatus | undefined {
  const state = carrierState(part)
  return isRecord(state) ? readStallStatus(state.status) : undefined
}

/** One message's credits, deduped by the last-carrier-wins rule (parts never summed); unit from the most recent carrier. */
export function messageCredits(parts: ReadonlyArray<CreditPart>): PartCredits | undefined {
  const carriers = parts.map(readPartCredits).filter((value): value is PartCredits => value !== undefined)
  const last = carriers.at(-1)
  if (!last) return undefined
  return {
    credits: last.credits,
    unit: last.unit ?? carriers.findLast((carrier) => carrier.unit !== undefined)?.unit,
  }
}

/** One message's stall status: the last part carrying one wins; undefined when the turn did not stall. */
export function messageStatus(parts: ReadonlyArray<CreditPart>): StallStatus | undefined {
  return parts.map(readPartStatus).findLast((value) => value !== undefined)
}

/** One message's credits and stall status together, or undefined when no part carries either. */
export function messageMetadata(parts: ReadonlyArray<CreditPart>): PartMetadata | undefined {
  const credits = messageCredits(parts)
  const status = messageStatus(parts)
  if (!credits && !status) return undefined
  return { ...credits, ...(status ? { status } : {}) }
}

/** Per-message credit total, or undefined when no part carries credits. */
export function creditsForMessage(parts: ReadonlyArray<CreditPart>): number | undefined {
  return messageCredits(parts)?.credits
}

/**
 * Fold one assistant message's metadata into the session rollup: credits add to the total, the unit
 * follows the most recent carrier, and the stall status is replaced outright so only the last completed
 * kiro turn's stall shows (a clean turn clears it). Messages without metadata leave the rollup untouched.
 */
export function addMessageMetadata(acc: SessionCredits, hit: PartMetadata | undefined): SessionCredits {
  if (!hit) return acc
  return {
    total: acc.total + (hit.credits ?? 0),
    unit: hit.unit ?? acc.unit,
    present: true,
    ...(hit.status ? { status: hit.status } : {}),
  }
}

/**
 * Sum per-message totals across a session's assistant messages (one value each); unit from the most
 * recent carrier; stall status from the last message that carried kiro metadata.
 */
export function sumSessionCredits(
  messages: ReadonlyArray<CreditMessage>,
  partsByMessage: (messageID: string) => ReadonlyArray<CreditPart>,
): SessionCredits {
  return messages
    .filter((message) => message.role === "assistant")
    .reduce<SessionCredits>(
      (acc, message) => addMessageMetadata(acc, messageMetadata(partsByMessage(message.id))),
      { total: 0, unit: undefined, present: false },
    )
}

// Explicit locale keeps output deterministic for tests.
const creditsAmount = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 })

/** Render credits with the unit, e.g. "12.5 credits", "1 credit". Unit is naively pluralized unless it ends in "s"; with no unit, only the number renders. */
export function formatCredits(value: number, unit?: string): string {
  const amount = creditsAmount.format(Number.isFinite(value) ? value : 0)
  if (!unit) return amount
  const label = value === 1 || unit.endsWith("s") ? unit : `${unit}s`
  return `${amount} ${label}`
}

const ERROR_SUFFIX = "Error"

/**
 * Short, recognizable reason from a stall hint (the last kiro-cli ERROR log line). Prefers the
 * `kind:` value when the line carries one (e.g. `kind: ModelOverloadedError`), otherwise the first
 * error-kind-like word (e.g. `ConverseStreamError`); either way the `Error` suffix is dropped
 * (`ModelOverloaded`). Undefined when no such token exists, so the summary omits the parenthetical.
 */
export function stallReason(hint: string | undefined): string | undefined {
  if (typeof hint !== "string" || hint.length === 0) return undefined
  const token = /\bkind:\s*([A-Z][A-Za-z0-9]*)/.exec(hint)?.[1] ?? /\b([A-Z][A-Za-z0-9]*Error)\b/.exec(hint)?.[1]
  if (!token) return undefined
  const reason = token.endsWith(ERROR_SUFFIX) ? token.slice(0, -ERROR_SUFFIX.length) : token
  return reason.length > 0 ? reason : undefined
}

/**
 * One-line stall summary for the credits surfaces, e.g. "last turn stalled 66s (ModelOverloaded)" or
 * "last turn stalled 66s" without a usable hint. Seconds are rounded (never below 1). Undefined for an
 * absent or malformed status, so callers render nothing; never throws.
 */
export function formatStallSummary(status: unknown): string | undefined {
  const valid = readStallStatus(status)
  if (!valid) return undefined
  const seconds = Math.max(1, Math.round(valid.stalledMs / 1000))
  const reason = stallReason(valid.hint)
  return reason ? `last turn stalled ${seconds}s (${reason})` : `last turn stalled ${seconds}s`
}

/** Separator between the credits total and the stall summary on single-line surfaces. */
export const STALL_SEPARATOR = " · "

/**
 * Single-line text for the footer chip: the formatted total, followed by the stall summary when the
 * last completed turn stalled (`1.5 credits · last turn stalled 66s (ModelOverloaded)`). Empty when
 * the session carries no kiro metadata, so the chip collapses.
 */
export function creditsChipText(credits: SessionCredits): string {
  if (!credits.present) return ""
  const total = formatCredits(credits.total, credits.unit)
  const stall = formatStallSummary(credits.status)
  return stall ? `${total}${STALL_SEPARATOR}${stall}` : total
}

// mirrors the builtin sidebar's USD formatter (context.tsx). co-located out of the view so cost lines stay pure and Solid-free for tests.
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

/**
 * Muted cost lines as an array (one per rendered row). Three states:
 *   - both (credits present + non-zero cost): ["$X.XX spent", "N credits"]
 *   - credits only (cost 0): ["N credits"]
 *   - dollars only (no credits): ["$X.XX spent"] (also ["$0.00 spent"] when empty)
 * Keys off `credits.present` and `cost > 0`, never `credits.total` alone (a 0-credit kiro turn is present).
 */
export function spendLines(input: { cost: number; credits: SessionCredits }): string[] {
  const { cost, credits } = input
  const dollars = money.format(Number.isFinite(cost) ? cost : 0)
  if (credits.present && cost > 0) {
    return [`${dollars} spent`, formatCredits(credits.total, credits.unit)]
  }
  if (credits.present) {
    return [formatCredits(credits.total, credits.unit)]
  }
  return [`${dollars} spent`]
}
