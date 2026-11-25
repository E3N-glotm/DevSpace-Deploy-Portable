# DevSpace Portable 1.1.70 dev3

## Linux Agent scoped CUDA descendant-process compatibility

Linux Agent **1.1.50** fixes CUDA error 304 when the NVIDIA driver writes thread names to `/proc/<pid>/task/<tid>/comm` from a descendant of the originally sandboxed command. The dev2 `/proc/self/task` rule resolved to a fixed PID before exec and did not cover later children.

On Linux hosts with verified NVIDIA control and GPU character devices, the Agent now grants **only the Landlock `WRITE_FILE` access bit** under the procfs mount `/proc`. It does **not** grant `MAKE_*`, `REMOVE_*`, `REFER`, `TRUNCATE`, or general writableRoots permissions to procfs. On non-NVIDIA hosts the exception is absent. Existing `scoped`, `NoNewPrivs`, per-device allowances and persistent writable-root limits remain active.

**Security tradeoff:** With Landlock ABI 1 (H200 kernel 5.15), there is no path-pattern rule matching arbitrary future descendant PIDs. The `/proc` `WRITE_FILE` exception is broader than the ideal thread-name file and may permit other procfs writes when normal Linux DAC and LSM checks allow them. It is therefore explicitly disclosed via `system.status.sandbox` with access mode, exception status, path and access bit. It must not be described as a zero-permission-expansion fix.

## Tests and deployment boundary

- `setup/test-linux-agent-contract.mjs` verifies GPU-only gating, stable procfs mount checks, controller/Agent version agreement and exact `WRITE_FILE` grant.
- `setup/test-linux-agent-cuda-landlock.py` uses the real Linux Agent implementation in isolated subprocesses under actual Landlock. It tests direct CUDA, Bash child, nested Bash, Python subprocess, `/bin/sh` child, CUDA context creation and 4 MiB GPU allocation/free, `NoNewPrivs=1`, and denial of writing a same-user file outside the configured writable roots.
- Run GPU integration through ordinary SSH with an isolated **copy** of the candidate Agent; a shell started by the already restricted production Agent cannot undo its inherited Landlock permissions.
- Building dev3 does not install or restart the production H200 Agent, Windows MCP, Open WebUI or the model processes. Live deployment requires separate authorization and a fresh post-upgrade CUDA check.

See the Linux Landlock kernel documentation and NVIDIA/OpenShell issue #1628 for the motivation and procfs-permission tradeoff.

## Portable package root-file isolation

Release builds now explicitly allowlist intentional top-level payloads rather
than implicitly shipping every non-excluded local source-root file. This stops
untracked diagnostic outputs from other tasks (such as pc_net.txt) from
entering an otherwise valid ZIP. The build does not delete or alter such files.
setup/test-release-root-allowlist.py checks both the approved files and a
fresh temporary operator-local text file. All packaged files still receive
individual SHA-256 records and CRC verification.
