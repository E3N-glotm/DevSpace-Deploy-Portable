# DevSpace Portable 1.1.68 dev20

* Mandatory model workflow applies to local and remote workspaces. A Worker or Agent task started from the same MCP workflow grants parallel reads. Write-capable delegation keeps the workspace writer lease and requires inspection of the current outcome before Host mutations.
* The legacy Worker can read, list, search and edit remote files through enrolled Linux Agents, using the existing workspace and remote write permissions.
* The desktop Agent workbench resolves the token from the configured local runtime state directory. Missing, mismatched and unavailable services show actionable messages and recover when the matching local service is ready.
