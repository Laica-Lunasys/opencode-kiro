import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import type { Plugin } from "@opencode-ai/plugin"
import type { ModelWithEfforts } from "kiro-acp-ai-provider"
import { createKiroAcp, listModels, verifyAuth } from "kiro-acp-ai-provider"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import serverPlugin from "../src/server"

// v2 behavior suite (task 08). Everything is driven through
// `serverPlugin.setup(mockContext)` plus module mocks — never through module
// internals. Assertions come from the acceptance criteria of tasks 05/06/07
// and the migration doc's Test matrix (Auth/Models/Variants/AISDK/Lifecycle).

// Hermetic: the SDK is mocked so no kiro-cli is ever spawned and no network is
// touched; child_process.execFile is mocked so the login flow gets a fake
// killable child; login poll/timeout tests use fake timers.
vi.mock("kiro-acp-ai-provider", () => ({
  verifyAuth: vi.fn(),
  listModels: vi.fn(),
  createKiroAcp: vi.fn(),
}))
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}))

const mockVerifyAuth = vi.mocked(verifyAuth)
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
 */
function makeMockContext() {
  const directory = mkdtempSync(join(tmpdir(), "kiro-v2-test-"))
  tmpDirs.push(directory)

  let integrationTransformCb: ((draft: unknown) => void) | undefined
  let catalogTransformCb: ((draft: unknown) => void) | undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sdkHookCb: ((event: any) => Promise<void> | void) | undefined
  let sdkHookName: string | undefined
  let sdkHookOptions: unknown

  const disposeSpies = {
    integration: vi.fn(async () => {}),
    catalog: vi.fn(async () => {}),
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
        sdkHookName = name
        sdkHookCb = cb
        sdkHookOptions = options
        return { dispose: disposeSpies.hook }
      }),
    },
    event: { subscribe: vi.fn(() => events.iterable) },
  }

  return {
    context: raw as unknown as Plugin.Context,
    raw,
    directory,
    reload,
    active,
    events,
    disposeSpies,
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
      if (sdkHookCb === undefined) throw new Error("sdk hook not registered")
      return sdkHookCb(event)
    },
    getSdkHookName: () => sdkHookName,
    getSdkHookOptions: () => sdkHookOptions,
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
  mockVerifyAuth.mockReset()
  mockVerifyAuth.mockReturnValue({ installed: true, authenticated: true })
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
    mockVerifyAuth.mockReturnValue({ installed: false, authenticated: false })
    const h = makeMockContext()
    const { cleanup, authorize } = await setupWithAuthorize(h)

    await expect(authorize({})).rejects.toThrow(/Install it from https:\/\/kiro\.dev\/docs\/cli\//)
    expect(mockExecFile).not.toHaveBeenCalled()

    await cleanup()
  })

  test("already authenticated resolves immediately with Credential.OAuth", async () => {
    mockVerifyAuth.mockReturnValue({ installed: true, authenticated: true })
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
    mockVerifyAuth.mockImplementation(() => ({ installed: true, authenticated }))
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
      mockVerifyAuth.mockReturnValue({ installed: true, authenticated: false })

      const h = makeMockContext()
      const { cleanup, authorize } = await setupWithAuthorize(h)

      const authorization = await authorize({})
      authorization.callback.catch(() => {}) // cancelled by cleanup below

      expect(mockExecFile).toHaveBeenCalledWith("kiro-cli", ["login"], { shell: true })

      await cleanup()
    } finally {
      if (originalPlatform !== undefined) Object.defineProperty(process, "platform", originalPlatform)
    }
  })

  test("timeout kills child and carries manual kiro-cli login guidance", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    mockVerifyAuth.mockReturnValue({ installed: true, authenticated: false })
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
    mockVerifyAuth.mockReturnValue({ installed: true, authenticated: false })
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
    expect(mockCreateKiroAcp).toHaveBeenCalledWith(event.options)
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

  test("owned instances are reused per options key and shut down exactly once on cleanup", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)

    const eventA1 = { model: {}, package: "kiro-acp-ai-provider", options: { cwd: "/a" }, sdk: undefined as unknown }
    const eventA2 = { model: {}, package: "kiro-acp-ai-provider", options: { cwd: "/a" }, sdk: undefined as unknown }
    const eventB = { model: {}, package: "kiro-acp-ai-provider", options: { cwd: "/b" }, sdk: undefined as unknown }
    await h.sdkHook(eventA1)
    await h.sdkHook(eventA2)
    await h.sdkHook(eventB)

    // stable-options reuse: same options -> same owned instance
    expect(eventA2.sdk).toBe(eventA1.sdk)
    expect(eventB.sdk).not.toBe(eventA1.sdk)
    expect(sdkInstances).toHaveLength(2)

    await cleanup()
    for (const instance of sdkInstances) expect(instance.shutdown).toHaveBeenCalledTimes(1)

    await cleanup() // second cleanup must not shut anything down again
    for (const instance of sdkInstances) expect(instance.shutdown).toHaveBeenCalledTimes(1)
  })

  test("cleanup is idempotent and complete across auth, discovery and aisdk", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    mockVerifyAuth.mockReturnValue({ installed: true, authenticated: false })

    const h = makeMockContext()
    const { cleanup, authorize } = await setupWithAuthorize(h)

    // put a login poll in flight so cleanup has timers + a child to release
    const authorization = await authorize({})
    authorization.callback.catch(() => {}) // settled by disposal
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    const first = cleanup()
    const second = cleanup()
    await Promise.all([first, second])

    expect(h.disposeSpies.integration).toHaveBeenCalledTimes(1)
    expect(h.disposeSpies.catalog).toHaveBeenCalledTimes(1)
    expect(h.disposeSpies.hook).toHaveBeenCalledTimes(1)
    expect(h.events.returned).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    // a later third call is equally safe and disposes nothing again
    await cleanup()
    expect(h.disposeSpies.integration).toHaveBeenCalledTimes(1)
    expect(h.disposeSpies.hook).toHaveBeenCalledTimes(1)
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

  // B3 regression lock (HOST_E2E_REPORT.md): end-to-end witness for the one
  // effort mechanism that actually works at the pinned host SHA — variant
  // settings -> host `withVariant` overlay -> `aisdk` hook `event.options` ->
  // `createKiroAcp({ effort })`. The host builds per-call `providerOptions`
  // only for `@ai-sdk/*` families, so the SDK factory setting is the sole
  // carrier and the key must be the SDK's `effort`, never `reasoningEffort`.
  test("the SDK effort key flows from the effort variant into createKiroAcp options", async () => {
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

    expect(mockCreateKiroAcp).toHaveBeenCalledWith(
      expect.objectContaining({ effort: "high", cwd: h.directory }),
    )
    expect(mockCreateKiroAcp).not.toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: expect.anything() }),
    )
    // the owned provider serves the model the request path resolves
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((event.sdk as any).languageModel("with-efforts")).toBeDefined()

    await cleanup()
  })
})
