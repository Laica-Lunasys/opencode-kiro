import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

// Built-package smoke tests: run `npm run build` first. Covers exports
// resolution, discoverable metadata, exact v2-sensitive pins, the installed
// plugin tarball's v2 exports layout, emitted artifacts, the v2 { id, setup }
// module contracts, idempotent cleanup, module-kind isolation, and
// host-package externalization.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const distPath = (name: string): string => join(ROOT, "dist", name)

interface ExportsEntry {
  types?: string
  default?: string
}

interface PackageJson {
  version?: string
  exports: Record<string, ExportsEntry | string>
  keywords?: string[]
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  files?: string[]
}

const readPkg = async (): Promise<PackageJson> =>
  JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as PackageJson

/** v2 plugin module shape: `{ id, setup }` with a callable setup. */
interface PluginModule {
  id?: unknown
  setup?: unknown
  [key: string]: unknown
}

/** Import a built module via a runtime URL so tsc never resolves dist/. */
const importDist = (name: string): Promise<{ default: PluginModule } & Record<string, unknown>> =>
  import(pathToFileURL(distPath(name)).href) as Promise<{ default: PluginModule } & Record<string, unknown>>

/**
 * Blank out every module specifier (import / export-from / require) so residual
 * package names reveal a bundled external, e.g. an esbuild inlined-source path.
 */
const withoutImportSpecifiers = (code: string): string =>
  code.replace(
    /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'])[^"']*\2/g,
    (_match, keyword: string, quote: string) => `${keyword}${quote}${quote}`,
  )

/**
 * Spec-mandated string constants that legitimately carry the SDK package name
 * in module bodies: the `event.package` match value (bare name) and the
 * `Provider.Info.package` value (`aisdk:`-prefixed). Blank their quoted
 * literals so the zero-residue check flags only real bundling. Longest first
 * so the prefixed literal is consumed before the bare one.
 */
const MANDATED_PACKAGE_LITERALS = ["aisdk:kiro-acp-ai-provider", "kiro-acp-ai-provider"]

const withoutMandatedLiterals = (code: string): string =>
  MANDATED_PACKAGE_LITERALS.reduce(
    (acc, literal) => acc.replaceAll(`"${literal}"`, '""').replaceAll(`'${literal}'`, "''"),
    code,
  )

/**
 * Minimal mock v2 Plugin.Context: just enough surface for the server setup's
 * three registrations (integration/auth, catalog/discovery, aisdk hook) plus
 * the event consumer. Registrations return async disposers; the event stream
 * ends immediately; the connection reads inactive so no discovery kicks off.
 */
const makeMinimalContext = (): unknown => {
  const registration = { dispose: async () => {} }
  return {
    integration: {
      transform: async () => registration,
      list: async () => ({ location: { directory: ROOT } }),
      connection: { active: async () => false },
    },
    catalog: {
      transform: async () => registration,
      reload: async () => {},
    },
    aisdk: { hook: async () => registration },
    event: { subscribe: () => (async function* () {})() },
  }
}

/**
 * Minimal mock v2 TUI Plugin.Context: the host always supplies `data` and
 * `ui` (verified live in HOST_E2E_REPORT.md item 9's setup invocation), so
 * the setup contract may rely on them. Event subscription and slot
 * registration return unsubscribe functions; durable reads return no
 * messages.
 */
const makeMinimalTuiContext = (): unknown => ({
  data: {
    on: () => () => {},
    session: { message: { list: () => [] } },
  },
  ui: { slot: () => () => {} },
})

describe("scaffold package contract", () => {
  test("exports map exposes exactly ./server and ./tui subpaths", async () => {
    const pkg = await readPkg()

    expect(Object.keys(pkg.exports).sort()).toEqual(["./package.json", "./server", "./tui"])
    expect(pkg.exports["./server"]).toEqual({ types: "./dist/server.d.ts", default: "./dist/server.js" })
    expect(pkg.exports["./tui"]).toEqual({ types: "./dist/tui.d.ts", default: "./dist/tui.js" })
  })

  test("package metadata is plugin-discoverable", async () => {
    const pkg = await readPkg()

    expect(pkg.keywords).toContain("opencode")
    expect(pkg.keywords).toContain("opencode-plugin")
    expect(pkg.files).toEqual(["dist"])
  })

  test("build emits all four artifacts", () => {
    const artifacts = ["server.js", "server.d.ts", "tui.js", "tui.d.ts"]

    const missing = artifacts.filter((artifact) => !existsSync(distPath(artifact)))

    expect(missing).toEqual([])
  })

  test("no credits-chip chunk survives (composer strip descoped at re-pin)", async () => {
    // The re-pin SHA's typed SlotMap removed session.composer.top; the chip view
    // and its lazy-import chunk were deleted — only the box view chunk may exist.
    const distFiles = await readdir(join(ROOT, "dist"))

    expect(distFiles.filter((file) => file.includes("credits-chip-view"))).toEqual([])
    expect(distFiles.some((file) => file.includes("credits-box-view"))).toBe(true)
  })
})

describe("pins and installed tarball (task 02)", () => {
  test("version is 0.5.0-beta.1", async () => {
    const pkg = await readPkg()

    expect(pkg.version).toBe("0.5.0-beta.1")
  })

  test("v2-sensitive deps are exact pins", async () => {
    const pkg = await readPkg()

    // exact expected specifier per dependency block; no `^`/`~`/`*`, no dist-tag
    const expected: Array<[Record<string, string> | undefined, string, string]> = [
      [pkg.devDependencies, "@opencode-ai/plugin", "0.0.0-next-16420"],
      [pkg.peerDependencies, "@opencode-ai/plugin", "0.0.0-next-16420"],
      [pkg.dependencies, "@opentui/solid", "0.4.5"],
      [pkg.dependencies, "solid-js", "1.9.12"],
      [pkg.dependencies, "kiro-acp-ai-provider", "3.0.0"],
    ]

    for (const [block, name, version] of expected) {
      const specifier = block?.[name]
      expect(specifier, `${name} must be pinned exactly`).toBe(version)
      expect(specifier).not.toMatch(/[\^~*]/)
      expect(specifier).not.toMatch(/^(next|latest|beta|dev)$/)
    }
  })

  test("installed plugin package has v2 exports layout", async () => {
    const installed = JSON.parse(
      await readFile(join(ROOT, "node_modules", "@opencode-ai", "plugin", "package.json"), "utf8"),
    ) as { exports?: Record<string, unknown> }

    const subpaths = Object.keys(installed.exports ?? {})
    expect(subpaths).toContain(".")
    expect(subpaths).toContain("./effect")
    expect(subpaths).toContain("./tui")
    // the stale v1-era layout routes the promise API through ./v2/promise; reject it
    expect(subpaths).not.toContain("./v2/promise")
  })
})

describe("v2 module contracts (task 03)", () => {
  test("server entry exports { id: 'kiro', setup }", async () => {
    const mod = await importDist("server.js")

    expect(mod.default.id).toBe("kiro")
    expect(typeof mod.default.setup).toBe("function")
    // named export kept for compatibility; same reference as the default so they can't drift
    expect(mod.KiroAuthPlugin).toBe(mod.default)
    // loader rejects modules exposing both kinds: no v1 wrapper properties anywhere
    expect("server" in mod.default).toBe(false)
    expect("tui" in mod.default).toBe(false)
  })

  test("tui entry exports { id: 'opencode-kiro', setup }", async () => {
    const mod = await importDist("tui.js")

    expect(mod.default.id).toBe("opencode-kiro")
    expect(typeof mod.default.setup).toBe("function")
    expect("server" in mod.default).toBe(false)
    expect("tui" in mod.default).toBe(false)
  })

  test("tui dist loads under plain Node", async () => {
    // vitest runs in the node environment: a successful import proves the
    // Bun-native @opentui/core runtime is not pulled eagerly (lazy-import rule)
    await expect(importDist("tui.js")).resolves.toBeDefined()
  })

  test("host packages are not bundled", async () => {
    const builtModules = ["server.js", "tui.js"]

    for (const file of builtModules) {
      const code = await readFile(distPath(file), "utf8")
      const residue = withoutMandatedLiterals(withoutImportSpecifiers(code))

      // Externals may appear as import specifiers (which must survive the
      // build — server.js lazily imports the SDK) or as the spec-mandated
      // package-name constants; any OTHER residual mention means the host/SDK
      // package was bundled instead of left external.
      expect(residue).not.toContain("kiro-acp-ai-provider")
      expect(residue).not.toContain("@opencode-ai/plugin")
      expect(residue).not.toContain("@opentui")
      expect(residue).not.toContain("solid-js")
    }

    // the lazy SDK imports must remain literal external specifiers
    const serverCode = await readFile(distPath("server.js"), "utf8")
    expect(serverCode).toContain('import("kiro-acp-ai-provider")')
  })

  test("server cleanup is idempotent", async () => {
    const mod = await importDist("server.js")
    const setup = mod.default.setup as (context: unknown) => Promise<() => Promise<void>>

    // server setup registers auth/discovery/aisdk, so it needs the minimal v2 context
    const cleanup = await setup(makeMinimalContext())

    await expect(cleanup()).resolves.toBeUndefined()
    await expect(cleanup()).resolves.toBeUndefined() // second call is a no-op
  })

  test("tui cleanup is idempotent", async () => {
    const mod = await importDist("tui.js")
    const setup = mod.default.setup as (context: unknown) => Promise<() => Promise<void>>

    const cleanup = await setup(makeMinimalTuiContext())

    await expect(cleanup()).resolves.toBeUndefined()
    await expect(cleanup()).resolves.toBeUndefined() // second call is a no-op
  })
})

// --- Phase 4 packaging / entry-resolution tests (task 14) ---

const execFileAsync = promisify(execFile)
const IS_WIN = process.platform === "win32"

/** Run npm via execFile; Windows needs npm.cmd + shell (see CI note in task file). */
const runNpm = async (args: string[], cwd: string): Promise<string> => {
  const { stdout } = await execFileAsync(IS_WIN ? "npm.cmd" : "npm", args, {
    cwd,
    shell: IS_WIN,
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout
}

/**
 * Run an ESM snippet in a REAL child Node process with the given cwd. Bare
 * specifiers then resolve with native Node semantics from that directory —
 * vitest's own resolver (which sees this repo's node_modules) never
 * participates, so the probe behaves exactly like the OpenCode host loading
 * the installed package.
 */
const nodeProbe = async (cwd: string, code: string): Promise<string> => {
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", code], { cwd })
  return stdout.trim()
}

/** v2-sensitive pins derived from package.json — the single source the docs must mirror. */
const v2SensitivePins = async (): Promise<Array<[name: string, version: string]>> => {
  const pkg = await readPkg()
  return [
    ["@opencode-ai/plugin", pkg.devDependencies?.["@opencode-ai/plugin"] ?? ""],
    ["@opentui/solid", pkg.dependencies?.["@opentui/solid"] ?? ""],
    ["solid-js", pkg.dependencies?.["solid-js"] ?? ""],
    ["kiro-acp-ai-provider", pkg.dependencies?.["kiro-acp-ai-provider"] ?? ""],
  ]
}

const TESTED_OPENCODE_SHA = "b47cfbee7c4fd24e5d73e5753b4755db62a92a63"
const RELEASE_NOTES_FILE = "RELEASE_NOTES_0.5.0-beta.1.md"

describe("packaging and docs invariants (task 12)", () => {
  test("pack payload is dist-only", async () => {
    const stdout = await runNpm(["pack", "--dry-run", "--json"], ROOT)
    const [manifest] = JSON.parse(stdout) as Array<{ filename: string; files: Array<{ path: string }> }>
    const paths = manifest.files.map((file) => file.path)

    // tarball name embeds the pinned prerelease version
    expect(manifest.filename).toBe("opencode-kiro-0.5.0-beta.1.tgz")

    // exhaustive whitelist: built artifacts + the three npm-mandated metadata files
    const stray = paths.filter(
      (path) => !(path.startsWith("dist/") || path === "package.json" || path === "README.md" || path === "LICENSE"),
    )
    expect(stray).toEqual([])

    // never ship sources or tests, even if `files` drifts
    expect(paths.filter((path) => path.startsWith("src/") || path.startsWith("test/"))).toEqual([])

    // the four required artifacts must actually be in the payload
    for (const required of ["package.json", "README.md", "dist/server.js", "dist/tui.js"]) {
      expect(paths).toContain(required)
    }
    expect(paths.some((path) => path === "dist/server.d.ts")).toBe(true)
    expect(paths.some((path) => path === "dist/tui.d.ts")).toBe(true)
  }, 60_000)

  test("pins consistent across package.json / PINNED_VERSIONS / release notes", async () => {
    const pkg = await readPkg()
    const pins = await v2SensitivePins()
    const pinned = await readFile(join(ROOT, "PINNED_VERSIONS.md"), "utf8")
    const notes = await readFile(join(ROOT, RELEASE_NOTES_FILE), "utf8")

    // package.json is internally consistent: dev and peer pins of the plugin API match
    expect(pkg.devDependencies?.["@opencode-ai/plugin"]).toBe(pkg.peerDependencies?.["@opencode-ai/plugin"])

    // each document's pin-table row must carry EXACTLY the package.json specifier;
    // any drift in either direction breaks the row match
    for (const [name, version] of pins) {
      expect(version, `${name} must be pinned in package.json`).not.toBe("")
      const row = `| \`${name}\` | \`${version}\` |`
      expect(pinned, `PINNED_VERSIONS.md row for ${name}@${version}`).toContain(row)
      expect(notes, `${RELEASE_NOTES_FILE} row for ${name}@${version}`).toContain(row)
    }

    // prerelease version string agrees everywhere (the notes filename pins it too)
    expect(pkg.version).toBe("0.5.0-beta.1")
    expect(pinned).toContain("0.5.0-beta.1")
    expect(notes).toContain("0.5.0-beta.1")
  })

  test("README documents plural plugins for server and cli.json for TUI", async () => {
    const readme = await readFile(join(ROOT, "README.md"), "utf8")

    // plural v2 config key sample present (server opencode.json + TUI cli.json)
    expect(readme).toContain('"plugins": [')
    expect(readme).toContain("cli.json")

    // no config snippet targets tui.json and no v1 singular `plugin` array survives
    const codeBlocks = readme.match(/```[\s\S]*?```/g) ?? []
    expect(codeBlocks.length).toBeGreaterThan(0)
    for (const block of codeBlocks) {
      expect(block).not.toContain("tui.json")
      expect(block).not.toContain('"plugin": [')
    }
  })

  test("release notes carry tested SHA and no floating tags", async () => {
    const notes = await readFile(join(ROOT, RELEASE_NOTES_FILE), "utf8")

    expect(notes).toContain(TESTED_OPENCODE_SHA)

    // no `pkg@latest` / `pkg@next` / `pkg@beta` / `pkg@dev` install specifier anywhere
    expect(notes).not.toMatch(/@(latest|next|beta|dev)(?![\w.-])/)
    // and no floating range specifiers for the v2-sensitive deps
    for (const [name] of await v2SensitivePins()) {
      expect(notes).not.toMatch(new RegExp(`\`${name}\`\\s*\\|\\s*\`[~^*]`))
    }
  })
})

describe("packed tarball entry resolution (task 13)", () => {
  let workDir: string
  let consumerDir: string
  let installedPluginDir: string

  // Single real pack + single hermetic temp-dir install, reused by every test
  // below. `--cache` points at a throwaway cache and `--omit=peer` skips the
  // host-provided plugin API (dist/*.js carries no runtime import of
  // @opencode-ai/plugin — asserted by "host packages are not bundled" above).
  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "opencode-kiro-pack-"))
    consumerDir = join(workDir, "consumer")

    const packJson = await runNpm(["pack", "--json", "--pack-destination", workDir], ROOT)
    const [{ filename }] = JSON.parse(packJson) as Array<{ filename: string }>
    const tarball = join(workDir, filename)

    await mkdir(consumerDir)
    await writeFile(
      join(consumerDir, "package.json"),
      JSON.stringify({ name: "opencode-kiro-consumer", private: true, type: "module" }, null, 2),
    )

    await runNpm(
      [
        "install",
        tarball,
        "--omit=peer",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--cache",
        join(workDir, "npm-cache"),
      ],
      consumerDir,
    )
    installedPluginDir = join(consumerDir, "node_modules", "opencode-kiro")
  }, 300_000)

  afterAll(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true })
  })

  test("packed ./server resolves and exposes v2 shape", async () => {
    const out = await nodeProbe(
      consumerDir,
      `const mod = await import("opencode-kiro/server");
       console.log(JSON.stringify({
         id: mod.default?.id,
         setup: typeof mod.default?.setup,
         hasServerProp: "server" in (mod.default ?? {}),
         hasTuiProp: "tui" in (mod.default ?? {}),
         namedIsDefault: mod.KiroAuthPlugin === mod.default,
       }));`,
    )

    expect(JSON.parse(out)).toEqual({
      id: "kiro",
      setup: "function",
      hasServerProp: false,
      hasTuiProp: false,
      namedIsDefault: true,
    })
  }, 30_000)

  test("packed ./tui resolves without server-only or Bun-native load", async () => {
    const out = await nodeProbe(
      consumerDir,
      `const mod = await import("opencode-kiro/tui");
       console.log(JSON.stringify({
         id: mod.default?.id,
         setup: typeof mod.default?.setup,
         hasServerProp: "server" in (mod.default ?? {}),
         hasTuiProp: "tui" in (mod.default ?? {}),
         crossEntryLeak: "KiroAuthPlugin" in mod,
       }));`,
    )

    // plain-Node import succeeds (no eager Bun-native @opentui/core) and the
    // module carries only the TUI plugin — no server-entry leakage
    expect(JSON.parse(out)).toEqual({
      id: "opencode-kiro",
      setup: "function",
      hasServerProp: false,
      hasTuiProp: false,
      crossEntryLeak: false,
    })
  }, 30_000)

  test("root fallback understood", async () => {
    // HOST_E2E_REPORT.md O1: the exports map intentionally lacks a root (".")
    // entry, so the host's root fallback yields no entrypoint and `./server`
    // (tried first) wins. Lock both halves of that contract.
    const pkg = await readPkg()
    expect(Object.keys(pkg.exports)).not.toContain(".")

    const out = await nodeProbe(
      consumerDir,
      `try {
         await import("opencode-kiro");
         console.log(JSON.stringify({ resolved: true }));
       } catch (error) {
         console.log(JSON.stringify({ resolved: false, code: error.code }));
       }`,
    )
    expect(JSON.parse(out)).toEqual({ resolved: false, code: "ERR_PACKAGE_PATH_NOT_EXPORTED" })
  }, 30_000)

  test("packed TUI runtime dependencies resolve and setup activates (B2 regression lock)", async () => {
    // Regression lock for HOST_E2E_REPORT.md blocker B2: the host installs the
    // tarball into an isolated tree containing only its declared dependencies,
    // so the TUI entry's lazily-imported view stack must be resolvable from
    // there and setup() must activate. Fixed in gate iteration 1 by declaring
    // @opentui/solid + solid-js as real `dependencies` (they stay bundler
    // externals, so dist never inlines them; @opentui/core arrives transitively
    // via @opentui/solid, which depends on it exactly). Do not weaken — this is
    // the automated witness for the e2e finding.
    const tuiPath = join(installedPluginDir, "dist", "tui.js")
    const out = await nodeProbe(
      consumerDir,
      `import { createRequire } from "node:module";
       const req = createRequire(${JSON.stringify(tuiPath)});
       const result = { resolved: {}, activated: false, error: null };
       for (const dep of ["@opentui/solid", "solid-js"]) {
         try { req.resolve(dep); result.resolved[dep] = true } catch { result.resolved[dep] = false }
       }
       try {
         const mod = await import("opencode-kiro/tui");
         // minimal host-shaped TUI context (host always supplies data + ui)
         const context = {
           data: { on: () => () => {}, session: { message: { list: () => [] } } },
           ui: { slot: () => () => {} },
         };
         const cleanup = await mod.default.setup(context);
         result.activated = true;
         await cleanup();
       } catch (error) {
         result.error = String((error && error.message) || error);
       }
       console.log(JSON.stringify(result));`,
    )

    expect(JSON.parse(out)).toEqual({
      resolved: { "@opentui/solid": true, "solid-js": true },
      activated: true,
      error: null,
    })
  }, 30_000)

  // Note (task 14 Step 3, resolved in gate iteration 1): the only e2e-derived
  // lock that belongs in this packaging suite is the B2 dependency-resolvability
  // lock above — it needs a packed tarball installed into an isolated tree.
  // B3 (effort settings key) is deliberately NOT locked here: it is a pure
  // in-process catalog/hook contract, so its locks live in the server suite
  // where the mocked SDK can witness the whole path —
  // `test/server.test.ts` "discovery: catalog transform ..." (emitted
  // `settings.effort`, `reasoningEffort` absent) plus "the SDK effort key flows
  // from the effort variant into createKiroAcp options" (variant overlay ->
  // `event.options` -> `createKiroAcp({ effort })`). `src/server/discovery.ts`
  // additionally pins the key at compile time via
  // `satisfies Pick<KiroACPProviderSettings, "effort">`.
})
