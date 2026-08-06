---
name: codex-runtime-bridge
description: Use DevSpace's stable plugin_query/plugin_action dispatcher for local Codex inventory, redacted shell snapshots, Git workspace checkpoints, and Windows keep-awake sessions. Prefer these tools over raw shell commands when the requested operation matches.
---

# Codex Runtime Bridge

Use plugin id `codex-runtime-bridge` through the stable DevSpace plugin dispatcher.

Read-only operations use `plugin_query`:

- `inventory`: inspect the local Codex version, enabled features, installed plugins, and failing doctor checks.
- `shell_snapshot`: capture a redacted runtime, PATH, executable, environment, and Git snapshot.
- `checkpoint_list`: list hidden Git checkpoints in the current workspace.
- `keep_awake_status`: check the Windows keep-awake process.

State-changing operations use `plugin_action`:

- `checkpoint_create` with parameter `name`.
- `checkpoint_restore` with parameters `checkpoint` and `confirm`; `confirm` must exactly equal the checkpoint id. The tool creates an automatic safety checkpoint first and does not move Git HEAD.
- `keep_awake_start`; provide a stable `processHandle`, for example `keep-awake-training`.
- `keep_awake_stop`.

Do not use the bridge to import Browser, Chrome, Computer Use, Slack, or other host-bound Codex plugins. The manifest only imports local artifact, visualization, site-generation, and GitHub Skill roots that exist on the machine.
