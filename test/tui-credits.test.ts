import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { describe, expect, test, vi } from "vitest"
import {
  creditsForMessage,
  formatCredits,
  messageCredits,
  readPartCredits,
  spendLines,
  sumSessionCredits,
  type CreditMessage,
  type CreditPart,
  type SessionCredits,
} from "../src/tui/credits"

// Credit-helper + TUI wiring tests (task 11). Fixtures are plain content-part
// shaped objects carrying key-unwrapped v2 state (`part.state.credits` /
// `part.state.creditsUnit`) - never `part.state.kiro` and never the v1
// `part.metadata.kiro` (both are forbidden read shapes). Core hazard is dual
// emission: one message carries the same turn total on its text and reasoning
// parts, so credits count once per message (last carrier wins).

/** Part-shaped fixture carrying key-unwrapped v2 credit state. */
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
    // v2 core stores metadata[providerMetadataKey] key-unwrapped; a provider-keyed
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

  test("BOTH: cost>0 AND credits present => two stacked lines (dollars then credits)", () => {
    expect(spendLines({ cost: 5, credits: sc({ total: 100, unit: "credit", present: true }) })).toEqual([
      "$5.00 spent",
      "100 credits",
    ])
  })

  test("empty: cost 0 with no credits => '$0.00 spent'", () => {
    expect(spendLines({ cost: 0, credits: sc() })).toEqual(["$0.00 spent"])
  })

  test("BOTH singular: pluralization reuses formatCredits (total 1 => '1 credit')", () => {
    expect(spendLines({ cost: 5, credits: sc({ total: 1, unit: "credit", present: true }) })).toEqual([
      "$5.00 spent",
      "1 credit",
    ])
  })

  test("BOTH unit-less: bare number on the credits line", () => {
    expect(spendLines({ cost: 5, credits: sc({ total: 12, unit: undefined, present: true }) })).toEqual([
      "$5.00 spent",
      "12",
    ])
  })

  test("zero-credit-but-present Kiro turn WITH cost>0 stays in the BOTH branch", () => {
    expect(spendLines({ cost: 5, credits: sc({ total: 0, unit: "credit", present: true }) })).toEqual([
      "$5.00 spent",
      "0 credits",
    ])
  })

  test("zero-credit-but-present Kiro turn with cost 0 stays in the credits-only branch", () => {
    expect(spendLines({ cost: 0, credits: sc({ total: 0, unit: "credit", present: true }) })).toEqual(["0 credits"])
  })
})

// --- TUI setup/cleanup suite (task 10 wiring; sidebar-only since the iteration-2
// re-pin removed session.composer.top from the typed SlotMap) -----------------
// The view module lazy-imports @opentui/solid inside setup; tests exercise
// setup/cleanup and render-path DATA ASSEMBLY, never actual view rendering
// (host rendering is task 13's scope). The mock below is the test seam: it
// returns a marker node that exposes the credits accessor tui.ts passes in.

/** Marker node returned by the mocked view factory; exposes the injected accessor. */
interface FakeViewNode {
  kind: "credits-box"
  credits: () => SessionCredits
}

vi.mock("../src/tui/credits-box-view.js", () => ({
  createCreditsBoxView: (credits: () => SessionCredits): FakeViewNode => ({ kind: "credits-box", credits }),
}))

/** Minimal durable v2 message shape served by the mock `data.session.message.list`. */
interface FixtureMessage {
  id: string
  type: string
  content?: ReadonlyArray<CreditPart>
}

interface SlotRegistration {
  name: string
  render: (props: Record<string, unknown>) => unknown
  unregisterCalls: number
}

interface MockTuiContext {
  context: {
    ui: { slot: (name: string, render: (props: Record<string, unknown>) => unknown) => () => void }
    data: {
      on: (event: string, handler: (event: unknown) => void) => () => void
      session: {
        message: {
          list: (sessionID: string) => ReadonlyArray<FixtureMessage> | undefined
          sync: ReturnType<typeof vi.fn>
        }
      }
    }
  }
  slots: SlotRegistration[]
  listeners: Array<{ event: string; handler: (event: unknown) => void; unsubscribeCalls: number }>
  sync: ReturnType<typeof vi.fn>
}

/**
 * Mock TUI context: records slot/listener registrations with call-counting
 * disposers and serves durable message fixtures from a mutable table.
 * `failUnregisterOf` makes that slot's disposer throw (cleanup aggregation).
 */
const makeTuiContext = (options?: {
  messages?: Record<string, ReadonlyArray<FixtureMessage>>
  failUnregisterOf?: string
}): MockTuiContext => {
  const slots: SlotRegistration[] = []
  const listeners: Array<{ event: string; handler: (event: unknown) => void; unsubscribeCalls: number }> = []
  const sync = vi.fn()
  const context: MockTuiContext["context"] = {
    ui: {
      slot: (name, render) => {
        const registration: SlotRegistration = { name, render, unregisterCalls: 0 }
        slots.push(registration)
        return () => {
          registration.unregisterCalls += 1
          if (options?.failUnregisterOf === name) throw new Error(`unregister ${name} failed`)
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
  return { context, slots, listeners, sync }
}

/** Load the TUI plugin (views mocked above) and run setup against a mock context. */
const setupPlugin = async (
  mock: MockTuiContext,
): Promise<() => Promise<void>> => {
  const { default: plugin } = await import("../src/tui")
  return (await plugin.setup(mock.context as never)) as () => Promise<void>
}

/** Render a registered slot and return its reactive accessor (view-or-null). */
const renderSlot = (mock: MockTuiContext, name: string, props: Record<string, unknown>): (() => FakeViewNode | null) => {
  const slot = mock.slots.find((registration) => registration.name === name)
  expect(slot, `slot ${name} must be registered`).toBeDefined()
  return slot!.render(props) as () => FakeViewNode | null
}

describe("tui setup registrations", () => {
  test("setup registers exactly one slot (sidebar.content) and one text-ended listener", async () => {
    const mock = makeTuiContext()

    const cleanup = await setupPlugin(mock)

    // sidebar-only surface: the pinned SHA's typed SlotMap has no session.composer.top
    expect(mock.slots.map((slot) => slot.name)).toEqual(["sidebar.content"])
    expect(mock.listeners).toHaveLength(1)
    expect(mock.listeners[0]!.event).toBe("session.text.ended")
    await cleanup()
  })

  test("text-ended handler records to the store; malformed payloads never throw", async () => {
    // durable text part has NO state (the live reducer bug this handler works around)
    const mock = makeTuiContext({
      messages: { sess: [{ id: "msg_1", type: "assistant", content: [{ type: "text", text: "live" }] }] },
    })
    const cleanup = await setupPlugin(mock)
    const handler = mock.listeners[0]!.handler
    const credits = renderSlot(mock, "sidebar.content", { sessionID: "sess" })

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

    const sidebar = renderSlot(mock, "sidebar.content", { sessionID: "sess" })

    // durable 1 (authoritative over stale 99) + transient 2; never 1+99+2
    const expected: SessionCredits = { total: 3, unit: "credit", present: true }
    expect(sidebar()!.credits()).toEqual(expected)
    expect(sidebar()!.kind).toBe("credits-box")
    // assembly never forces a durable sync (explicit-refresh fallback only)
    expect(mock.sync).not.toHaveBeenCalled()
    // session-less props contribute nothing
    expect(renderSlot(mock, "sidebar.content", {})()).toBeNull()
    await cleanup()
  })
})

describe("tui cleanup", () => {
  test("cleanup unregisters everything, clears the store, aggregates failures, and is idempotent", async () => {
    const mock = makeTuiContext({
      messages: { sess: [{ id: "msg_1", type: "assistant", content: [{ type: "text", text: "live" }] }] },
      failUnregisterOf: "sidebar.content",
    })
    const cleanup = await setupPlugin(mock)
    const handler = mock.listeners[0]!.handler
    handler({ data: { sessionID: "sess", assistantMessageID: "msg_1", ordinal: 0, state: { credits: 5, creditsUnit: "credit" } } })
    const credits = renderSlot(mock, "sidebar.content", { sessionID: "sess" })
    expect(credits()!.credits().total).toBe(5) // transient state present before cleanup

    // one disposer throws: every other disposer still runs, failures aggregate
    await expect(cleanup()).rejects.toSatisfy(
      (error: unknown) => error instanceof AggregateError && error.errors.length === 1,
    )

    for (const slot of mock.slots) expect(slot.unregisterCalls).toBe(1)
    expect(mock.listeners[0]!.unsubscribeCalls).toBe(1)
    // the store's clear disposer ran despite the slot failure
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

  test("dist/tui.js loads under plain Node with the v2 { id, setup } shape", async () => {
    const mod = await importDist("tui.js")

    const plugin = mod.default as Record<string, unknown>
    expect(Object.keys(plugin).sort()).toEqual(["id", "setup"])
    expect(plugin.id).toBe("opencode-kiro")
    expect(typeof plugin.setup).toBe("function")
    expect("server" in mod).toBe(false)
  })
})
