# Security

Kiro CLI owns login and credential storage. This plugin does not copy Kiro credentials into OpenCode. Requests and tool calls pass through the official Kiro CLI ACP process. ACP permission requests are automatically approved for a single use where `allow_once` is offered and otherwise cancelled; they are not sent through OpenCode's permission UI. `trustAllTools` and persistent approvals are not enabled. Use trusted workspaces only.

To report a vulnerability in this fork, use the **Security** tab of [Laica-Lunasys/opencode-kiro](https://github.com/Laica-Lunasys/opencode-kiro) to open a private advisory. Do not disclose credentials or tokens in a public issue. Report Kiro CLI issues to Kiro and OpenCode core issues to OpenCode.
