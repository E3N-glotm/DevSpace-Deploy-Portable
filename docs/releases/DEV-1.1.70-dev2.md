# DevSpace Portable 1.1.70 dev2

## Linux Remote Agent scoped CUDA initialization

- Linux Agent `1.1.49`: scoped Landlock mode grants **only `WRITE_FILE`** on the current process's `/proc/self/task` subtree, in addition to the existing `/dev/pts` rule. NVIDIA CUDA driver initialization may need task-specific procfs access; the previous sandbox could return CUDA error 304 even while normal SSH CUDA operations succeeded.
- This does **not** disable Landlock, `NoNewPrivileges`, or `writableRoots`; it does not grant generic `/proc` access or create/delete rights. The exception remains subject to normal Linux access checks.
- Version synchronization updates both the Linux Agent script and Windows controller `DEVSPACE_LINUX_AGENT_VERSION` to `1.1.49`, so a later deployment can supply the updated Agent through the existing signed/hash-checked self-update path.
- The Linux Agent contract now checks the actual scoped dynamic-path enumeration and rejects broad `/proc` or `/dev` directory exceptions.

## Validation boundary

The original CUDA `cuInit`, `cuCtxCreate_v2`, `cuMemAlloc_v2`, `cuMemFree_v2`, and `cuCtxDestroy_v2` success results were reported from an isolated H200 test before this code change. Local Windows build/test checks verify the patched source and packaging; a production H200 CUDA test must be repeated **after** the updated Linux Agent has been deliberately deployed and restarted. Building dev2 by itself does not change any running H200 Agent or model process.
