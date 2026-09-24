# opencode-kiro (OpenCode V2 fork)

Use Amazon Kiro models in OpenCode V2 through the official `kiro-cli acp` interface. The plugin reads the available model IDs, context windows, and credit multipliers from `kiro-cli chat --list-models --format json` at startup and refreshes the catalog every ten minutes. No manually maintained model list or separate HTTP gateway is needed.

This is an independent [MIT-licensed fork](https://github.com/NachoFLizaur/opencode-kiro) for OpenCode **2.0.16**. It intentionally implements only the V2 provider integration; the upstream V1 auth and TUI credits views are not included. Kiro CLI manages authentication, and OpenCode does not store Kiro credentials.

## Install (macOS or Linux)

1. Install [OpenCode V2](https://opencode.ai/v2/docs/cli/), [Kiro CLI](https://kiro.dev/docs/cli/), and Node.js 20 or newer. Ensure `kiro-cli` is on the `PATH` seen by OpenCode.
2. Run `kiro-cli login` and verify that `kiro-cli chat --list-models --format json` returns a model inventory. Complete the login in your browser before launching OpenCode.
3. Add the Git package to OpenCode:

   ```sh
   opencode plugin add 'github:Laica-Lunasys/opencode-kiro#v2'
   ```

   Alternatively, add `"github:Laica-Lunasys/opencode-kiro#v2"` to the `plugins` array in `~/.config/opencode/opencode.jsonc` (create it if absent). Keep any existing plugin entries. For reproducible installations, replace `v2` with a full commit hash.
4. Start or restart OpenCode. Select `kiro/auto`, or use any model shown by `opencode models` with the `kiro/` prefix. For a quick test:

   ```sh
   opencode run --standalone --model kiro/auto 'Say hello'
   ```

Plugin installation from Git runs the package `prepare` build; a Node.js installation is therefore necessary on the machine where OpenCode installs the plugin. New Kiro CLI model IDs appear after OpenCode restarts or the next ten-minute refresh. If `kiro-cli` is unavailable or not authenticated at startup, plugin activation fails with a CLI error; log in and restart OpenCode.

## Develop or install from a checkout

```sh
git clone --branch v2 https://github.com/Laica-Lunasys/opencode-kiro.git
cd opencode-kiro
npm ci
npm run check
```

Configure the **directory** of the checkout in your global or project `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-kiro"],
}
```

The root `index.js` is the local-directory entrypoint. Pointing to `dist/index.js` as a configured plugin path is not supported by OpenCode 2.0.16. Run `npm run build` and restart OpenCode after modifying the TypeScript source. Update a checkout with `git pull` and `npm ci`.

## Behavior and limitations

- Kiro CLI is launched for catalog discovery; model requests use `kiro-acp-ai-provider@3.2.0`, which communicates with the official `kiro-cli acp` process. The current working directory is passed to the ACP provider.
- The last valid inventory remains available if a periodic refresh fails. Startup needs a valid, nonempty inventory. Credits shown in model names are multipliers, not prices.
- ACP tool permission requests are automatically approved **once** when Kiro offers that choice; otherwise they are cancelled. This does not prompt through OpenCode's permission UI. Only use this plugin in trusted workspaces and review the tools Kiro can access. The plugin does **not** enable `--trust-all-tools` or grant persistent approvals.
- The model list can depend on your account and Kiro CLI version. No promise is made that each listed preview model will accept every request.
- This fork is not published to npm. To update a Git-installed plugin, run `opencode plugin update` and restart OpenCode. Do not install the upstream npm `opencode-kiro` package for V2.

Run `npm run check` for typecheck, catalog tests, and build. CI runs on macOS, Linux, and Windows. The provider was also exercised with OpenCode 2.0.16 and a live `kiro/claude-opus-5` request on Linux.

Original copyright and MIT terms are preserved in [LICENSE](LICENSE).
