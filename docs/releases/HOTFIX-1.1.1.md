# DevSpace Portable 1.1.1

## Stable hot-plug plugin dispatch

ChatGPT custom MCP Apps use an approved, frozen snapshot of top-level tool names and input schemas. MCP supports `notifications/tools/list_changed`, but ChatGPT does not automatically enable newly added actions from that notification. DevSpace 1.1.1 therefore stops requiring one new top-level MCP action per plugin tool.

Two stable MCP dispatchers are registered once:

- `plugin_query`: runs only manifest tools with `readOnly=true`.
- `plugin_action`: runs only manifest tools that may modify state.

Both accept `pluginId` and manifest `toolName`, resolve the currently enabled selected plugin version at invocation time, and execute it through the existing workspace, permission-rule, process-registry, audit, and redaction layers. Adding, updating, enabling, disabling, or selecting a plugin version does not change either dispatcher schema.

`plugin_list` now returns `dispatchTools`, including each manifest tool's internal name, title, description, read-only classification, and maturity.

`plugin_refresh`, `plugin_enable`, and `plugin_disable` take effect immediately for the stable dispatchers. They return `reconnectRequired=false`. `dynamicToolRefreshRequired=true` only means that an administrator must refresh ChatGPT if the optional individual `plugin_<id>_<tool>` top-level aliases are desired.

## Existing-session compatibility

Conversations whose frozen App snapshot predates `plugin_query` and `plugin_action` can use the already-approved `exec_command` tool with the fixed local dispatcher:

```cmd
app\DevSpace-Plugin.cmd list
app\DevSpace-Plugin.cmd refresh
app\DevSpace-Plugin.cmd query <pluginId> <toolName> --workspace <path>
app\DevSpace-Plugin.cmd action <pluginId> <toolName> --workspace <path>
```

The CLI does not accept an executable, SSH host, password, remote command, or manifest command from the caller. It resolves those only from the selected, enabled plugin manifest. Query/action separation is enforced in the same way as the MCP dispatchers.

## Compatibility

- Existing per-plugin top-level tools remain available for backward compatibility.
- Existing `exec_command`, `plugin_list`, `plugin_refresh`, `plugin_enable`, and `plugin_disable` schemas remain compatible.
- No user OAuth, Owner Password, tunnel, plugin, workspace-session, process-registry, or permission configuration is reset.
