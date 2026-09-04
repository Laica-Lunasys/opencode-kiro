import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { describe, expect, test, vi } from "vitest"
import {
  creditsChipText,
  creditsForMessage,
  formatCredits,
  formatStallSummary,
  messageCredits,
  readPartCredits,
  spendLines,
  stallReason,
  sumSessionCredits,
  STALL_SEPARATOR,
  type CreditMessage,
  type CreditPart,
  type SessionCredits,
} from "../src/tui/credits"

// Credit-helper + TUI wiring tests. Fixtures are plain content-part shaped
// objects carrying key-unwrapped state (`part.state.credits` /
// `part.state.creditsUnit`) - never `part.state.kiro` and never the legacy
// `part.metadata.kiro` (both are forbidden read shapes). Core hazard is dual
// emission: one message carries the same turn total on its text and reasoning
// parts, so credits count once per message (last carrier wins).

/** Part-shaped fixture carrying key-unwrapped credit state. */
const statePart = (type: string, state: unknown): CreditPart => ({ type, state })

const assistant = (id: string): CreditMessage => ({ id, role: "assistant" })

/** partsByMessage lookup over a plain fixture table. */
const lookup =
  (table: Record<string, ReadonlyArray<CreditPart>>) =>
  (messageID: string): ReadonlyArray<CreditPart> =>
    table[messageID] ?? []

describe("readPartCredits (v2 state shape)", () => {
  test("reads credits from text part state", () => {
    const part = statePart("text", { credits: 1.5, creditsUnit: "credit" })

    expect(readPartCredits(part)).toEqual({ credits: 1.5, unit: "credit" })
  })

  test("reads credits from reasoning part state", () => {
    const part = statePart("reasoning", { credits: 4, creditsUnit: "credit" })

    expect(readPartCredits(part)).toEqual({ credits: 4, unit: "credit" })
  })

  test("rejects the wrapped state.kiro shape", () => {
    // the host stores metadata[providerMetadataKey] key-unwrapped; a provider-keyed
    // nest must never be read
    const part = statePart("text", { kiro: { credits: 1, creditsUnit: "credit" } })

    expect(readPartCredits(part)).toBeUndefined()
  })

  test("rejects the v1 metadata.kiro shape", () => {
    const v1Part: CreditPart = { type: "text", metadata: { kiro: { credits: 1, creditsUnit: "credit" } } }

    expect(readPartCredits(v1Part)).toBeUndefined()
  })

  test("rejects non-finite credits and omits empty units", () => {
    expect(readPartCredits(statePart("text", { credits: Number.NaN }))).toBeUndefined()
    expect(readPartCredits(statePart("text", { credits: Number.POSITIVE_INFINITY }))).toBeUndefined()
    expect(readPartCredits(statePart("text", { credits: "7" }))).toBeUndefined() // string credits
    expect(readPartCredits(statePart("text", null))).toBeUndefined()
    expect(readPartCredits(statePart("text", "not-an-object"))).toBeUndefined()

    // empty-string unit is dropped while the finite credits value survives
    expect(readPartCredits(statePart("text", { credits: 2, creditsUnit: "" }))).toEqual({
      credits: 2,
      unit: undefined,
    })
  })

  test("rejects parts that are not text or reasoning", () => {
    expect(readPartCredits(statePart("step-start", { credits: 1, creditsUnit: "credit" }))).toBeUndefined()
    expect(readPartCredits(statePart("tool", { credits: 1 }))).toBeUndefined()
    expect(readPartCredits({} as CreditPart)).toBeUndefined()
  })
})

describe("credit dedupe per message", () => {
  test("dual emission counted once per message", () => {
    // Reasoning + text parts of one message both carry the turn total (3).
    const parts = [
      statePart("reasoning", { credits: 3, creditsUnit: "credit" }),
      statePart("text", { credits: 3, creditsUnit: "credit" }),
    ]

    const credits = creditsForMessage(parts)

    expect(credits).toBe(3) // not 6: carriers are never summed within a message
  })

  test("last carrier wins within a message; unit backfills from part order", () => {
    // Differing values prove last-wins (not max/sum): the unit-less final
    // carrier takes the credits, unit falls back to the last part that had one.
    const parts = [
      statePart("reasoning", { credits: 2, creditsUnit: "credit" }),
      statePart("text", { credits: 5 }),
    ]

    const result = messageCredits(parts)

    expect(result).toEqual({ credits: 5, unit: "credit" }) // not 2, not 7
  })
})

describe("sumSessionCredits", () => {
  test("sums across multiple assistant messages", () => {
    const messages = [
      { id: "msg_user", role: "user" }, // role-filtered out even with a carrier
      assistant("msg_1"),
      assistant("msg_2"),
      assistant("msg_3"),
    ]
    const partsByMessage = lookup({
      msg_user: [statePart("text", { credits: 100, creditsUnit: "credit" })],
      msg_1: [statePart("text", { credits: 1, creditsUnit: "credit" })],
      msg_2: [statePart("text", { credits: 2, creditsUnit: "credit" })],
      msg_3: [
        // Dual emission inside the rollup still counts once.
        statePart("reasoning", { credits: 3.5, creditsUnit: "credit" }),
        statePart("text", { credits: 3.5, creditsUnit: "credit" }),
      ],
    })

    const result = sumSessionCredits(messages, partsByMessage)

    expect(result).toEqual({ total: 6.5, unit: "credit", present: true }) // 1 + 2 + 3.5
  })

  test("messages without credit state contribute 0", () => {
    // Mixed session: empty, state-less, malformed, and non-finite credits
    // all contribute nothing; only the real carrier counts (no NaN).
    const messages = [assistant("msg_1"), assistant("msg_2"), assistant("msg_3"), assistant("msg_4")]
    const partsByMessage = lookup({
      msg_1: [],
      msg_2: [{ type: "text", text: "plain" }, { type: "step-start" }],
      msg_3: [
        statePart("text", null),
        statePart("text", "not-an-object"), // must not throw
        statePart("text", { credits: Number.NaN }),
        statePart("text", { credits: Number.POSITIVE_INFINITY }),
        statePart("text", { credits: "7" }), // string credits don't count
      ],
      msg_4: [statePart("text", { credits: 4 })],
    })

    const compute = (): ReturnType<typeof sumSessionCredits> => sumSessionCredits(messages, partsByMessage)

    expect(compute).not.toThrow()
    const result = compute()
    expect(result.total).toBe(4)
    expect(Number.isFinite(result.total)).toBe(true)
    expect(result.unit).toBeUndefined() // no carrier ever reported a unit
  })

  test("forbidden carrier shapes are ignored", () => {
    // Only key-unwrapped part.state counts: wrapped state.kiro, v1 metadata.kiro,
    // and providerMetadata are all dead read paths in v2.
    const wrappedState = statePart("text", { kiro: { credits: 9, creditsUnit: "credit" } })
    const v1Metadata: CreditPart = { type: "text", metadata: { kiro: { credits: 9, creditsUnit: "credit" } } }
    const providerMetadata: CreditPart = { type: "text", providerMetadata: { kiro: { credits: 9 } } }

    expect(creditsForMessage([wrappedState, v1Metadata, providerMetadata])).toBeUndefined()
    const result = sumSessionCredits([assistant("msg_1")], () => [wrappedState, v1Metadata, providerMetadata])
    expect(result).toEqual({ total: 0, unit: undefined, present: false })
  })

  test("present distinguishes a real kiro turn from no credit state", () => {
    // The view picks credits-vs-"$X spent" off `present`, not `total`, because a
    // genuine kiro turn worth 0 credits is indistinguishable from a non-kiro
    // session by total alone.
    const noKiro = sumSessionCredits([assistant("msg_1")], () => [{ type: "text", text: "plain" }])
    expect(noKiro).toEqual({ total: 0, unit: undefined, present: false })

    const zeroCreditKiroTurn = sumSessionCredits([assistant("msg_1")], () => [
      statePart("text", { credits: 0, creditsUnit: "credit" }),
    ])
    expect(zeroCreditKiroTurn).toEqual({ total: 0, unit: "credit", present: true })
  })

  test("unit taken from most recent carrier", () => {
    const messages = [assistant("msg_1"), assistant("msg_2"), assistant("msg_3")]
    const partsByMessage = lookup({
      msg_1: [statePart("text", { credits: 1, creditsUnit: "credits" })], // older unit
      msg_2: [statePart("text", { credits: 2, creditsUnit: "points" })], // newest unit
      msg_3: [statePart("text", { credits: 3 })], // unit-less carrier must not erase it
    })

    const result = sumSessionCredits(messages, partsByMessage)

    expect(result.unit).toBe("points")
    expect(result.total).toBe(6)
  })
})

describe("formatCredits", () => {
  test("formatCredits edge cases", () => {
    // kiro-cli reports singular "credit"; pluralize unless value is 1 or the
    // unit already ends in "s".
    expect(formatCredits(0, "credit")).toBe("0 credits")
    expect(formatCredits(0.5, "credit")).toBe("0.5 credits")
    expect(formatCredits(12, "credit")).toBe("12 credits")
    expect(formatCredits(12.5, "credit")).toBe("12.5 credits")
    expect(formatCredits(1, "credit")).toBe("1 credit") // singular preserved
    expect(formatCredits(2, "points")).toBe("2 points") // never "pointss"

    // No unit known: bare number, never an invented unit string.
    expect(formatCredits(0)).toBe("0")
    expect(formatCredits(0.5)).toBe("0.5")
    expect(formatCredits(12)).toBe("12")
    for (const value of [0, 0.5, 12]) {
      expect(formatCredits(value)).not.toContain("undefined")
    }
  })
})

describe("spendLines", () => {
  /** SessionCredits fixture; defaults to the no-kiro-metadata (dollars-only) shape. */
  const sc = (over: Partial<SessionCredits> = {}): SessionCredits => ({
    total: 0,
    unit: undefined,
    present: false,
    ...over,
  })

  test("dollars only: cost>0 with no credits => one '$X.XX spent' line", () => {
    expect(spendLines({ cost: 5, credits: sc() })).toEqual(["$5.00 spent"])
  })

  test("Kiro only: credits present with cost 0 => one credits line", () => {
    expect(spendLines({ cost: 0, credits: sc({ total: 100, unit: "credit", present: true }) })).toEqual([
      "100 credits",
    ])
  })

  test("both: cost>0 and credits present => two stacked lines (dollars then credits)", () => {
    expect(spendLines({ cost: 5, credits: sc({ total: 100, unit: "credit", present: true }) })).toEqual([
      "$5.00 spent",
      "100 credits",
    ])
  })

  test("empty: cost 0 with no credits => '$0.00 spent'", () => {
    expect(spendLines({ cost: 0, credits: sc() })).toEqual(["$0.00 spent"])
  })

  test("both singular: pluralization reuses formatCredits (total 1 => '1 credit')", () => {
    expect(spendLines({ cost: 5, credits: sc({ total: 1, unit: "credit", present: true }) })).toEqual([
      "$5.00 spent",
      "1 credit",
    ])
  })

  test("both unit-less: bare number on the credits line", () => {
    expect(spendLines({ cost: 5, credits: sc({ total: 12, unit: undefined, present: true }) })).toEqual([
      "$5.00 spent",
      "12",
    ])
  })

  test("zero-credit-but-present Kiro turn with cost>0 stays in the both branch", () => {
    expect(spendLines({ cost: 5, credits: sc({ total: 0, unit: "credit", present: true }) })).toEqual([
      "$5.00 spent",
      "0 credits",
    ])
  })

  test("zero-credit-but-present Kiro turn with cost 0 stays in the credits-only branch", () => {
    expect(spendLines({ cost: 0, credits: sc({ total: 0, unit: "credit", present: true }) })).toEqual(["0 credits"])
  })
})

/** Shape of the last ERROR line kiro-cli writes to its chat log (ANSI already stripped). */
const OVERLOADED_HINT =
  "2026-09-03T18:21:04.508113Z ERROR chat_cli_v2::agent::rts: 245: failed to send rts request err=ConverseStreamError { status_code: Some(500), kind: ModelOverloadedError }"

describe("stall summary formatting", () => {
  test("stallReason prefers the kind token, falls back to the first error-kind word, drops the Error suffix", () => {
    expect(stallReason(OVERLOADED_HINT)).toBe("ModelOverloaded")
    expect(stallReason("err=ConverseStreamError { status_code: Some(500) }")).toBe("ConverseStream")
    expect(stallReason("kind: Throttling")).toBe("Throttling") // no suffix to drop
    expect(stallReason("request failed with status 500")).toBeUndefined() // nothing recognizable
    expect(stallReason("")).toBeUndefined()
    expect(stallReason(undefined)).toBeUndefined()
  })

  test("formatStallSummary rounds to whole seconds (never below 1) and appends the reason when known", () => {
    expect(formatStallSummary({ stalledMs: 66_000, hint: OVERLOADED_HINT })).toBe("last turn stalled 66s (ModelOverloaded)")
    expect(formatStallSummary({ stalledMs: 66_000 })).toBe("last turn stalled 66s")
    expect(formatStallSummary({ stalledMs: 66_000, hint: "status 500" })).toBe("last turn stalled 66s") // unusable hint
    expect(formatStallSummary({ stalledMs: 1_500 })).toBe("last turn stalled 2s")
    expect(formatStallSummary({ stalledMs: 200 })).toBe("last turn stalled 1s")
  })

  test("formatStallSummary yields nothing for absent or malformed status and never throws", () => {
    for (const status of [undefined, null, {}, "bad", 66_000, { stalledMs: 0 }, { stalledMs: -1 }, { stalledMs: "66" }, { hint: "x" }]) {
      expect(() => formatStallSummary(status)).not.toThrow()
      expect(formatStallSummary(status)).toBeUndefined()
    }
  })

  test("creditsChipText joins the total and the summary on one line; collapses without kiro metadata", () => {
    const stalled: SessionCredits = { total: 2, unit: "credit", present: true, status: { stalledMs: 66_000, hint: OVERLOADED_HINT } }
    expect(creditsChipText(stalled)).toBe(`2 credits${STALL_SEPARATOR}last turn stalled 66s (ModelOverloaded)`)
    expect(creditsChipText(stalled)).not.toContain("\n")

    expect(creditsChipText({ total: 2, unit: "credit", present: true })).toBe("2 credits")
    // a stalled turn that reported no credits still shows the summary next to the zero total
    expect(creditsChipText({ total: 0, unit: undefined, present: true, status: { stalledMs: 40_000 } })).toBe(
      `0${STALL_SEPARATOR}last turn stalled 40s`,
    )
    expect(creditsChipText({ total: 0, unit: undefined, present: false })).toBe("")
  })
})

// --- TUI setup/cleanup suite (two append claims: `sidebar.content` +
// `prompt.footer.status`; `ui.slot` takes a claim object) -----------------------
// The view modules lazy-import @opentui/solid inside setup. The box view is mocked
// as the test seam (marker node exposing the injected credits accessor + theme
// tokens); the chip view stays real against lightweight @opentui/solid + solid-js
// fakes so its single-line/collapse/theming behavior is testable without the
// Bun-native renderer. Host rendering itself is out of scope here.

/** Marker node returned by the mocked box-view factory; exposes accessor + tokens. */
interface FakeViewNode {
  kind: "credits-box"
  credits: () => SessionCredits
  tokens: unknown
}

/** Fake @opentui/solid DomNode: tag + props + inserted content accessors/children. */
interface FakeDomNode {
  tag: string
  props: Record<string, unknown>
  children: unknown[]
}

vi.mock("@opentui/solid", () => ({
  createElement: (tag: string): FakeDomNode => ({ tag, props: {}, children: [] }),
  setProp: (node: FakeDomNode, key: string, value: unknown): void => {
    node.props[key] = value
  },
  insert: (node: FakeDomNode, content: unknown): void => {
    node.children.push(content)
  },
  insertNode: (node: FakeDomNode, child: unknown): void => {
    node.children.push(child)
  },
}))

// Deterministic client-like solid semantics: plain Node resolves solid-js to the
// once-eval server build (frozen memos), so the fake keeps memos as pass-through
// accessors and signals as plain boxes — matching how the host's client build
// re-evaluates render-path reads.
vi.mock("solid-js", () => ({
  createMemo: <T>(fn: () => T): (() => T) => fn,
  createSignal: <T>(initial: T): [() => T, (next: T | ((prev: T) => T)) => T] => {
    let value = initial
    return [
      () => value,
      (next) => {
        value = typeof next === "function" ? (next as (prev: T) => T)(value) : next
        return value
      },
    ]
  },
}))

vi.mock("../src/tui/credits-box-view.js", () => ({
  createCreditsBoxView: (credits: () => SessionCredits, tokens: unknown): FakeViewNode => ({
    kind: "credits-box",
    credits,
    tokens,
  }),
}))

/** Minimal durable message shape served by the mock `data.session.message.list`. */
interface FixtureMessage {
  id: string
  type: string
  content?: ReadonlyArray<CreditPart>
}

/** Recorded `ui.slot` claim registration (claims API: one placement key + render). */
interface SlotRegistration {
  claim: Record<string, unknown>
  render: (props: Record<string, unknown>) => unknown
  unregisterCalls: number
}

interface MockTuiContext {
  context: {
    ui: { slot: (...args: unknown[]) => () => void }
    data: {
      on: (event: string, handler: (event: unknown) => void) => () => void
      session: {
        message: {
          list: (sessionID: string) => ReadonlyArray<FixtureMessage> | undefined
          sync: ReturnType<typeof vi.fn>
        }
      }
    }
    theme?: unknown
    storage?: { memory: ReturnType<typeof vi.fn> }
  }
  slots: SlotRegistration[]
  slotCalls: unknown[][]
  listeners: Array<{ event: string; handler: (event: unknown) => void; unsubscribeCalls: number }>
  sync: ReturnType<typeof vi.fn>
  memoryStores: Map<string, unknown>
}

/**
 * Mock TUI context: records slot-claim/listener registrations with
 * call-counting disposers and serves durable message fixtures from a mutable
 * table. `failUnregisterOf` makes that claim path's disposer throw (cleanup
 * aggregation). `theme` (feature-detected tokens) and `withMemoryStorage`
 * (TUI `storage.memory`) are opt-in — both absent by default so the fallback
 * paths stay the baseline under test.
 */
const makeTuiContext = (options?: {
  messages?: Record<string, ReadonlyArray<FixtureMessage>>
  failUnregisterOf?: string
  theme?: unknown
  withMemoryStorage?: boolean
}): MockTuiContext => {
  const slots: SlotRegistration[] = []
  const slotCalls: unknown[][] = []
  const listeners: Array<{ event: string; handler: (event: unknown) => void; unsubscribeCalls: number }> = []
  const sync = vi.fn()
  const memoryStores = new Map<string, unknown>()
  const context: MockTuiContext["context"] = {
    ui: {
      slot: (...args: unknown[]) => {
        slotCalls.push(args)
        const claim = args[0] as Record<string, unknown> & {
          render: (props: Record<string, unknown>) => unknown
        }
        const registration: SlotRegistration = { claim, render: claim.render, unregisterCalls: 0 }
        slots.push(registration)
        return () => {
          registration.unregisterCalls += 1
          if (options?.failUnregisterOf !== undefined && claim.append === options.failUnregisterOf)
            throw new Error(`unregister ${options.failUnregisterOf} failed`)
        }
      },
    },
    data: {
      on: (event, handler) => {
        const registration = { event, handler, unsubscribeCalls: 0 }
        listeners.push(registration)
        return () => {
          registration.unsubscribeCalls += 1
        }
      },
      session: { message: { list: (sessionID) => options?.messages?.[sessionID], sync } },
    },
  }
  if (options?.theme !== undefined) context.theme = options.theme
  if (options?.withMemoryStorage) {
    // memory-backed stores outlive one plugin generation: same key -> same store
    context.storage = {
      memory: vi.fn((key: string, opts: { initial: unknown }) => {
        if (!memoryStores.has(key)) memoryStores.set(key, opts.initial)
        return [memoryStores.get(key)]
      }),
    }
  }
  return { context, slots, slotCalls, listeners, sync, memoryStores }
}

/** Load the TUI plugin (box view mocked above) and run setup against a mock context. */
const setupPlugin = async (
  mock: MockTuiContext,
): Promise<() => Promise<void>> => {
  const { default: plugin } = await import("../src/tui")
  return (await plugin.setup(mock.context as never)) as () => Promise<void>
}

/** Find the registration claiming `append: path`. */
const claimFor = (mock: MockTuiContext, path: string): SlotRegistration => {
  const slot = mock.slots.find((registration) => registration.claim.append === path)
  expect(slot, `append claim for ${path} must be registered`).toBeDefined()
  return slot!
}

/** Render a registered slot claim and return its reactive accessor (view-or-null). */
const renderSlot = (mock: MockTuiContext, path: string, props: Record<string, unknown>): (() => unknown) =>
  claimFor(mock, path).render(props) as () => unknown

/** The box-view accessor for the sidebar claim (typed marker seam). */
const renderSidebar = (mock: MockTuiContext, props: Record<string, unknown>): (() => FakeViewNode | null) =>
  renderSlot(mock, "sidebar.content", props) as () => FakeViewNode | null

describe("tui setup registrations", () => {
  test("setup registers two append claims (sidebar.content + prompt.footer.status) and the text/reasoning ended listeners", async () => {
    const mock = makeTuiContext()

    const cleanup = await setupPlugin(mock)

    // box in the sidebar + chip in the prompt footer row, both additive
    // (`append` is the only placement key on each claim — never `replace`)
    expect(mock.slots.map((slot) => slot.claim.append)).toEqual(["sidebar.content", "prompt.footer.status"])
    for (const slot of mock.slots) {
      expect(Object.keys(slot.claim).sort()).toEqual(["append", "render"])
      expect(typeof slot.claim.render).toBe("function")
    }
    // credits and stall status ride whichever part closes the turn, so both ended
    // events feed the same recording path
    expect(mock.listeners.map((listener) => listener.event)).toEqual(["session.text.ended", "session.reasoning.ended"])
    await cleanup()
  })

  test("no old-signature slot calls: every registration is a single claim object", async () => {
    const mock = makeTuiContext()

    const cleanup = await setupPlugin(mock)

    // the host only accepts a claim object; a string first arg or a second
    // render arg would silently no-op in the host
    expect(mock.slotCalls).toHaveLength(2)
    for (const args of mock.slotCalls) {
      expect(args).toHaveLength(1)
      expect(typeof args[0]).toBe("object")
    }
    await cleanup()
  })

  test("text-ended handler records to the store; malformed payloads never throw", async () => {
    // durable text part has no state (the live reducer bug this handler works around)
    const mock = makeTuiContext({
      messages: { sess: [{ id: "msg_1", type: "assistant", content: [{ type: "text", text: "live" }] }] },
    })
    const cleanup = await setupPlugin(mock)
    const handler = mock.listeners[0]!.handler
    const credits = renderSidebar(mock, { sessionID: "sess" })

    expect(credits()).toBeNull() // nothing recorded yet -> surface withheld

    handler({ data: { sessionID: "sess", assistantMessageID: "msg_1", ordinal: 0, state: { credits: 5, creditsUnit: "credit" } } })
    const view = credits()
    expect(view).not.toBeNull()
    expect(view!.credits()).toEqual({ total: 5, unit: "credit", present: true })

    // never-throw discipline: garbage payloads are swallowed and change nothing
    const malformed = [undefined, null, 42, "nope", {}, { data: null }, { data: { state: { credits: 1 } } }]
    for (const payload of malformed) {
      expect(() => handler(payload)).not.toThrow()
    }
    expect(credits()!.credits()).toEqual({ total: 5, unit: "credit", present: true })
    await cleanup()
  })

  test("render data assembly = reconcile + merge; durable stays authoritative", async () => {
    const messages: Record<string, ReadonlyArray<FixtureMessage>> = {
      sess: [
        { id: "msg_user", type: "user", content: [] },
        { id: "msg_1", type: "assistant", content: [statePart("text", { credits: 1, creditsUnit: "credit" })] },
        { id: "msg_2", type: "assistant", content: [{ type: "text", text: "no state yet" }] },
      ],
    }
    const mock = makeTuiContext({ messages })
    const cleanup = await setupPlugin(mock)
    const handler = mock.listeners[0]!.handler
    // stale transient for msg_1 (durable already carries 1) + live transient for msg_2
    handler({ data: { sessionID: "sess", assistantMessageID: "msg_1", ordinal: 0, state: { credits: 99, creditsUnit: "credit" } } })
    handler({ data: { sessionID: "sess", assistantMessageID: "msg_2", ordinal: 0, state: { credits: 2, creditsUnit: "credit" } } })

    const sidebar = renderSidebar(mock, { sessionID: "sess" })

    // durable 1 (authoritative over stale 99) + transient 2; never 1+99+2
    const expected: SessionCredits = { total: 3, unit: "credit", present: true }
    expect(sidebar()!.credits()).toEqual(expected)
    expect(sidebar()!.kind).toBe("credits-box")
    // assembly never forces a durable sync (explicit-refresh fallback only)
    expect(mock.sync).not.toHaveBeenCalled()
    // session-less props contribute nothing (both surfaces; on the footer chip
    // sessionID is optional in PromptFooterInput — absent means withheld, not a crash)
    expect(renderSidebar(mock, {})()).toBeNull()
    expect((renderSlot(mock, "prompt.footer.status", { mode: "normal" }) as () => unknown)()).toBeNull()
    await cleanup()
  })
})

describe("footer chip claim (prompt.footer.status)", () => {
  const chipAccessor = (mock: MockTuiContext, props: Record<string, unknown>): (() => FakeDomNode | null) =>
    renderSlot(mock, "prompt.footer.status", props) as () => FakeDomNode | null

  test("chip renders one single-line non-shrinking text node carrying credits + unit", async () => {
    const mock = makeTuiContext({
      messages: {
        sess: [{ id: "msg_1", type: "assistant", content: [statePart("text", { credits: 1.5, creditsUnit: "credit" })] }],
      },
    })
    const cleanup = await setupPlugin(mock)

    const chip = chipAccessor(mock, { sessionID: "sess", mode: "normal" })()

    expect(chip).not.toBeNull()
    // real chip view against the fake renderer: one <text> node, hard-bounded to a
    // single row, whose content accessor yields the formatted rollup. flexShrink 0
    // keeps the short credits string intact in the footer row — the host status box
    // beside it is the shrinkable one.
    expect(chip!.tag).toBe("text")
    expect(chip!.props.height).toBe(1)
    expect(chip!.props.wrapMode).toBe("none")
    expect(chip!.props.flexShrink).toBe(0)
    expect(chip!.children).toHaveLength(1)
    const content = chip!.children[0] as () => string
    expect(content()).toBe("1.5 credits")
    expect(content()).not.toContain("\n")
    await cleanup()
  })

  test("chip collapses to empty for credit-less sessions", async () => {
    const mock = makeTuiContext({
      messages: { sess: [{ id: "msg_1", type: "assistant", content: [{ type: "text", text: "plain" }] }] },
    })
    const cleanup = await setupPlugin(mock)

    // no credit state anywhere: tui.ts withholds the node entirely
    expect(chipAccessor(mock, { sessionID: "sess", mode: "normal" })()).toBeNull()
    await cleanup()
  })

  test("optional sessionID: absent sessionID withholds the chip (PromptFooterInput shape)", async () => {
    // `prompt.footer.status` props are `{ sessionID?: string; mode: "normal" | "shell" }`
    // — unlike the sidebar, sessionID may legitimately be absent (home/no-session
    // footer). The chip is withheld, never crashed.
    const mock = makeTuiContext({
      messages: {
        sess: [{ id: "msg_1", type: "assistant", content: [statePart("text", { credits: 2, creditsUnit: "credit" })] }],
      },
    })
    const cleanup = await setupPlugin(mock)

    expect(chipAccessor(mock, { mode: "normal" })()).toBeNull()
    expect(chipAccessor(mock, { mode: "shell" })()).toBeNull()
    // empty-string sessionID is also "no session"
    expect(chipAccessor(mock, { sessionID: "", mode: "normal" })()).toBeNull()
    await cleanup()
  })

  test("mode behavior: chip renders identically in normal and shell modes (mode ignored)", async () => {
    // Decision (documented in tui.ts): the chip renders in both modes — the host's
    // footer children don't change by mode, and collapsing on shell toggle would
    // only cause a layout jump.
    const mock = makeTuiContext({
      messages: {
        sess: [{ id: "msg_1", type: "assistant", content: [statePart("text", { credits: 3, creditsUnit: "credit" })] }],
      },
    })
    const cleanup = await setupPlugin(mock)

    for (const mode of ["normal", "shell"] as const) {
      const chip = chipAccessor(mock, { sessionID: "sess", mode })()
      expect(chip).not.toBeNull()
      expect((chip!.children[0] as () => string)()).toBe("3 credits")
    }
    await cleanup()
  })
})

describe("stall summary on the credits surfaces", () => {
  const STALLED_STATE = { credits: 2, creditsUnit: "credit", status: { stalledMs: 66_000, hint: OVERLOADED_HINT } }

  const chipText = (mock: MockTuiContext): string | null => {
    const chip = (renderSlot(mock, "prompt.footer.status", { sessionID: "sess", mode: "normal" }) as () => FakeDomNode | null)()
    return chip === null ? null : (chip.children[0] as () => string)()
  }

  /**
   * The box view is mocked file-wide as the setup seam; the real view is loaded here against
   * the fake renderer and fed the accessor the sidebar claim assembled, so the rendered lines
   * are checked against the same data the host would render.
   */
  const boxLines = async (mock: MockTuiContext): Promise<string[]> => {
    const { createCreditsBoxView } = await vi.importActual<typeof import("../src/tui/credits-box-view")>(
      "../src/tui/credits-box-view.js",
    )
    const marker = renderSidebar(mock, { sessionID: "sess" })()
    expect(marker).not.toBeNull()
    const root = createCreditsBoxView(marker!.credits) as unknown as FakeDomNode
    return root.children.map((line) => {
      const node = line as FakeDomNode
      // the header wraps its content in a <b> node; plain lines carry the accessor directly
      const content = node.children[0]
      const accessor = typeof content === "function" ? content : (content as FakeDomNode).children[0]
      return (accessor as () => string)()
    })
  }

  test("chip and box render the last turn's stall summary with the seconds and the reason", async () => {
    const mock = makeTuiContext({
      messages: { sess: [{ id: "msg_1", type: "assistant", content: [statePart("text", STALLED_STATE)] }] },
    })
    const cleanup = await setupPlugin(mock)

    const chip = chipText(mock)
    expect(chip).toBe("2 credits · last turn stalled 66s (ModelOverloaded)")
    expect(chip).toContain("66s")
    expect(chip).toContain("ModelOverloaded")
    expect(chip).not.toContain("\n")

    // box: header, total, then the summary on its own third line
    expect(await boxLines(mock)).toEqual(["Kiro", "2 credits", "last turn stalled 66s (ModelOverloaded)"])
    await cleanup()
  })

  test("absent or malformed status shows no summary, the credits stay, and nothing throws", async () => {
    const states: Array<Record<string, unknown>> = [
      { credits: 1, creditsUnit: "credit" },
      { credits: 1, creditsUnit: "credit", status: {} },
      { credits: 1, creditsUnit: "credit", status: "bad" },
      { credits: 1, creditsUnit: "credit", status: { stalledMs: 0 } },
      { credits: 1, creditsUnit: "credit", status: { stalledMs: "66" } },
    ]
    for (const state of states) {
      const mock = makeTuiContext({
        messages: { sess: [{ id: "msg_1", type: "assistant", content: [statePart("text", state)] }] },
      })
      const cleanup = await setupPlugin(mock)

      expect(chipText(mock)).toBe("1 credit")
      expect(await boxLines(mock)).toEqual(["Kiro", "1 credit", ""]) // third line stays empty
      // a live event carrying the same malformed status is swallowed too
      const handler = mock.listeners[0]!.handler
      expect(() => handler({ data: { sessionID: "sess", assistantMessageID: "msg_1", ordinal: 1, state } })).not.toThrow()
      expect(chipText(mock)).toBe("1 credit")
      await cleanup()
    }
  })

  test("status without credits is recorded from the ended event and the summary still renders", async () => {
    // durable text part without state (live reducer drops it); the ended event carries only a status
    const mock = makeTuiContext({
      messages: { sess: [{ id: "msg_1", type: "assistant", content: [{ type: "text", text: "live" }] }] },
    })
    const cleanup = await setupPlugin(mock)
    expect(chipText(mock)).toBeNull() // nothing recorded yet

    const textEnded = mock.listeners.find((listener) => listener.event === "session.text.ended")!
    textEnded.handler({ data: { sessionID: "sess", assistantMessageID: "msg_1", ordinal: 0, state: { status: { stalledMs: 40_000 } } } })

    // the surfaces appear on status alone: a stalled turn is kiro metadata even without credits
    expect(chipText(mock)).toBe("0 · last turn stalled 40s")
    expect(renderSidebar(mock, { sessionID: "sess" })()!.credits()).toEqual({
      total: 0,
      unit: undefined,
      present: true,
      status: { stalledMs: 40_000 },
    })
    await cleanup()
  })

  test("status carried only by the reasoning-ended event is recorded and rendered", async () => {
    // a stall notice still open at turn end: the SDK closes that reasoning part with the
    // metadata and no text-ended event carries it
    const mock = makeTuiContext({
      messages: {
        sess: [{ id: "msg_1", type: "assistant", content: [{ type: "reasoning", text: "Kiro: no output for 30s" }, { type: "text", text: "answer" }] }],
      },
    })
    const cleanup = await setupPlugin(mock)
    const reasoningEnded = mock.listeners.find((listener) => listener.event === "session.reasoning.ended")
    expect(reasoningEnded).toBeDefined()

    reasoningEnded!.handler({
      data: { sessionID: "sess", assistantMessageID: "msg_1", ordinal: 0, state: STALLED_STATE },
    })

    expect(chipText(mock)).toBe("2 credits · last turn stalled 66s (ModelOverloaded)")
    expect(await boxLines(mock)).toEqual(["Kiro", "2 credits", "last turn stalled 66s (ModelOverloaded)"])
    await cleanup()
  })

  test("a clean later turn clears the stall summary while the credits keep summing", async () => {
    const messages: Record<string, FixtureMessage[]> = {
      sess: [{ id: "msg_1", type: "assistant", content: [statePart("text", STALLED_STATE)] }],
    }
    const mock = makeTuiContext({ messages })
    const cleanup = await setupPlugin(mock)
    expect(chipText(mock)).toBe("2 credits · last turn stalled 66s (ModelOverloaded)")

    // the next turn completes without a stall (durable message appended)
    messages.sess!.push({ id: "msg_2", type: "assistant", content: [statePart("text", { credits: 3, creditsUnit: "credit" })] })

    expect(chipText(mock)).toBe("5 credits")
    expect(chipText(mock)).not.toContain("stalled")
    expect(await boxLines(mock)).toEqual(["Kiro", "5 credits", ""])

    // and a stall on the following turn brings the summary back for that turn only
    messages.sess!.push({ id: "msg_3", type: "assistant", content: [statePart("text", { credits: 1, creditsUnit: "credit", status: { stalledMs: 30_000 } })] })
    expect(chipText(mock)).toBe("6 credits · last turn stalled 30s")
    await cleanup()
  })
})

describe("theme feature detection", () => {
  const THEME = { text: { default: "#e0e0e0", subdued: "#808080" } }
  const KIRO_MESSAGES: Record<string, ReadonlyArray<FixtureMessage>> = {
    sess: [{ id: "msg_1", type: "assistant", content: [statePart("text", { credits: 2, creditsUnit: "credit" })] }],
  }

  test("context.theme tokens flow into both views when present", async () => {
    const mock = makeTuiContext({ messages: KIRO_MESSAGES, theme: THEME })
    const cleanup = await setupPlugin(mock)

    const box = renderSidebar(mock, { sessionID: "sess" })()
    expect(box!.tokens).toEqual({ default: "#e0e0e0", subdued: "#808080" })

    const chip = (renderSlot(mock, "prompt.footer.status", { sessionID: "sess", mode: "normal" }) as () => FakeDomNode | null)()
    expect(chip!.props.fg).toBe("#808080") // chip stays subdued beside the host status text
    await cleanup()
  })

  test("absent or misshapen theme falls back to default styling without throwing", async () => {
    // rendering never depends on the theme: no theme and junk themes
    // behave identically — no tokens, no fg, no throw
    for (const theme of [undefined, null, 42, "dark", {}, { text: null }, { text: { default: "", subdued: 7 } }]) {
      const mock = makeTuiContext({ messages: KIRO_MESSAGES, ...(theme !== undefined ? { theme } : {}) })
      const cleanup = await setupPlugin(mock)

      const box = renderSidebar(mock, { sessionID: "sess" })()
      expect(box!.tokens).toBeUndefined()

      const chip = (renderSlot(mock, "prompt.footer.status", { sessionID: "sess", mode: "normal" }) as () => FakeDomNode | null)()
      expect(chip).not.toBeNull()
      expect("fg" in chip!.props).toBe(false)
      await cleanup()
    }
  })
})

describe("storage.memory feature detection", () => {
  test("memory-backed store is keyed 'transient-credits' and survives cleanup by design", async () => {
    const mock = makeTuiContext({
      messages: { sess: [{ id: "msg_1", type: "assistant", content: [{ type: "text", text: "live" }] }] },
      withMemoryStorage: true,
    })
    const cleanup = await setupPlugin(mock)
    expect(mock.context.storage!.memory).toHaveBeenCalledTimes(1)
    expect(mock.context.storage!.memory).toHaveBeenCalledWith("transient-credits", expect.objectContaining({ initial: expect.anything() }))

    const handler = mock.listeners[0]!.handler
    handler({ data: { sessionID: "sess", assistantMessageID: "msg_1", ordinal: 0, state: { credits: 5, creditsUnit: "credit" } } })
    const credits = renderSidebar(mock, { sessionID: "sess" })
    expect(credits()!.credits().total).toBe(5)

    await cleanup()

    // the memory store is shared with the next plugin generation (hot reload),
    // so cleanup must not clear it — a fresh setup on the same storage still
    // sees the recorded transient credits
    const rerun = await setupPlugin(mock)
    expect(renderSidebar(mock, { sessionID: "sess" })!()!.credits().total).toBe(5)
    await rerun()
  })

  test("fallback per-setup store (no storage.memory) still clears on cleanup", async () => {
    const mock = makeTuiContext({
      messages: { sess: [{ id: "msg_1", type: "assistant", content: [{ type: "text", text: "live" }] }] },
    })
    const cleanup = await setupPlugin(mock)
    const handler = mock.listeners[0]!.handler
    handler({ data: { sessionID: "sess", assistantMessageID: "msg_1", ordinal: 0, state: { credits: 5, creditsUnit: "credit" } } })
    const credits = renderSidebar(mock, { sessionID: "sess" })
    expect(credits()!.credits().total).toBe(5)

    await cleanup()

    expect(credits()).toBeNull() // per-setup store emptied on cleanup
  })
})

describe("tui cleanup", () => {
  test("cleanup disposes both claims and the listener, clears the store, aggregates failures, and is idempotent", async () => {
    const mock = makeTuiContext({
      messages: { sess: [{ id: "msg_1", type: "assistant", content: [{ type: "text", text: "live" }] }] },
      failUnregisterOf: "sidebar.content",
    })
    const cleanup = await setupPlugin(mock)
    const handler = mock.listeners[0]!.handler
    handler({ data: { sessionID: "sess", assistantMessageID: "msg_1", ordinal: 0, state: { credits: 5, creditsUnit: "credit" } } })
    const credits = renderSidebar(mock, { sessionID: "sess" })
    expect(credits()!.credits().total).toBe(5) // transient state present before cleanup

    // one claim's disposer throws: every other disposer still runs, failures aggregate
    await expect(cleanup()).rejects.toSatisfy(
      (error: unknown) => error instanceof AggregateError && error.errors.length === 1,
    )

    // both claims (sidebar box + footer chip) unregistered exactly once
    expect(mock.slots).toHaveLength(2)
    for (const slot of mock.slots) expect(slot.unregisterCalls).toBe(1)
    expect(mock.listeners[0]!.unsubscribeCalls).toBe(1)
    // the store's clear disposer ran despite the claim failure
    expect(credits()).toBeNull()

    // second call is a no-op: resolves, and no disposer runs twice
    await expect(cleanup()).resolves.toBeUndefined()
    for (const slot of mock.slots) expect(slot.unregisterCalls).toBe(1)
    expect(mock.listeners[0]!.unsubscribeCalls).toBe(1)
  })
})

describe("dist/tui.js module isolation", () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

  /**
   * Import the built module via a runtime URL so tsc never resolves dist/. The
   * import succeeding under plain Node is the lazy-@opentui/core contract: the
   * Bun-native TUI runtime only loads when the host runs setup().
   */
  const importDist = (name: string): Promise<Record<string, unknown>> =>
    import(pathToFileURL(join(ROOT, "dist", name)).href) as Promise<Record<string, unknown>>

  test("dist/tui.js loads under plain Node with the { id, setup } shape", async () => {
    const mod = await importDist("tui.js")

    const plugin = mod.default as Record<string, unknown>
    expect(Object.keys(plugin).sort()).toEqual(["id", "setup"])
    expect(plugin.id).toBe("opencode-kiro")
    expect(typeof plugin.setup).toBe("function")
    expect("server" in mod).toBe(false)
  })
})
