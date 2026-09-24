import { execFile as execFileCallback } from "node:child_process"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { afterEach, describe, expect, test } from "vitest"

const execFile = promisify(execFileCallback)
const ROOT = join(import.meta.dirname, "..")
const tempDirs: string[] = []

const npmCli: string =
  process.env.npm_execpath ??
  (() => {
    throw new Error("npm_execpath is required for package tests")
  })()

function runNpm(args: string[], cwd: string) {
  return execFile(process.execPath, [npmCli, ...args], { cwd })
}
interface PackageManifest {
  name: string
  version: string
  repository: { url: string }
  exports: Record<string, { types?: string; default?: string } | string>
  dependencies: Record<string, string>
  peerDependencies: Record<string, string>
  scripts: Record<string, string>
}

async function manifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as PackageManifest
}

async function sourceFiles(): Promise<string> {
  const files = [
    "src/server.ts",
    "src/server/auth.ts",
    "src/server/aisdk.ts",
    "src/server/discovery.ts",
    "src/server/lifecycle.ts",
    "src/tui.ts",
    "tsup.config.ts",
  ]
  return Promise.all(files.map((file) => readFile(join(ROOT, file), "utf8"))).then((parts) =>
    parts.join("\n"),
  )
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("stable OpenCode v2 package contract", () => {
  test("manifest exposes the stable root plugin and automatic TUI subpath", async () => {
    const pkg = await manifest()
    expect(pkg.name).toBe("opencode-kiro")
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
    expect(pkg.repository.url).toBe("git+https://github.com/Laica-Lunasys/opencode-kiro.git")
    expect(pkg.exports["."]).toEqual({
      types: "./dist/server.d.ts",
      default: "./dist/server.js",
    })
    expect(pkg.exports["./server"]).toEqual(pkg.exports["."])
    expect(pkg.exports["./tui"]).toEqual({
      types: "./dist/tui.d.ts",
      default: "./dist/tui.js",
    })
  })

  test("host-sensitive runtime dependencies are exact pins", async () => {
    const pkg = await manifest()
    expect(pkg.dependencies).toMatchObject({
      "@opencode/plugin": "2.0.16",
      "@opentui/solid": "0.5.12",
      "kiro-acp-ai-provider": "3.2.0",
      "solid-js": "1.9.12",
    })
    expect(pkg.peerDependencies["@opentui/core"]).toBe("0.5.12")
    for (const version of [
      ...Object.values(pkg.dependencies),
      ...Object.values(pkg.peerDependencies),
    ]) {
      expect(version).not.toMatch(/[\^~*]/)
      expect(version).not.toMatch(/^(latest|next|beta|dev)$/)
    }
  })

  test("one check command covers typecheck, build, and tests", async () => {
    const pkg = await manifest()
    expect(pkg.scripts.check).toContain("typecheck")
    expect(pkg.scripts.check).toContain("test")
    expect(pkg.scripts.pretest).toContain("build")
    expect(pkg.scripts.prepare).toContain("build")
    expect(pkg.scripts.prepublishOnly).toContain("check")
  })

  test("source uses only the stable SDK package name", async () => {
    const source = await sourceFiles()
    expect(source).toContain("@opencode/plugin")
    expect(source).not.toContain("@opencode-ai/plugin")
    expect(source).not.toContain("0.0.0-dev-")
  })

  test("build emits server and TUI JavaScript plus declarations", async () => {
    await Promise.all(
      ["server.js", "server.d.ts", "tui.js", "tui.d.ts"].map((file) =>
        access(join(ROOT, "dist", file)),
      ),
    )
  })

  test("server root module exposes a stable v2 plugin definition", async () => {
    const module = await import(`${pathToFileURL(join(ROOT, "dist", "server.js")).href}?server`)
    expect(module.default).toMatchObject({ id: "kiro", setup: expect.any(Function) })
    expect(module.KiroAuthPlugin).toBe(module.default)
    expect("tui" in module.default).toBe(false)
  })

  test("TUI module is safe to load in plain Node before OpenTUI exists", async () => {
    const module = await import(`${pathToFileURL(join(ROOT, "dist", "tui.js")).href}?tui`)
    expect(module.default).toMatchObject({ id: "opencode-kiro", setup: expect.any(Function) })
  })

  test("host SDKs stay external to the built artifacts", async () => {
    const server = await readFile(join(ROOT, "dist", "server.js"), "utf8")
    const tui = await readFile(join(ROOT, "dist", "tui.js"), "utf8")
    expect(server).toContain("@opencode/plugin")
    expect(server.length).toBeLessThan(100_000)
    expect(tui.length).toBeLessThan(100_000)
  })
})

describe("distribution", () => {
  test("npm pack includes the manifest and both built entries", async () => {
    const { stdout } = await runNpm(["pack", "--ignore-scripts", "--dry-run", "--json"], ROOT)
    const result = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>
    const files = result[0]?.files.map((entry) => entry.path) ?? []
    expect(files).toContain("package.json")
    expect(files).toContain("dist/server.js")
    expect(files).toContain("dist/server.d.ts")
    expect(files).toContain("dist/tui.js")
    expect(files).toContain("dist/tui.d.ts")
    expect(files.some((file) => file.startsWith("src/"))).toBe(false)
    expect(files.some((file) => file.startsWith("test/"))).toBe(false)
  })

  test.skipIf(process.platform === "win32")(
    "a packed install resolves both root and TUI entries with runtime dependencies",
    async () => {
      const packDir = await mkdtemp(join(tmpdir(), "opencode-kiro-pack-"))
      const consumer = await mkdtemp(join(tmpdir(), "opencode-kiro-consumer-"))
      tempDirs.push(packDir, consumer)

      const { stdout } = await runNpm(
        ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir],
        ROOT,
      )
      const packed = JSON.parse(stdout) as Array<{ filename: string }>
      const tarball = join(packDir, packed[0]!.filename)
      await writeFile(join(consumer, "package.json"), '{"private":true,"type":"module"}\n')
      await runNpm(
        ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
        consumer,
      )

      const probe = [
        'const server = await import("opencode-kiro")',
        'const tui = await import("opencode-kiro/tui")',
        'const solid = await import("solid-js")',
        'console.log(JSON.stringify({server:server.default.id,tui:tui.default.id,solid:typeof solid.createSignal}))',
      ].join(";")
      const { stdout: probeOutput } = await execFile(
        process.execPath,
        ["--input-type=module", "--eval", probe],
        { cwd: consumer },
      )
      expect(JSON.parse(probeOutput)).toEqual({
        server: "kiro",
        tui: "opencode-kiro",
        solid: "function",
      })
    },
    120_000,
  )

  test("README documents GitHub install, macOS/Linux, ACP, and Opus 5", async () => {
    const readme = await readFile(join(ROOT, "README.md"), "utf8")
    expect(readme).toContain("github:Laica-Lunasys/opencode-kiro#main")
    expect(readme).toContain("macOS")
    expect(readme).toContain("Linux")
    expect(readme).toContain("kiro-cli acp")
    expect(readme).toContain("kiro/claude-opus-5")
    expect(readme).toContain('"plugins"')
  })

  test("compatibility and changelog describe the current release", async () => {
    const pkg = await manifest()
    const [compatibility, changelog] = await Promise.all([
      readFile(join(ROOT, "docs", "COMPATIBILITY.md"), "utf8"),
      readFile(join(ROOT, "CHANGELOG.md"), "utf8"),
    ])
    expect(compatibility).toContain(`\`${pkg.version}\``)
    expect(compatibility).toContain("OpenCode | `2.0.16`")
    expect(changelog).toContain(`## [${pkg.version}]`)
    expect(changelog).toContain("claude-opus-5")
  })

  test("production source contains no machine-specific home path", async () => {
    const source = await sourceFiles()
    expect(source).not.toMatch(/\/home\/[A-Za-z0-9._-]+/)
    expect(source).not.toContain("/Users/")
    expect(source).toContain("context.location.directory")
  })
})
