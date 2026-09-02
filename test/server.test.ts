import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import type { Plugin } from "@opencode-ai/plugin"
import type { AuthStatus, ModelWithEfforts } from "kiro-acp-ai-provider"
import { createKiroAcp, listModels, verifyAuthAsync } from "kiro-acp-ai-provider"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import serverPlugin from "../src/server"

// v2 behavior suite (task 08). Everything is driven through
// `serverPlugin.setup(mockContext)` plus module mocks — never through module
// internals. Assertions come from the acceptance criteria of tasks 05/06/07
// and the migration doc's Test matrix (Auth/Models/Variants/AISDK/Lifecycle).

// Hermetic: the SDK is mocked so no kiro-cli is ever spawned and no network is
// touched; child_process.execFile is mocked so the login flow gets a fake
// killable child; login poll/timeout tests use fake timers. The mock exposes
// ONLY the async probe (beta.4 Item 3): production must never reach for the
// sync `verifyAuth` again, and a regression would fail here as a missing export.
vi.mock("kiro-acp-ai-provider", () => ({
  verifyAuthAsync: vi.fn(),
  listModels: vi.fn(),
  createKiroAcp: vi.fn(),
}))
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}))

const mockVerifyAuthAsync = vi.mocked(verifyAuthAsync)
const mockListModels = vi.mocked(listModels)
const mockCreateKiroAcp = vi.mocked(createKiroAcp)
const mockExecFile = vi.mocked(execFile)

// ---------------------------------------------------------------------------
// shared harness
// ---------------------------------------------------------------------------

/** fake killable login child returned by the mocked execFile */
function makeFakeChild() {
  return { kill: vi.fn(() => true), killed: false }
}

/** owned SDK instances created by the mocked createKiroAcp, in creation order */
let sdkInstances: Array<{
  languageModel: ReturnType<typeof vi.fn>
  shutdown: ReturnType<typeof vi.fn>
}> = []

function makeSdkInstance() {
  const instance = {
    languageModel: vi.fn((modelId: string) => ({ modelId })),
    shutdown: vi.fn(async () => {}),
  }
  sdkInstances.push(instance)
  return instance
}

/**
 * Controllable async event stream backing `context.event.subscribe()`.
 * `push()` delivers one event to the (single) consumer; `return()` is a spy so
 * cleanup's iterator shutdown is observable.
 */
function createEventStream() {
  const queue: unknown[] = []
  let notify: (() => void) | undefined
  let ended = false
  const wake = () => {
    const resolve = notify
    notify = undefined
    resolve?.()
  }
  const returned = vi.fn(async () => {
    ended = true
    wake()
    return { value: undefined, done: true as const }
  })
  const iterator = {
    async next(): Promise<IteratorResult<unknown>> {
      while (true) {
        if (queue.length > 0) return { value: queue.shift(), done: false }
        if (ended) return { value: undefined, done: true }
        await new Promise<void>((resolve) => {
          notify = resolve
        })
      }
    },
    return: returned,
    [Symbol.asyncIterator]() {
      return this
    },
  }
  return {
    iterable: iterator as AsyncIterable<unknown>,
    push(event: unknown) {
      queue.push(event)
      wake()
    },
    returned,
  }
}

/** hand-built IntegrationDraft mock recording upserts + method registrations */
function makeIntegrationDraft() {
  const integrations = new Map<string, { id: string; name: string }>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods: any[] = []
  const draft = {
    list: () => [...integrations.values()],
    get: (id: string) => integrations.get(id),
    update(id: string, update: (integration: { id: string; name: string }) => void) {
      const record = integrations.get(id) ?? { id, name: "" }
      update(record)
      integrations.set(id, record)
    },
    remove(id: string) {
      integrations.delete(id)
    },
    method: {
      list: () => [],
      update(registration: unknown) {
        methods.push(registration)
      },
      remove() {},
    },
  }
  return { draft, integrations, methods }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MutableCatalogModel = any
type CatalogProviderRecord = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider: any
  models: Map<string, MutableCatalogModel>
}

/**
 * Hand-built CatalogDraft mock. `provider.get` never upserts (matches the
 * installed d.ts contract the transform relies on to detect a rich models.dev
 * entry); `provider.update`/`model.update` initialize missing records.
 */
function makeCatalogDraft() {
  const providers = new Map<string, CatalogProviderRecord>()
  const ensureProvider = (providerID: string): CatalogProviderRecord => {
    let record = providers.get(providerID)
    if (record === undefined) {
      record = { provider: { id: providerID, name: "", settings: {} }, models: new Map() }
      providers.set(providerID, record)
    }
    return record
  }
  const ensureModel = (providerID: string, modelID: string): MutableCatalogModel => {
    const record = ensureProvider(providerID)
    let model = record.models.get(modelID)
    if (model === undefined) {
      model = {
        modelID,
        name: "",
        variants: [],
        settings: {},
        limit: { context: 0, output: 0 },
      }
      record.models.set(modelID, model)
    }
    return model
  }
  const draft = {
    provider: {
      list: () => [...providers.values()],
      get: (providerID: string) => providers.get(providerID),
      update(providerID: string, update: (provider: unknown) => void) {
        update(ensureProvider(providerID).provider)
      },
      remove(providerID: string) {
        providers.delete(providerID)
      },
    },
    model: {
      get: (providerID: string, modelID: string) => providers.get(providerID)?.models.get(modelID),
      update(providerID: string, modelID: string, update: (model: MutableCatalogModel) => void) {
        update(ensureModel(providerID, modelID))
      },
      remove(providerID: string, modelID: string) {
        providers.get(providerID)?.models.delete(modelID)
      },
      default: { get: () => undefined, set: () => {} },
    },
  }
  return { draft, providers, ensureModel }
}

/** seed a rich models.dev-style Kiro entry into a catalog draft mock */
function seedRichKiro(
  catalog: ReturnType<typeof makeCatalogDraft>,
  models: Array<{ key: string; modelID: string; [extra: string]: unknown }>,
) {
  for (const { key, modelID, ...extra } of models) {
    const model = catalog.ensureModel("kiro", key)
    model.modelID = modelID
    Object.assign(model, extra)
  }
}

/** runtime ModelWithEfforts factory */
function runtime(modelId: string, over: Partial<ModelWithEfforts> = {}): ModelWithEfforts {
  return { modelId, name: modelId, runtimeEfforts: [], ...over }
}

const tmpDirs: string[] = []

/**
 * Mock v2 plugin context: records the registered integration/catalog transform
 * callbacks and the sdk hook callback, exposes controllable connection state,
 * a spied reload, a controllable event stream, and per-registration disposer
 * spies. `integration.list()` yields a hermetic temp directory location.
 *
 * `options` is ABSENT by default (the key is not even present) — that absence
 * is the witness for the `context.options ?? {}` guard in src/server.ts, so
 * every pre-existing test keeps exercising it. Item 6 tests opt in via
 * `makeMockContext({ options: {...} })`.
 */
function makeMockContext(init: { options?: Record<string, unknown> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "kiro-v2-test-"))
  tmpDirs.push(directory)

  let integrationTransformCb: ((draft: unknown) => void) | undefined
  let catalogTransformCb: ((draft: unknown) => void) | undefined
  // aisdk registrations stored BY HOOK NAME: setup registers both the "sdk"
  // and the "language" hooks (beta.4 atom), each with its own dispose spy so
  // per-registration exactly-once disposal is observable.
  const aisdkHooks = new Map<
    string,
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cb: (event: any) => Promise<void> | void
      options: unknown
      dispose: ReturnType<typeof vi.fn>
    }
  >()

  const disposeSpies = {
    integration: vi.fn(async () => {}),
    catalog: vi.fn(async () => {}),
    // shared hook-disposal knob: every per-registration dispose spy delegates
    // here so failure injection (mockRejectedValue) hits all hook disposers
    hook: vi.fn(async () => {}),
  }
  const reload = vi.fn(async () => {})
  const active = vi.fn(async (): Promise<unknown> => undefined)
  const events = createEventStream()

  const raw = {
    integration: {
      transform: vi.fn(async (cb: (draft: unknown) => void) => {
        integrationTransformCb = cb
        return { dispose: disposeSpies.integration }
      }),
      list: vi.fn(async () => ({ location: { directory } })),
      connection: { active, resolve: vi.fn(async () => undefined) },
    },
    catalog: {
      transform: vi.fn(async (cb: (draft: unknown) => void) => {
        catalogTransformCb = cb
        return { dispose: disposeSpies.catalog }
      }),
      reload,
    },
    aisdk: {
      // dev-17968 signature: hook(name, cb, options?) with ModelHookOptions {providerID?}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hook: vi.fn(async (name: string, cb: (event: any) => Promise<void> | void, options?: unknown) => {
        const dispose = vi.fn(async () => disposeSpies.hook())
        aisdkHooks.set(name, { cb, options, dispose })
        return { dispose }
      }),
    },
    event: { subscribe: vi.fn(() => events.iterable) },
    // present ONLY when a test opts in — see the docblock above
    ...(init.options !== undefined ? { options: init.options } : {}),
  }

  return {
    context: raw as unknown as Plugin.Context,
    raw,
    directory,
    reload,
    active,
    events,
    disposeSpies,
    /** aisdk hook registrations by name ("sdk" / "language") */
    hooks: aisdkHooks,
    integrationTransform: (draft: unknown) => {
      if (integrationTransformCb === undefined) throw new Error("integration transform not registered")
      integrationTransformCb(draft)
    },
    catalogTransform: (draft: unknown) => {
      if (catalogTransformCb === undefined) throw new Error("catalog transform not registered")
      catalogTransformCb(draft)
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sdkHook: (event: any) => {
      const registration = aisdkHooks.get("sdk")
      if (registration === undefined) throw new Error("sdk hook not registered")
      return registration.cb(event)
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    languageHook: (event: any) => {
      const registration = aisdkHooks.get("language")
      if (registration === undefined) throw new Error("language hook not registered")
      return registration.cb(event)
    },
    getSdkHookName: () => (aisdkHooks.has("sdk") ? "sdk" : undefined),
    getSdkHookOptions: () => aisdkHooks.get("sdk")?.options,
  }
}

type Harness = ReturnType<typeof makeMockContext>

/** drain macrotask+microtask chains (event consumer, fire-and-forget discovery) */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

/** run setup, asserting the v2 contract that it returns a Cleanup function */
async function runSetup(h: Harness): Promise<() => Promise<void> | void> {
  const cleanup = await serverPlugin.setup(h.context)
  if (typeof cleanup !== "function") throw new Error("setup must return a cleanup function")
  return cleanup
}

/** run setup and capture the OAuth authorize() registered via the integration transform */
async function setupWithAuthorize(h: Harness) {
  const cleanup = await runSetup(h)
  const integration = makeIntegrationDraft()
  h.integrationTransform(integration.draft)
  const registration = integration.methods[0]
  expect(registration).toBeDefined()
  return {
    cleanup,
    authorize: registration.authorize as (
      inputs: Record<string, string>,
    ) => Promise<{ url: string; instructions: string; mode: string; callback: Promise<unknown> }>,
  }
}

const kiroEvent = () => ({ type: "integration.connection.updated", data: { integrationID: "kiro" } })

// Phase 9 dual-listen credential events (upstream renamed
// `integration.connection.updated` → `credential.updated` + `credential.switched`)
const credentialUpdatedEvent = () => ({ type: "credential.updated", data: {} })
const credentialSwitchedEvent = (integrationID: string, credentialID: string | null) => ({
  type: "credential.switched",
  data: { integrationID, credentialID },
})

const EXPECTED_CREDENTIAL = {
  type: "oauth",
  methodID: "kiro-cli-login",
  refresh: "",
  access: "kiro-cli",
  expires: 0,
}

beforeEach(() => {
  sdkInstances = []
  mockVerifyAuthAsync.mockReset()
  mockVerifyAuthAsync.mockResolvedValue({ installed: true, authenticated: true })
  mockListModels.mockReset()
  mockListModels.mockResolvedValue([])
  mockCreateKiroAcp.mockReset()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockCreateKiroAcp.mockImplementation(() => makeSdkInstance() as any)
  mockExecFile.mockReset()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockExecFile.mockImplementation(() => makeFakeChild() as any)
})

afterEach(() => {
  vi.useRealTimers()
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Task 05: Integration/Credential auth flow
// ---------------------------------------------------------------------------

describe("auth: Integration kiro + Kiro CLI Login OAuth (task 05)", () => {
  test("server plugin definition carries tui: true", () => {
    // dev-17968 `tui?: boolean` (dist/promise/plugin.d.ts:40): the host
    // auto-loads this package's ./tui entrypoint for npm-channel installs
    expect(serverPlugin.tui).toBe(true)
  })

  test("registers integration kiro with a forms-shaped oauth method (no prompts anywhere)", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)

    const integration = makeIntegrationDraft()
    h.integrationTransform(integration.draft)

    expect(integration.integrations.get("kiro")).toEqual({ id: "kiro", name: "Kiro" })
    expect(integration.methods).toHaveLength(1)
    const registration = integration.methods[0]
    expect(registration.integrationID).toBe("kiro")
    // exact dev-17968 IntegrationOAuthMethod shape: {id, type:"oauth", label};
    // our flow needs no form fields, so the optional `form` is omitted
    expect(Object.keys(registration.method).sort()).toEqual(["id", "label", "type"])
    expect(registration.method).toEqual({
      id: "kiro-cli-login",
      type: "oauth",
      label: "Kiro CLI Login",
    })
    // the v1-era prompts/select-question API was DELETED upstream: no `prompts`
    // key may survive on the registration or the method
    expect("prompts" in registration).toBe(false)
    expect("prompts" in registration.method).toBe(false)
    // authorize takes the Form.Answer argument (new dev-17968 signature)
    expect(typeof registration.authorize).toBe("function")
    expect(registration.authorize.length).toBe(1)
    // kiro-cli owns credential storage/refresh: no refresh callback registered
    expect(registration.refresh).toBeUndefined()

    await cleanup()
  })

  test("cli absent fails with install guidance, no spawn, no credential", async () => {
    mockVerifyAuthAsync.mockResolvedValue({ installed: false, authenticated: false })
    const h = makeMockContext()
    const { cleanup, authorize } = await setupWithAuthorize(h)

    await expect(authorize({})).rejects.toThrow(/Install it from https:\/\/kiro\.dev\/docs\/cli\//)
    expect(mockExecFile).not.toHaveBeenCalled()

    await cleanup()
  })

  test("already authenticated resolves immediately with Credential.OAuth", async () => {
    mockVerifyAuthAsync.mockResolvedValue({ installed: true, authenticated: true })
    const h = makeMockContext()
    const { cleanup, authorize } = await setupWithAuthorize(h)

    const authorization = await authorize({})

    expect(mockExecFile).not.toHaveBeenCalled()
    expect(authorization.mode).toBe("auto")
    await expect(authorization.callback).resolves.toEqual(EXPECTED_CREDENTIAL)

    await cleanup()
  })

  test("authorize(answer) spawns kiro-cli and polls to success", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    let authenticated = false
    mockVerifyAuthAsync.mockImplementation(async () => ({ installed: true, authenticated }))
    const child = makeFakeChild()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExecFile.mockReturnValue(child as any)

    const h = makeMockContext()
    const { cleanup, authorize } = await setupWithAuthorize(h)

    // Form.Answer argument (dev-17968): our method registers no form fields, so
    // any answer record — including a stray one — enters the same login flow
    const authorization = await authorize({ unused: "answer" })
    expect(mockExecFile).toHaveBeenCalledTimes(1)
    expect(mockExecFile).toHaveBeenCalledWith("kiro-cli", ["login"], { shell: false })
    expect(authorization.mode).toBe("auto")

    // task 05 acceptance: poll observes authenticated -> child stops,
    // Credential.OAuth {type:"oauth", refresh:"", expires:0} resolves
    const credential = expect(authorization.callback).resolves.toEqual(EXPECTED_CREDENTIAL)

    await vi.advanceTimersByTimeAsync(2_000) // 1st poll: still unauthenticated
    expect(child.kill).not.toHaveBeenCalled()

    authenticated = true
    await vi.advanceTimersByTimeAsync(2_000) // 2nd poll: success

    await credential
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    await cleanup()
  })

  test("win32 uses shell for the login spawn", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
    Object.defineProperty(process, "platform", { value: "win32", configurable: true })
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
      mockVerifyAuthAsync.mockResolvedValue({ installed: true, authenticated: false })

      const h = makeMockContext()
      const { cleanup, authorize } = await setupWithAuthorize(h)

      // no hand guard on the callback: the production guard (auth.ts
      // authorize) absorbs the cancellation raised by cleanup below — vitest
      // fails on unhandled rejections, so this test is itself a witness
      const authorization = await authorize({})
      expect(authorization.mode).toBe("auto")

      expect(mockExecFile).toHaveBeenCalledWith("kiro-cli", ["login"], { shell: true })

      await cleanup()
    } finally {
      if (originalPlatform !== undefined) Object.defineProperty(process, "platform", originalPlatform)
    }
  })

  test("timeout kills child and carries manual kiro-cli login guidance", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    mockVerifyAuthAsync.mockResolvedValue({ installed: true, authenticated: false })
    const child = makeFakeChild()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExecFile.mockReturnValue(child as any)

    const h = makeMockContext()
    const { cleanup, authorize } = await setupWithAuthorize(h)

    const authorization = await authorize({})
    const rejection = expect(authorization.callback).rejects.toThrow(/`kiro-cli login`/)

    await vi.advanceTimersByTimeAsync(121_000) // > 120s poll budget

    await rejection
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    await cleanup()
  })

  test("disposal mid-poll kills child, settles the attempt, clears timers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    mockVerifyAuthAsync.mockResolvedValue({ installed: true, authenticated: false })
    const child = makeFakeChild()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExecFile.mockReturnValue(child as any)

    const h = makeMockContext()
    const { cleanup, authorize } = await setupWithAuthorize(h)

    const authorization = await authorize({})
    const rejection = expect(authorization.callback).rejects.toThrow(/cancelled/)
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    await cleanup()

    await rejection
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  test("no auth.json/tui.json references anywhere in src/", () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src")
    const files = readdirSync(srcDir, { recursive: true, encoding: "utf8" }).filter((file) =>
      file.endsWith(".ts"),
    )
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const content = readFileSync(join(srcDir, file), "utf8")
      expect(content, `${file} must not reference auth.json/tui.json`).not.toMatch(
        /auth\.json|tui\.json/,
      )
    }
  })
})

// ---------------------------------------------------------------------------
// Task 06: catalog transform + discovery lifecycle
// ---------------------------------------------------------------------------

describe("discovery: catalog transform + runtime model lifecycle (task 06)", () => {
  test("successful discovery publishes exact case-sensitive intersection and reloads once", async () => {
    const h = makeMockContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([runtime("claude-sonnet-4.6", { name: "Sonnet" })])

    const cleanup = await runSetup(h)
    await flush()

    expect(mockListModels).toHaveBeenCalledTimes(1)
    expect(mockListModels).toHaveBeenCalledWith({ cwd: h.directory })
    expect(h.reload).toHaveBeenCalledTimes(1)

    const catalog = makeCatalogDraft()
    seedRichKiro(catalog, [
      { key: "sonnet", modelID: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", release: "2025" },
      { key: "sonnet-case", modelID: "Claude-Sonnet-4.6" }, // case mismatch -> removed
      { key: "unrelated", modelID: "other-model" }, // not in runtime -> removed
    ])
    h.catalogTransform(catalog.draft)

    const record = catalog.providers.get("kiro")
    expect(record).toBeDefined()
    expect([...record!.models.keys()]).toEqual(["sonnet"])
    // rich models.dev metadata survives the transform
    expect(record!.models.get("sonnet")).toMatchObject({
      modelID: "claude-sonnet-4.6",
      name: "Claude Sonnet 4.6",
      release: "2025",
    })
    expect(record!.provider).toMatchObject({
      name: "Kiro",
      integrationID: "kiro",
      package: "aisdk:kiro-acp-ai-provider",
    })

    await cleanup()
  })

  test("duplicate runtime modelId fails open: snapshot unchanged, no reload", async () => {
    const h = makeMockContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([runtime("dupe"), runtime("dupe")])

    const cleanup = await runSetup(h)
    await flush()

    expect(h.reload).not.toHaveBeenCalled()

    // no snapshot was published: the transform must leave catalog data untouched
    const catalog = makeCatalogDraft()
    seedRichKiro(catalog, [{ key: "existing", modelID: "existing-model" }])
    h.catalogTransform(catalog.draft)
    expect([...catalog.providers.get("kiro")!.models.keys()]).toEqual(["existing"])

    await cleanup()
  })

  test("listModels exception fails open: previous snapshot retained", async () => {
    const h = makeMockContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([runtime("model-a")])

    const cleanup = await runSetup(h)
    await flush()
    expect(h.reload).toHaveBeenCalledTimes(1)

    mockListModels.mockRejectedValue(new Error("acp transport down"))
    h.events.push(kiroEvent())
    await flush()

    // failed rediscovery: no reload of partial data, last known-good survives
    expect(h.reload).toHaveBeenCalledTimes(1)
    const catalog = makeCatalogDraft()
    seedRichKiro(catalog, [{ key: "a", modelID: "model-a" }])
    h.catalogTransform(catalog.draft)
    expect([...catalog.providers.get("kiro")!.models.keys()]).toEqual(["a"])

    await cleanup()
  })

  test("login event rechecks connection.active and rediscovers", async () => {
    const h = makeMockContext()
    // not connected at setup: no initial discovery
    const cleanup = await runSetup(h)
    await flush()
    expect(mockListModels).not.toHaveBeenCalled()
    const activeCallsAtSetup = h.active.mock.calls.length

    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([runtime("model-a")])
    h.events.push(kiroEvent())
    await flush()

    expect(h.active.mock.calls.length).toBeGreaterThan(activeCallsAtSetup)
    expect(mockListModels).toHaveBeenCalledTimes(1)
    expect(h.reload).toHaveBeenCalledTimes(1)

    await cleanup()
  })

  test("non-kiro connection events are ignored", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)
    await flush()
    const activeCallsAtSetup = h.active.mock.calls.length

    h.events.push({ type: "integration.connection.updated", data: { integrationID: "other" } })
    h.events.push({ type: "session.updated", data: { integrationID: "kiro" } })
    await flush()

    expect(h.active.mock.calls.length).toBe(activeCallsAtSetup)
    expect(mockListModels).not.toHaveBeenCalled()
    expect(h.reload).not.toHaveBeenCalled()

    await cleanup()
  })

  test("logout clears the snapshot and reloads without runtime-only models", async () => {
    const h = makeMockContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([runtime("model-a")])
    const cleanup = await runSetup(h)
    await flush()
    expect(h.reload).toHaveBeenCalledTimes(1)

    h.active.mockResolvedValue(undefined) // logged out
    h.events.push(kiroEvent())
    await flush()

    expect(h.reload).toHaveBeenCalledTimes(2)
    // fallback-shaped draft (no models.dev entry): nothing self-registers now
    const catalog = makeCatalogDraft()
    h.catalogTransform(catalog.draft)
    expect(catalog.providers.size).toBe(0)

    await cleanup()
  })

  test("stale discovery completing after logout is discarded by the generation guard", async () => {
    const h = makeMockContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    let resolveModels!: (models: ModelWithEfforts[]) => void
    mockListModels.mockImplementation(
      () => new Promise<ModelWithEfforts[]>((resolve) => (resolveModels = resolve)),
    )

    const cleanup = await runSetup(h)
    await flush() // initial discovery in flight

    h.active.mockResolvedValue(undefined)
    h.events.push(kiroEvent()) // logout bumps the generation + reloads
    await flush()
    expect(h.reload).toHaveBeenCalledTimes(1)

    resolveModels([runtime("stale-model")])
    await flush()

    // stale completion dropped: no republish, snapshot stays empty
    expect(h.reload).toHaveBeenCalledTimes(1)
    const catalog = makeCatalogDraft()
    h.catalogTransform(catalog.draft)
    expect(catalog.providers.size).toBe(0)

    await cleanup()
  })

  test("concurrent discovery triggers coalesce onto one listModels call", async () => {
    const h = makeMockContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    let resolveModels!: (models: ModelWithEfforts[]) => void
    mockListModels.mockImplementation(
      () => new Promise<ModelWithEfforts[]>((resolve) => (resolveModels = resolve)),
    )

    const cleanup = await runSetup(h)
    await flush() // setup discovery in flight

    // second trigger while the setup discovery is still in flight
    h.events.push(kiroEvent())
    await flush()

    expect(mockListModels).toHaveBeenCalledTimes(1)

    resolveModels([runtime("model-a")])
    await flush()
    expect(h.reload).toHaveBeenCalledTimes(1)

    await cleanup()
  })

  test("effort variants match v1 merge semantics; empty efforts invent nothing", async () => {
    const h = makeMockContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([
      runtime("with-efforts", { runtimeEfforts: ["low", "high"], baselineEffort: "low" }),
      runtime("no-efforts", { runtimeEfforts: [] }),
    ])
    const cleanup = await runSetup(h)
    await flush()

    const catalog = makeCatalogDraft()
    seedRichKiro(catalog, [
      { key: "with-efforts", modelID: "with-efforts" },
      { key: "no-efforts", modelID: "no-efforts" },
    ])
    h.catalogTransform(catalog.draft)

    const models = catalog.providers.get("kiro")!.models
    // B3 fix lock: the emitted settings key is the SDK's `effort`
    // (KiroACPProviderSettings, dist/index.d.ts) — never `reasoningEffort`
    expect(models.get("with-efforts")!.settings.effort).toBe("low")
    expect(models.get("with-efforts")!.settings.reasoningEffort).toBeUndefined()
    expect(models.get("with-efforts")!.variants).toEqual([
      { id: "low", settings: { effort: "low" } },
      { id: "high", settings: { effort: "high" } },
    ])
    expect(models.get("no-efforts")!.variants).toEqual([])
    expect(models.get("no-efforts")!.settings.effort).toBeUndefined()

    await cleanup()
  })

  test("fallback self-registers only runtime models when the catalog lacks Kiro", async () => {
    const h = makeMockContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([
      runtime("model-a", { name: "Model A" }),
      runtime("model-b", { name: "" }),
    ])
    const cleanup = await runSetup(h)
    await flush()

    const catalog = makeCatalogDraft() // no models.dev Kiro entry
    h.catalogTransform(catalog.draft)

    const record = catalog.providers.get("kiro")
    expect(record).toBeDefined()
    expect([...record!.models.keys()].sort()).toEqual(["model-a", "model-b"])
    expect(record!.models.get("model-a")).toMatchObject({ name: "Model A", modelID: "model-a" })
    expect(record!.models.get("model-b")!.name).toBe("model-b") // falls back to the id
    expect(record!.provider.package).toBe("aisdk:kiro-acp-ai-provider")
    expect(record!.provider.name).toBe("Kiro")

    await cleanup()
  })

  test("provider settings contextWindows are keyed by API modelID with positive values only", async () => {
    const h = makeMockContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([runtime("claude-sonnet-4.6"), runtime("zero-limit")])
    const cleanup = await runSetup(h)
    await flush()

    const catalog = makeCatalogDraft()
    seedRichKiro(catalog, [
      // catalog key differs from the API modelID on purpose
      { key: "sonnet-alias", modelID: "claude-sonnet-4.6", limit: { context: 200_000, output: 64_000 } },
      { key: "zero-alias", modelID: "zero-limit", limit: { context: 0, output: 0 } },
    ])
    h.catalogTransform(catalog.draft)

    const settings = catalog.providers.get("kiro")!.provider.settings
    expect(settings.contextWindows).toEqual({ "claude-sonnet-4.6": 200_000 })
    await cleanup()
  })
})

// ---------------------------------------------------------------------------
// Task 31: dual-listen credential-event migration (Phase 9)
// ---------------------------------------------------------------------------

describe("discovery: dual-listen credential events (task 31)", () => {
  /** setup while disconnected: no initial discovery, a clean call baseline */
  async function setupDisconnected() {
    const h = makeMockContext()
    const cleanup = await runSetup(h)
    await flush()
    expect(mockListModels).not.toHaveBeenCalled()
    return { h, cleanup, activeCallsAtSetup: h.active.mock.calls.length }
  }

  test("legacy integration.connection.updated (kiro) still triggers re-check + discovery", async () => {
    const { h, cleanup, activeCallsAtSetup } = await setupDisconnected()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([runtime("model-a")])

    h.events.push(kiroEvent())
    await flush()

    // old-host path stays alive: dual-listen must not drop the legacy name
    expect(h.active.mock.calls.length).toBeGreaterThan(activeCallsAtSetup)
    expect(mockListModels).toHaveBeenCalledTimes(1)
    expect(h.reload).toHaveBeenCalledTimes(1)

    await cleanup()
  })

  test("credential.updated (empty payload) triggers re-check + discovery", async () => {
    const { h, cleanup, activeCallsAtSetup } = await setupDisconnected()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([runtime("model-a")])

    // the new-host event carries NO payload — there is nothing to scope on;
    // the connection.active re-check is the scoping
    h.events.push(credentialUpdatedEvent())
    await flush()

    expect(h.active.mock.calls.length).toBeGreaterThan(activeCallsAtSetup)
    expect(mockListModels).toHaveBeenCalledTimes(1)
    expect(h.reload).toHaveBeenCalledTimes(1)

    await cleanup()
  })

  test("credential.switched (kiro) triggers re-check + discovery; nullable credentialID accepted", async () => {
    const { h, cleanup, activeCallsAtSetup } = await setupDisconnected()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([runtime("model-a")])

    h.events.push(credentialSwitchedEvent("kiro", "credential-1"))
    await flush()

    expect(h.active.mock.calls.length).toBeGreaterThan(activeCallsAtSetup)
    expect(mockListModels).toHaveBeenCalledTimes(1)
    expect(h.reload).toHaveBeenCalledTimes(1)

    // credentialID is NullOr<Credential.ID> upstream (null on sign-out of the
    // active credential): a null value must trigger exactly the same re-check
    h.events.push(credentialSwitchedEvent("kiro", null))
    await flush()

    expect(mockListModels).toHaveBeenCalledTimes(2)
    expect(h.reload).toHaveBeenCalledTimes(2)

    await cleanup()
  })

  test("credential.switched for another integration is ignored", async () => {
    const { h, cleanup, activeCallsAtSetup } = await setupDisconnected()

    h.events.push(credentialSwitchedEvent("github", "credential-y"))
    await flush()

    expect(h.active.mock.calls.length).toBe(activeCallsAtSetup)
    expect(mockListModels).not.toHaveBeenCalled()
    expect(h.reload).not.toHaveBeenCalled()

    await cleanup()
  })

  test("unknown event names are ignored", async () => {
    const { h, cleanup, activeCallsAtSetup } = await setupDisconnected()

    h.events.push({ type: "something.else", data: { integrationID: "kiro" } })
    await flush()

    expect(h.active.mock.calls.length).toBe(activeCallsAtSetup)
    expect(mockListModels).not.toHaveBeenCalled()
    expect(h.reload).not.toHaveBeenCalled()

    await cleanup()
  })

  test("re-check is the source of truth: credential.updated while inactive clears kiro models", async () => {
    const h = makeMockContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([runtime("model-a")])
    const cleanup = await runSetup(h)
    await flush()
    expect(h.reload).toHaveBeenCalledTimes(1)

    // logout observed only through the NEW event name: the event payload is
    // empty, so connection.active alone must drive the clear
    h.active.mockResolvedValue(undefined)
    h.events.push(credentialUpdatedEvent())
    await flush()

    expect(h.reload).toHaveBeenCalledTimes(2)
    // snapshot cleared: a fallback-shaped draft publishes no kiro models
    const catalog = makeCatalogDraft()
    h.catalogTransform(catalog.draft)
    expect(catalog.providers.size).toBe(0)

    await cleanup()
  })
})

// ---------------------------------------------------------------------------
// Task 07: AISDK hook ownership + aggregated idempotent cleanup
// ---------------------------------------------------------------------------

describe("aisdk hook + lifecycle (task 07)", () => {
  test("hook is registered providerID-scoped and overwrites a pre-populated event.sdk with the owned instance", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)
    expect(h.getSdkHookName()).toBe("sdk")
    // dev-17968 ModelHookOptions scoping: the hook only fires for the kiro provider
    expect(h.getSdkHookOptions()).toEqual({ providerID: "kiro" })

    const unowned = { languageModel: vi.fn() } // DynamicProviderPlugin residue
    const event = {
      model: { modelID: "claude-sonnet-4.6" },
      package: "kiro-acp-ai-provider",
      options: { cwd: h.directory, agent: "opencode" },
      sdk: unowned as unknown,
    }
    await h.sdkHook(event)

    expect(mockCreateKiroAcp).toHaveBeenCalledTimes(1)
    // beta.4 atom: the factory receives the allowlist-sanitized settings plus
    // the process-constant clientInfo — never the raw event options
    expect(mockCreateKiroAcp).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: h.directory,
        agent: "opencode",
        clientInfo: { name: "opencode-kiro", version: expect.any(String) },
      }),
    )
    expect(mockCreateKiroAcp).not.toHaveBeenCalledWith(
      expect.objectContaining({ fetch: expect.anything() }),
    )
    expect(event.sdk).toBe(sdkInstances[0])
    expect(event.sdk).not.toBe(unowned)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(typeof (event.sdk as any).languageModel).toBe("function")

    await cleanup()
  })

  test("non-kiro packages are left alone", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)

    const foreign = { languageModel: vi.fn() }
    const event = { model: {}, package: "some-other-provider", options: {}, sdk: foreign as unknown }
    await h.sdkHook(event)

    expect(mockCreateKiroAcp).not.toHaveBeenCalled()
    expect(event.sdk).toBe(foreign)

    await cleanup()
  })

  test("owned instances are reused per sanitized settings key and shut down exactly once on cleanup", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)

    // REALISTIC production shape: the host's prepareOptions unconditionally
    // injects an `options.fetch` function plus name/headers/body extras (host
    // aisdk.ts:119-131). Under the beta.3 JSON-safety key these options were
    // unkeyable → a DISTINCT owned instance per event; the beta.4 allowlist
    // key drops them, so the same allowlisted subset now shares ONE instance
    // (this deliberately FLIPS the old expectation).
    const base = { cwd: "/a", agent: "opencode", trustAllTools: true }
    const eventA1 = {
      model: {},
      package: "kiro-acp-ai-provider",
      options: { ...base, fetch: () => {}, name: "kiro", headers: { "x-a": "1" }, body: { a: 1 } },
      sdk: undefined as unknown,
    }
    const eventA2 = {
      model: {},
      package: "kiro-acp-ai-provider",
      options: { ...base, fetch: () => {}, name: "kiro", headers: { "x-a": "2" }, body: { a: 2 } },
      sdk: undefined as unknown,
    }
    const eventB = {
      model: {},
      package: "kiro-acp-ai-provider",
      options: { ...base, cwd: "/b", fetch: () => {} },
      sdk: undefined as unknown,
    }
    await h.sdkHook(eventA1)
    await h.sdkHook(eventA2)
    await h.sdkHook(eventB)

    // sanitized-settings reuse: same allowlisted subset -> same owned
    // instance despite differing fetch identities/unknown extras
    expect(eventA2.sdk).toBe(eventA1.sdk)
    expect(eventB.sdk).not.toBe(eventA1.sdk) // different cwd -> different instance
    expect(sdkInstances).toHaveLength(2)

    await cleanup()
    for (const instance of sdkInstances) expect(instance.shutdown).toHaveBeenCalledTimes(1)

    await cleanup() // second cleanup must not shut anything down again
    for (const instance of sdkInstances) expect(instance.shutdown).toHaveBeenCalledTimes(1)
  })

  test("cleanup is idempotent and complete across auth, discovery and aisdk", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    mockVerifyAuthAsync.mockResolvedValue({ installed: true, authenticated: false })

    const h = makeMockContext()
    const { cleanup, authorize } = await setupWithAuthorize(h)

    // put a login poll in flight so cleanup has timers + a child to release;
    // no hand guard — the production callback guard absorbs the disposal
    // rejection (vitest would fail the run on an unhandled rejection)
    const authorization = await authorize({})
    expect(authorization.mode).toBe("auto")
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    const first = cleanup()
    const second = cleanup()
    await Promise.all([first, second])

    expect(h.disposeSpies.integration).toHaveBeenCalledTimes(1)
    expect(h.disposeSpies.catalog).toHaveBeenCalledTimes(1)
    // two aisdk registrations since the beta.4 atom (sdk + language), each
    // disposed exactly once through the shared knob
    expect(h.disposeSpies.hook).toHaveBeenCalledTimes(2)
    expect(h.hooks.get("sdk")!.dispose).toHaveBeenCalledTimes(1)
    expect(h.hooks.get("language")!.dispose).toHaveBeenCalledTimes(1)
    expect(h.events.returned).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    // a later third call is equally safe and disposes nothing again
    await cleanup()
    expect(h.disposeSpies.integration).toHaveBeenCalledTimes(1)
    expect(h.disposeSpies.hook).toHaveBeenCalledTimes(2)
  })

  test("a failing disposer does not block the others; failures aggregate", async () => {
    const h = makeMockContext()
    const hookError = new Error("hook dispose exploded")
    h.disposeSpies.hook.mockRejectedValue(hookError)

    const cleanup = await runSetup(h)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const failure: any = await (async () => cleanup())().then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors).toContain(hookError)
    // every other resource was still disposed
    expect(h.disposeSpies.catalog).toHaveBeenCalledTimes(1)
    expect(h.disposeSpies.integration).toHaveBeenCalledTimes(1)
    expect(h.events.returned).toHaveBeenCalledTimes(1)
  })

  test("setup failure runs partial cleanup over earlier registrations and rethrows", async () => {
    const h = makeMockContext()
    const bootError = new Error("catalog transform registration failed")
    h.raw.catalog.transform.mockRejectedValue(bootError)

    await expect(serverPlugin.setup(h.context)).rejects.toBe(bootError)

    // auth registered before the discovery failure -> its disposer ran
    expect(h.disposeSpies.integration).toHaveBeenCalledTimes(1)
    expect(h.disposeSpies.hook).not.toHaveBeenCalled()
  })

  // B3 regression lock (HOST_E2E_REPORT.md), re-targeted for the beta.4 atom:
  // variant settings -> host `withVariant` overlay -> aisdk hook
  // `event.options` still carries the SDK's `effort` key (never
  // `reasoningEffort`) — that catalog contract is unchanged. But the factory
  // side FLIPS: the allowlist strips `effort` from the `createKiroAcp`
  // settings (one shared provider across efforts); the per-request carrier is
  // now the `language` hook's `languageModel(id, { effort })` override, whose
  // positive witness lives in the beta.4 describe block below.
  test("the effort variant reaches event.options but is stripped from createKiroAcp settings", async () => {
    const h = makeMockContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([
      runtime("with-efforts", { runtimeEfforts: ["high"], baselineEffort: undefined }),
    ])
    const cleanup = await runSetup(h)
    await flush()

    const catalog = makeCatalogDraft()
    seedRichKiro(catalog, [{ key: "with-efforts", modelID: "with-efforts" }])
    h.catalogTransform(catalog.draft)

    const record = catalog.providers.get("kiro")!
    const variant = record.models.get("with-efforts")!.variants[0]
    expect(variant).toEqual({ id: "high", settings: { effort: "high" } })

    // simulate the host resolving the effort variant: provider settings
    // overlaid with the variant settings become the sdk event options
    const options = { ...record.provider.settings, ...variant.settings }
    const event = { model: { modelID: "with-efforts" }, package: "kiro-acp-ai-provider", options, sdk: undefined as unknown }
    await h.sdkHook(event)

    expect(options.effort).toBe("high") // the host overlay contract is intact
    expect(mockCreateKiroAcp).toHaveBeenCalledWith(expect.objectContaining({ cwd: h.directory }))
    // allowlist strips effort/efforts from the factory settings...
    expect(mockCreateKiroAcp).not.toHaveBeenCalledWith(
      expect.objectContaining({ effort: expect.anything() }),
    )
    expect(mockCreateKiroAcp).not.toHaveBeenCalledWith(
      expect.objectContaining({ efforts: expect.anything() }),
    )
    // ...and the v1-era key never re-appears anywhere
    expect(mockCreateKiroAcp).not.toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: expect.anything() }),
    )
    // the owned provider serves the model the request path resolves
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((event.sdk as any).languageModel("with-efforts")).toBeDefined()

    await cleanup()
  })
})

// ---------------------------------------------------------------------------
// beta.4 atom: aisdk language hook + allowlist sanitization + clientInfo
// ---------------------------------------------------------------------------

// New behavior locks for the beta.4 atom (Items 1+2+5). Rationale:
// - The host's `prepareOptions` spreads model settings into `event.options`
//   AND unconditionally injects an `options.fetch` function (host
//   aisdk.ts:119-131 at the pinned SHA) — under the beta.3 JSON-safety key
//   that made EVERY production event unkeyable (cache bypass, one owned ACP
//   process per event). The allowlist-sanitized key restores reuse.
// - The allowlist governs BOTH the cache key AND the `createKiroAcp`
//   argument, so a dropped key can never silently configure a provider.
// - `effort`/`efforts` are excluded from key/settings so ONE provider is
//   shared across effort variants; the per-request carrier is the `language`
//   hook's `languageModel(id, { effort })` override (SDK precedence:
//   overrides?.effort ?? settings.efforts?.[modelId] ?? settings.effort).
// - No plugin-side language-instance cache: the host memoizes language
//   instances per settings-key (host aisdk.ts:249-291), naturally per-effort
//   because variant settings differ.
describe("aisdk language hook + allowlist (beta.4 atom)", () => {
  /** the version the CLIENT_INFO constant must carry — read from the real
   * package.json so the lock survives version bumps (no hardcoded literal) */
  const pkgVersion = (
    JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
    ) as { version: string }
  ).version

  /** production-realistic sdk-hook event (fetch-bearing) */
  function sdkEvent(options: Record<string, unknown>) {
    return { model: {}, package: "kiro-acp-ai-provider", options, sdk: undefined as unknown }
  }

  test("language hook is registered providerID-scoped and disposed on cleanup exactly once", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)

    const registration = h.hooks.get("language")
    expect(registration).toBeDefined()
    // dev-17968 ModelHookOptions scoping: fires only for the kiro provider
    expect(registration!.options).toEqual({ providerID: "kiro" })
    expect(registration!.dispose).not.toHaveBeenCalled()

    await cleanup()
    expect(registration!.dispose).toHaveBeenCalledTimes(1)

    await cleanup() // idempotent: no second disposal
    expect(registration!.dispose).toHaveBeenCalledTimes(1)
  })

  test("override path: variant effort flows via languageModel(id, { effort })", async () => {
    // end-to-end witness replacing the retired settings-path positive lock:
    // catalog variant -> host `withVariant` overlay (model-resolver.ts:126-133)
    // -> language-hook `event.options.effort` -> KiroACPModelOverrides
    const h = makeMockContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([
      runtime("with-efforts", { runtimeEfforts: ["high"], baselineEffort: undefined }),
    ])
    const cleanup = await runSetup(h)
    await flush()

    const catalog = makeCatalogDraft()
    seedRichKiro(catalog, [{ key: "with-efforts", modelID: "with-efforts" }])
    h.catalogTransform(catalog.draft)
    const record = catalog.providers.get("kiro")!
    const variant = record.models.get("with-efforts")!.variants[0]
    expect(variant).toEqual({ id: "high", settings: { effort: "high" } })

    // host overlay + production fetch injection shape the options
    const options = { ...record.provider.settings, ...variant.settings, fetch: () => {} }
    const event = sdkEvent(options)
    ;(event as { model: unknown }).model = { modelID: "with-efforts" }
    await h.sdkHook(event)
    const owned = sdkInstances[0]
    expect(event.sdk).toBe(owned)

    // the host calls the language hook AFTER the sdk hook with the resolved
    // event.sdk (host aisdk.ts:286)
    const languageEvent = {
      model: { modelID: "with-efforts" },
      sdk: event.sdk,
      options,
      language: undefined as unknown,
    }
    await h.languageHook(languageEvent)

    expect(owned.languageModel).toHaveBeenCalledTimes(1)
    expect(owned.languageModel).toHaveBeenCalledWith("with-efforts", { effort: "high" })
    expect(languageEvent.language).toBe(owned.languageModel.mock.results[0]!.value)

    await cleanup()
  })

  test("no effort -> undefined overrides", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)

    const sdk = { languageModel: vi.fn(() => ({ sentinel: true })) }
    const languageEvent = {
      model: { modelID: "claude-sonnet-4.6" },
      sdk,
      options: { cwd: "/a", agent: "opencode" },
      language: undefined as unknown,
    }
    await h.languageHook(languageEvent)

    // no invented effort and no 4-way fallback: absent effort passes
    // undefined overrides so the SDK's own settings precedence applies
    expect(sdk.languageModel).toHaveBeenCalledTimes(1)
    expect(sdk.languageModel).toHaveBeenCalledWith("claude-sonnet-4.6", undefined)
    expect(languageEvent.language).toBe(sdk.languageModel.mock.results[0]!.value)

    await cleanup()
  })

  test("non-string effort is ignored", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)

    const sdk = { languageModel: vi.fn(() => ({ sentinel: true })) }
    for (const effort of [42, {}]) {
      await h.languageHook({
        model: { modelID: "claude-sonnet-4.6" },
        sdk,
        options: { cwd: "/a", effort },
        language: undefined as unknown,
      })
    }

    // string guard: anything but a string effort yields undefined overrides
    expect(sdk.languageModel).toHaveBeenCalledTimes(2)
    expect(sdk.languageModel).toHaveBeenNthCalledWith(1, "claude-sonnet-4.6", undefined)
    expect(sdk.languageModel).toHaveBeenNthCalledWith(2, "claude-sonnet-4.6", undefined)

    await cleanup()
  })

  test("factory receives ONLY allowlisted keys + clientInfo", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)

    // production-realistic options: catalog settings + variant effort + the
    // host-injected fetch/name/headers/body extras + a future unknown key
    await h.sdkHook(
      sdkEvent({
        cwd: "/w",
        agent: "opencode",
        trustAllTools: true,
        mcpTimeout: 45,
        contextWindows: { "claude-sonnet-4.6": 200_000 },
        effort: "high",
        fetch: () => {},
        name: "kiro",
        headers: { "x-h": "1" },
        body: { b: 1 },
        futureUnknownKey: "x",
      }),
    )

    // EXACT key-set assertion — the strongest form of the allowlist contract:
    // key set = (passed keys ∩ allowlist) ∪ {clientInfo}; NO fetch, effort,
    // efforts, name, headers, body or unknown keys may reach the factory
    expect(mockCreateKiroAcp).toHaveBeenCalledTimes(1)
    const arg = mockCreateKiroAcp.mock.calls[0]![0] as Record<string, unknown>
    expect(Object.keys(arg).sort()).toEqual([
      "agent",
      "clientInfo",
      "contextWindows",
      "cwd",
      "mcpTimeout",
      "trustAllTools",
    ])

    await cleanup()
  })

  test("clientInfo is process-constant and matches package.json", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)

    // two distinct configs -> two factory calls, SAME constant clientInfo
    await h.sdkHook(sdkEvent({ cwd: "/one", fetch: () => {} }))
    await h.sdkHook(sdkEvent({ cwd: "/two", fetch: () => {} }))

    expect(mockCreateKiroAcp).toHaveBeenCalledTimes(2)
    const expected = { name: "opencode-kiro", version: pkgVersion }
    const first = (mockCreateKiroAcp.mock.calls[0]![0] as Record<string, unknown>).clientInfo
    const second = (mockCreateKiroAcp.mock.calls[1]![0] as Record<string, unknown>).clientInfo
    expect(first).toEqual(expected) // no timestamps, no per-request fields
    expect(second).toEqual(expected)

    await cleanup()
  })

  test("provider is shared across efforts; per-request override diverges", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)

    // the atom's core invariant (Req 1): effort differences must NOT split
    // the provider — one factory call — while each request still carries its
    // own effort via the language-hook override
    const base = { cwd: "/shared", agent: "opencode", trustAllTools: true }
    const eventA = sdkEvent({ ...base, effort: "high", fetch: () => {} })
    const eventB = sdkEvent({ ...base, effort: "low", fetch: () => {} })
    await h.sdkHook(eventA)
    await h.sdkHook(eventB)

    expect(mockCreateKiroAcp).toHaveBeenCalledTimes(1)
    expect(eventB.sdk).toBe(eventA.sdk)
    const owned = sdkInstances[0]

    await h.languageHook({ model: { modelID: "m" }, sdk: eventA.sdk, options: eventA.options, language: undefined })
    await h.languageHook({ model: { modelID: "m" }, sdk: eventB.sdk, options: eventB.options, language: undefined })

    expect(owned.languageModel).toHaveBeenNthCalledWith(1, "m", { effort: "high" })
    expect(owned.languageModel).toHaveBeenNthCalledWith(2, "m", { effort: "low" })

    await cleanup()
  })

  test("distinct allowlisted config -> distinct provider", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)

    // the key must still discriminate REAL config differences
    const base = { cwd: "/same", agent: "opencode" }
    await h.sdkHook(sdkEvent({ ...base, contextWindows: { m: 100_000 }, fetch: () => {} }))
    await h.sdkHook(sdkEvent({ ...base, contextWindows: { m: 200_000 }, fetch: () => {} }))

    expect(mockCreateKiroAcp).toHaveBeenCalledTimes(2)
    expect(sdkInstances).toHaveLength(2)

    await cleanup()
    for (const instance of sdkInstances) expect(instance.shutdown).toHaveBeenCalledTimes(1)

    await cleanup() // idempotent: nothing shuts down twice
    for (const instance of sdkInstances) expect(instance.shutdown).toHaveBeenCalledTimes(1)
  })

  test("reasoningEffort never appears on the factory or the override path", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)

    // effort-bearing flow: sdk hook + language hook (Req 3 guardrail — the
    // effort key is the SDK's `effort`, the v1-era name must never resurface)
    const event = sdkEvent({ cwd: "/g", effort: "high", fetch: () => {} })
    await h.sdkHook(event)
    const owned = sdkInstances[0]
    await h.languageHook({ model: { modelID: "m" }, sdk: event.sdk, options: event.options, language: undefined })

    expect(mockCreateKiroAcp).not.toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: expect.anything() }),
    )
    for (const call of owned.languageModel.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("reasoningEffort")
    }
    // positive witness that the flow actually ran
    expect(owned.languageModel).toHaveBeenCalledWith("m", { effort: "high" })

    await cleanup()
  })
})

// ---------------------------------------------------------------------------
// beta.4 Item 6: plugin options `agent` / `mcpTimeout` / `discover`
// ---------------------------------------------------------------------------

// New behavior locks for Item 6 (Req 9). Rationale:
// - `Plugin.Context.options` is typed present (dist/promise/plugin.d.ts:26) but
//   BOTH v2 mock contexts omit it and older hosts may too, so src/server.ts
//   reads `context.options ?? {}`. `makeMockContext()` without an `options`
//   key IS the guard witness — the default-path test below must never opt in.
// - Exactly three options, type-checked at runtime with silent fallback to the
//   defaults (`agent: "opencode"`, `mcpTimeout: 45`, `discover: true`);
//   `trustAllTools` stays hardcoded and there is deliberately NO `cwd` option
//   (per-location `integration.list().location.directory` wins).
// - `discover: false` gates ONLY the setup-time kick-off; the credential-event
//   path must stay live so a later login still discovers models.
describe("plugin options (item 6)", () => {
  /** connected setup + one runtime model + a rich catalog draft → provider record */
  async function setupAndTransform(h: Harness) {
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([runtime("claude-sonnet-4.6")])
    const cleanup = await runSetup(h)
    await flush()
    const catalog = makeCatalogDraft()
    seedRichKiro(catalog, [{ key: "sonnet", modelID: "claude-sonnet-4.6" }])
    h.catalogTransform(catalog.draft)
    const record = catalog.providers.get("kiro")
    expect(record).toBeDefined()
    return { cleanup, record: record! }
  }

  test("options absent → defaults applied", async () => {
    const h = makeMockContext() // NO options key at all — the ?? {} guard witness
    expect("options" in h.raw).toBe(false)

    const { cleanup, record } = await setupAndTransform(h)

    // setup kick-off fired with the default `discover: true`
    expect(mockListModels).toHaveBeenCalledTimes(1)
    // catalog settings carry the documented defaults
    expect(record.provider.settings).toMatchObject({ agent: "opencode", mcpTimeout: 45 })
    expect(record.provider.settings.trustAllTools).toBe(true)

    await cleanup()
  })

  test("custom agent/mcpTimeout flow to createKiroAcp", async () => {
    const h = makeMockContext({ options: { agent: "custom", mcpTimeout: 90 } })
    const { cleanup, record } = await setupAndTransform(h)

    // catalog side
    expect(record.provider.settings).toMatchObject({ agent: "custom", mcpTimeout: 90 })
    expect(record.provider.settings.trustAllTools).toBe(true) // never an option

    // host side: provider.settings → prepareOptions spread (+ injected fetch)
    // → sdk hook → allowlist (both keys allowlisted) → createKiroAcp
    const options = { ...record.provider.settings, fetch: () => {} }
    await h.sdkHook({ model: { modelID: "claude-sonnet-4.6" }, package: "kiro-acp-ai-provider", options, sdk: undefined })
    expect(mockCreateKiroAcp).toHaveBeenCalledTimes(1)
    expect(mockCreateKiroAcp).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "custom", mcpTimeout: 90, cwd: h.directory }),
    )

    await cleanup()
  })

  test("type-invalid options fall back to defaults", async () => {
    // wrong types for every key: parsing is defensive, setup must not throw
    const h = makeMockContext({ options: { agent: 7, mcpTimeout: "45", discover: "yes" } })
    const { cleanup, record } = await setupAndTransform(h)

    expect(mockListModels).toHaveBeenCalledTimes(1) // discover fell back to true
    expect(record.provider.settings).toMatchObject({ agent: "opencode", mcpTimeout: 45 })
    await cleanup()

    // edge values that pass a naive typeof: empty agent and a non-finite timeout
    const h2 = makeMockContext({ options: { agent: "", mcpTimeout: Number.NaN } })
    const second = await setupAndTransform(h2)
    expect(second.record.provider.settings).toMatchObject({ agent: "opencode", mcpTimeout: 45 })
    await second.cleanup()
  })

  test("discover:false gates setup kick-off only", async () => {
    const h = makeMockContext({ options: { discover: false } })
    h.active.mockResolvedValue({ integrationID: "kiro" }) // connected at setup
    mockListModels.mockResolvedValue([runtime("model-a")])

    const cleanup = await runSetup(h)
    await flush()

    // connected, yet NO setup-time discovery
    expect(mockListModels).not.toHaveBeenCalled()
    expect(h.reload).not.toHaveBeenCalled()

    // the event-driven path is untouched: a credential event still discovers
    h.events.push(credentialUpdatedEvent())
    await flush()
    expect(mockListModels).toHaveBeenCalledTimes(1)
    expect(mockListModels).toHaveBeenCalledWith({ cwd: h.directory })
    expect(h.reload).toHaveBeenCalledTimes(1)

    await cleanup()
  })

  test("no cwd option surface", async () => {
    // a user-supplied cwd is an UNKNOWN key: ignored silently, never plumbed
    const h = makeMockContext({ options: { cwd: "/elsewhere" } })
    const { cleanup, record } = await setupAndTransform(h)

    // discovery and catalog settings both derive cwd from the location
    expect(mockListModels).toHaveBeenCalledWith({ cwd: h.directory })
    expect(record.provider.settings.cwd).toBe(h.directory)
    expect(JSON.stringify(record.provider.settings)).not.toContain("/elsewhere")

    // and the factory never sees it either
    const options = { ...record.provider.settings, fetch: () => {} }
    await h.sdkHook({ model: { modelID: "claude-sonnet-4.6" }, package: "kiro-acp-ai-provider", options, sdk: undefined })
    expect(mockCreateKiroAcp).toHaveBeenCalledWith(expect.objectContaining({ cwd: h.directory }))
    expect(JSON.stringify(mockCreateKiroAcp.mock.calls)).not.toContain("/elsewhere")

    await cleanup()
  })
})

// ---------------------------------------------------------------------------
// beta.4 Items 3+4: async auth probe + login-callback guard
// ---------------------------------------------------------------------------

// New behavior locks for Items 3 (adoption) + 4 (Reqs 4/6/7). Rationale:
// - Blocking bug: the sync SDK `verifyAuth()` runs 2x execFileSync (kiro-cli
//   `--version` + `whoami`, 10s timeouts each); polled every 2s it froze the
//   host event loop roughly every 3rd tick. src/server/auth.ts now uses
//   `verifyAuthAsync()` exclusively (SDK contract: identical AuthStatus,
//   shared 5s memo, never rejects) at BOTH call sites — authorize entry and
//   the poll tick.
// - Req 6 guard: `authorize` binds `const callback = pollForLogin(...)`,
//   guards the DERIVED promise (`callback.catch(() => {})`) and returns the
//   ORIGINAL — an abandoned login can no longer surface as an unhandled
//   rejection, while the host still observes timeout/cancel on the callback.
// - Async-tick hazard: disposal can cancel the attempt while a probe is in
//   flight; the tick must then neither re-arm the timer (leak after cleanup)
//   nor settle the promise a second time.
// - Req 7: the credential marker stays `expires: 0` (EXPECTED_CREDENTIAL).
describe("async auth probe + callback guard (items 3+4)", () => {
  const UNAUTHENTICATED: AuthStatus = { installed: true, authenticated: false }
  const AUTHENTICATED: AuthStatus = { installed: true, authenticated: true }
  const TIMEOUT_GUIDANCE =
    /^Kiro authentication timed out\. Run `kiro-cli login` manually, then re-run `opencode auth login`\.$/

  /** manually-controlled probe promise (mid-probe disposal lock) */
  function deferredStatus() {
    let resolve!: (status: AuthStatus) => void
    const promise = new Promise<AuthStatus>((r) => (resolve = r))
    return { promise, resolve }
  }

  test("login succeeds via async probe without blocking semantics", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    // authorize entry + 1st tick unauthenticated, then authenticated
    mockVerifyAuthAsync
      .mockResolvedValueOnce(UNAUTHENTICATED)
      .mockResolvedValueOnce(UNAUTHENTICATED)
      .mockResolvedValue(AUTHENTICATED)
    const child = makeFakeChild()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExecFile.mockReturnValue(child as any)

    const h = makeMockContext()
    const { cleanup, authorize } = await setupWithAuthorize(h)

    const authorization = await authorize({})
    expect(mockExecFile).toHaveBeenCalledTimes(1)
    const credential = expect(authorization.callback).resolves.toEqual(EXPECTED_CREDENTIAL)

    await vi.advanceTimersByTimeAsync(2_000) // 1st poll: still unauthenticated
    expect(mockVerifyAuthAsync).toHaveBeenCalledTimes(2)
    expect(child.kill).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2_000) // 2nd poll: authenticated
    await credential // Req 7: `expires: 0` marker, no synthetic expiry
    expect(mockVerifyAuthAsync).toHaveBeenCalledTimes(3)
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    // non-blocking witness: every probe call — entry and ticks — was the
    // async variant (returned a Promise the flow awaited), never a sync spawn
    for (const result of mockVerifyAuthAsync.mock.results) {
      expect(result.value).toBeInstanceOf(Promise)
    }

    await cleanup()
  })

  test("abandoned login raises no unhandled rejection", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    mockVerifyAuthAsync.mockResolvedValue(UNAUTHENTICATED) // never logs in

    // belt-and-braces on top of vitest's own failure-on-unhandled-rejection:
    // a scoped listener captures anything that leaks during this test
    const captured: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      captured.push(reason)
    }
    process.on("unhandledRejection", onUnhandled)
    try {
      const h = makeMockContext()
      const { cleanup, authorize } = await setupWithAuthorize(h)

      // NO `.catch` attached by this test before the timeout fires
      const authorization = await authorize({})

      await vi.advanceTimersByTimeAsync(121_000) // > 120s poll budget → rejects
      await flush() // let Node run its unhandled-rejection sweep
      expect(captured).toEqual([])
      expect(vi.getTimerCount()).toBe(0)

      // second half of Req 6: the ORIGINAL promise was returned, so a late
      // consumer still observes the rejection (a swallowed promise would resolve)
      await expect(authorization.callback).rejects.toThrow(/`kiro-cli login`/)

      await cleanup()
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  test("returned callback is the original (rejection observable)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    mockVerifyAuthAsync.mockResolvedValue(UNAUTHENTICATED)
    const child = makeFakeChild()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExecFile.mockReturnValue(child as any)

    const h = makeMockContext()
    const { cleanup, authorize } = await setupWithAuthorize(h)

    const authorization = await authorize({})
    // a consumer attached up-front: `callback.catch(() => {})` as the RETURNED
    // value would resolve to undefined here instead of rejecting
    const rejection = expect(authorization.callback).rejects.toThrow(TIMEOUT_GUIDANCE)

    await vi.advanceTimersByTimeAsync(121_000)

    await rejection
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    await cleanup()
  })

  test("disposal mid-probe: no re-arm, no double-settle", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const probe = deferredStatus()
    // authorize entry resolves immediately (unauthenticated → spawn + poll);
    // the first TICK gets the manually-controlled pending probe
    mockVerifyAuthAsync.mockResolvedValueOnce(UNAUTHENTICATED).mockImplementation(() => probe.promise)
    const child = makeFakeChild()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExecFile.mockReturnValue(child as any)

    const h = makeMockContext()
    const { cleanup, authorize } = await setupWithAuthorize(h)

    const authorization = await authorize({})
    const rejection = expect(authorization.callback).rejects.toThrow(/cancelled/)

    await vi.advanceTimersByTimeAsync(2_000) // tick fires and is now IN FLIGHT
    expect(mockVerifyAuthAsync).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0) // timer cleared at tick start, not yet re-armed

    await cleanup() // disposal while the probe is pending → cancel
    await rejection
    expect(child.kill).toHaveBeenCalledTimes(1)

    // the LATE probe result arrives UNAUTHENTICATED with budget left — exactly
    // the input that would make an unguarded tick re-arm the 2s timer AFTER
    // cleanup (leaked timer) and later time out into a second settle. The
    // guarded tick must bail: cancelPoll was disarmed by the disposal.
    probe.resolve(UNAUTHENTICATED)
    await flush()
    expect(vi.getTimerCount()).toBe(0)

    // no leaked timer means no further probes ever run
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mockVerifyAuthAsync).toHaveBeenCalledTimes(2)
    expect(child.kill).toHaveBeenCalledTimes(1)
    // and the callback stays settled as cancelled (never re-settled as timeout)
    await expect(authorization.callback).rejects.toThrow(/cancelled/)
  })

  test("probe cadence: memo-friendly 2s ticks up to 120s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    mockVerifyAuthAsync.mockResolvedValue(UNAUTHENTICATED)

    const h = makeMockContext()
    const { cleanup, authorize } = await setupWithAuthorize(h)

    const authorization = await authorize({})
    expect(mockVerifyAuthAsync).toHaveBeenCalledTimes(1) // authorize entry probe
    const rejection = expect(authorization.callback).rejects.toThrow(TIMEOUT_GUIDANCE)

    // cadence constants (auth.ts POLL_INTERVAL_MS / MAX_WAIT_MS) unchanged by
    // the async tick: one probe per 2s tick, SDK 5s memo absorbs ~2 of every 3
    await vi.advanceTimersByTimeAsync(1_999)
    expect(mockVerifyAuthAsync).toHaveBeenCalledTimes(1) // nothing before 2s
    await vi.advanceTimersByTimeAsync(1)
    expect(mockVerifyAuthAsync).toHaveBeenCalledTimes(2) // 1st tick at exactly 2s
    await vi.advanceTimersByTimeAsync(2_000)
    expect(mockVerifyAuthAsync).toHaveBeenCalledTimes(3) // 2nd tick at 4s

    // ticks at 6s..120s: the 60th tick (t=120s) observes elapsed >= 120s → timeout
    await vi.advanceTimersByTimeAsync(116_000)
    await rejection
    expect(mockVerifyAuthAsync).toHaveBeenCalledTimes(61) // 1 entry + 60 ticks
    expect(vi.getTimerCount()).toBe(0)

    // no probe past the budget
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mockVerifyAuthAsync).toHaveBeenCalledTimes(61)

    await cleanup()
  })

  // Task 09 live-smoke defect (fix iteration 1): connect → abandon → reconnect
  // left a `kiro-cli login` child alive with no owner. `state.auth` is ONE
  // shared AuthResources; the second authorize() overwrote `child`/`cancelPoll`
  // without releasing the first attempt, orphaning its process from the
  // plugin's bookkeeping. Negative witness: without the supersede step the
  // first child is never killed (its poll now owns the SECOND child), so
  // `firstChild.kill` toHaveBeenCalledTimes(1) is the discriminating assertion.
  test("second authorize() while pending supersedes the first: one child alive at a time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    let authenticated = false
    mockVerifyAuthAsync.mockImplementation(async () => ({ installed: true, authenticated }))
    const firstChild = makeFakeChild()
    const secondChild = makeFakeChild()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExecFile.mockReturnValueOnce(firstChild as any).mockReturnValueOnce(secondChild as any)

    const h = makeMockContext()
    const { cleanup, authorize } = await setupWithAuthorize(h)

    // attempt 1: spawn + poll, then the user abandons the browser flow
    const first = await authorize({})
    expect(mockExecFile).toHaveBeenCalledTimes(1)
    const firstRejection = expect(first.callback).rejects.toThrow(/superseded/)
    await vi.advanceTimersByTimeAsync(2_000) // 1st tick: still unauthenticated
    expect(firstChild.kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)

    // attempt 2 while attempt 1 is pending
    const second = await authorize({})
    expect(mockExecFile).toHaveBeenCalledTimes(2)
    // previous child killed exactly once, BEFORE the new child was spawned
    // (never two `kiro-cli login` processes alive at the same time)
    expect(firstChild.kill).toHaveBeenCalledTimes(1)
    expect(firstChild.kill.mock.invocationCallOrder[0]).toBeLessThan(mockExecFile.mock.invocationCallOrder[1])
    // previous callback rejects with the supersession reason (not timeout, not cancelled)
    await firstRejection
    // only attempt 2's poll timer remains; attempt 1's was cleared, not orphaned
    expect(vi.getTimerCount()).toBe(1)
    expect(secondChild.kill).not.toHaveBeenCalled()

    // attempt 2 proceeds and resolves normally
    const credential = expect(second.callback).resolves.toEqual(EXPECTED_CREDENTIAL)
    await vi.advanceTimersByTimeAsync(2_000) // attempt 2, 1st tick: unauthenticated
    expect(secondChild.kill).not.toHaveBeenCalled()
    authenticated = true
    await vi.advanceTimersByTimeAsync(2_000) // attempt 2, 2nd tick: authenticated
    await credential
    expect(secondChild.kill).toHaveBeenCalledTimes(1)
    expect(firstChild.kill).toHaveBeenCalledTimes(1) // not killed again by attempt 2's release
    expect(vi.getTimerCount()).toBe(0)

    await cleanup()
    expect(firstChild.kill).toHaveBeenCalledTimes(1)
    expect(secondChild.kill).toHaveBeenCalledTimes(1)
  })

  // Companion lock for the tick's ownership guard: attempt 1's probe is IN
  // FLIGHT when attempt 2 supersedes it. The late probe result must not let
  // attempt 1's tick act on the shared fields — an `=== undefined` guard would
  // pass here (cancelPoll now holds attempt 2's canceller) and the stale tick
  // would kill attempt 2's child and disarm attempt 2's poll.
  test("supersession mid-probe: the stale tick neither re-arms nor touches the successor", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const probe = deferredStatus()
    mockVerifyAuthAsync
      .mockResolvedValueOnce(UNAUTHENTICATED) // attempt 1 entry
      .mockImplementationOnce(() => probe.promise) // attempt 1, 1st tick (held)
      .mockResolvedValueOnce(UNAUTHENTICATED) // attempt 2 entry
      .mockResolvedValueOnce(UNAUTHENTICATED) // attempt 2, 1st tick
      .mockResolvedValue(AUTHENTICATED) // attempt 2, 2nd tick
    const firstChild = makeFakeChild()
    const secondChild = makeFakeChild()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExecFile.mockReturnValueOnce(firstChild as any).mockReturnValueOnce(secondChild as any)

    const h = makeMockContext()
    const { cleanup, authorize } = await setupWithAuthorize(h)

    const first = await authorize({})
    const firstRejection = expect(first.callback).rejects.toThrow(/superseded/)
    await vi.advanceTimersByTimeAsync(2_000) // attempt 1 tick fires, probe IN FLIGHT
    expect(mockVerifyAuthAsync).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)

    const second = await authorize({})
    await firstRejection
    expect(firstChild.kill).toHaveBeenCalledTimes(1)
    expect(mockVerifyAuthAsync).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(1) // attempt 2's timer only
    const credential = expect(second.callback).resolves.toEqual(EXPECTED_CREDENTIAL)

    // the LATE result for attempt 1 arrives AUTHENTICATED — the input that
    // would make a stale, unguarded tick release attempt 2's child
    probe.resolve(AUTHENTICATED)
    await flush()
    expect(secondChild.kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1) // attempt 2's timer untouched, no extra re-arm

    await vi.advanceTimersByTimeAsync(2_000) // attempt 2, 1st tick: unauthenticated
    expect(secondChild.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000) // attempt 2, 2nd tick: authenticated
    await credential
    expect(mockVerifyAuthAsync).toHaveBeenCalledTimes(5)
    expect(secondChild.kill).toHaveBeenCalledTimes(1)
    expect(firstChild.kill).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    await cleanup()
  })

  // Phase 3 re-gate residual (check 3c): the supersede check used to be
  // followed by `await import("node:child_process")` BEFORE the spawn and the
  // cancelPoll claim. Two authorize() calls resuming in the same microtask
  // window both observed `cancelPoll === undefined`, then both spawned — two
  // `kiro-cli login` children alive, the first orphaned. The import is now
  // hoisted above the check so check → spawn → claim is one synchronous
  // segment. Negative witness: with the await back between check and spawn,
  // firstChild is never killed (`toHaveBeenCalledTimes(1)` fails with 0).
  //
  // Harness note: the two calls are NOT started in the same tick. vitest's
  // manual mocks do not survive two concurrent dynamic imports of one module
  // (the second `import("kiro-acp-ai-provider")` would resolve to the REAL
  // SDK and spawn kiro-cli), so each call is parked at its entry probe first
  // and both probes are then released in one synchronous segment — that puts
  // both continuations in the same microtask window at the supersede check,
  // which is exactly the race.
  test("two authorize() calls resuming in the same microtask window: exactly one child alive", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    let authenticated = false
    const probeA = deferredStatus()
    const probeB = deferredStatus()
    mockVerifyAuthAsync
      .mockImplementationOnce(() => probeA.promise) // attempt 1 entry (held)
      .mockImplementationOnce(() => probeB.promise) // attempt 2 entry (held)
      .mockImplementation(async () => ({ installed: true, authenticated })) // ticks
    const firstChild = makeFakeChild()
    const secondChild = makeFakeChild()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExecFile.mockReturnValueOnce(firstChild as any).mockReturnValueOnce(secondChild as any)

    const h = makeMockContext()
    const { cleanup, authorize } = await setupWithAuthorize(h)

    // park both attempts at their entry probes (imports done, nothing spawned)
    const a = authorize({})
    await flush()
    const b = authorize({})
    await flush()
    expect(mockVerifyAuthAsync).toHaveBeenCalledTimes(2)
    expect(mockExecFile).not.toHaveBeenCalled()

    // release both in ONE synchronous segment: both continuations now reach
    // the supersede check in the same microtask window
    probeA.resolve(UNAUTHENTICATED)
    probeB.resolve(UNAUTHENTICATED)
    const [first, second] = await Promise.all([a, b])
    expect(mockExecFile).toHaveBeenCalledTimes(2)

    // exactly ONE child alive: the first was killed exactly once, BEFORE the
    // second was spawned; the second is untouched
    expect(firstChild.kill).toHaveBeenCalledTimes(1)
    expect(firstChild.kill.mock.invocationCallOrder[0]).toBeLessThan(mockExecFile.mock.invocationCallOrder[1])
    expect(secondChild.kill).not.toHaveBeenCalled()
    // the first callback was superseded (not timeout, not cancelled); only the
    // second attempt's poll timer remains
    await expect(first.callback).rejects.toThrow(/superseded/)
    expect(vi.getTimerCount()).toBe(1)

    // the second attempt proceeds and resolves on an authenticated probe
    const credential = expect(second.callback).resolves.toEqual(EXPECTED_CREDENTIAL)
    await vi.advanceTimersByTimeAsync(2_000) // 1st tick: unauthenticated
    expect(secondChild.kill).not.toHaveBeenCalled()
    authenticated = true
    await vi.advanceTimersByTimeAsync(2_000) // 2nd tick: authenticated
    await credential
    expect(secondChild.kill).toHaveBeenCalledTimes(1)
    expect(firstChild.kill).toHaveBeenCalledTimes(1) // not killed again
    expect(vi.getTimerCount()).toBe(0)

    await cleanup()
    expect(firstChild.kill).toHaveBeenCalledTimes(1)
    expect(secondChild.kill).toHaveBeenCalledTimes(1)
  })
})
