#!/usr/bin/env python3
"""Isolated Linux integration test for scoped CUDA + fork-safe Landlock.

Run via an ordinary, unconstrained SSH session with a COPY of the proposed
Agent source, not through the already-scoped production Agent. The child
processes each install the actual Agent's scoped Landlock preexec policy.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import pathlib
import shlex
import subprocess
import sys
import tempfile


CUDA_PROBE = """
import ctypes
import json
import os
import sys
c = ctypes.CDLL("libcuda.so.1")
c.cuInit.argtypes = [ctypes.c_uint]
c.cuInit.restype = ctypes.c_int
codes = {"cuInit": int(c.cuInit(0))}
n = ctypes.c_int()
if codes["cuInit"] == 0:
    c.cuDeviceGetCount.argtypes = [ctypes.POINTER(ctypes.c_int)]
    codes["cuDeviceGetCount"] = int(c.cuDeviceGetCount(ctypes.byref(n)))
    if codes["cuDeviceGetCount"] == 0:
        codes["gpuCount"] = n.value
if codes["cuInit"] == 0 and os.environ.get("DEVSPACE_CUDA_TEST_ALLOC") == "1":
    gpu_index = int(os.environ.get("DEVSPACE_CUDA_TEST_GPU_INDEX", "1"))
    device = ctypes.c_int()
    c.cuDeviceGet.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_int]
    codes["cuDeviceGet"] = int(c.cuDeviceGet(ctypes.byref(device), gpu_index))
    if codes["cuDeviceGet"] == 0:
        context = ctypes.c_void_p()
        c.cuCtxCreate_v2.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_uint, ctypes.c_int]
        codes["cuCtxCreate_v2"] = int(c.cuCtxCreate_v2(ctypes.byref(context), 0, device.value))
        if codes["cuCtxCreate_v2"] == 0:
            try:
                memory = ctypes.c_uint64()
                c.cuMemAlloc_v2.argtypes = [ctypes.POINTER(ctypes.c_uint64), ctypes.c_size_t]
                codes["cuMemAlloc_v2"] = int(c.cuMemAlloc_v2(ctypes.byref(memory), 4 * 1024 * 1024))
                if codes["cuMemAlloc_v2"] == 0:
                    c.cuMemFree_v2.argtypes = [ctypes.c_uint64]
                    codes["cuMemFree_v2"] = int(c.cuMemFree_v2(memory.value))
            finally:
                c.cuCtxDestroy_v2.argtypes = [ctypes.c_void_p]
                codes["cuCtxDestroy_v2"] = int(c.cuCtxDestroy_v2(context))
with open("/proc/self/status", encoding="utf-8") as handle:
    status = handle.read()
codes["NoNewPrivs"] = next(line.split(":", 1)[1].strip() for line in status.splitlines() if line.startswith("NoNewPrivs:"))
codes["pid"] = os.getpid()
print(json.dumps(codes, sort_keys=True), flush=True)
if codes["cuInit"] != 0 or codes.get("cuDeviceGetCount") != 0 or codes.get("gpuCount", 0) < 1:
    sys.exit(3)
if any(value != 0 for key, value in codes.items() if key.startswith("cu") and key not in ("gpuCount",)):
    sys.exit(4)
if codes["NoNewPrivs"] != "1":
    sys.exit(5)
"""


def load_agent(path: pathlib.Path):
    spec = importlib.util.spec_from_file_location("dev3_cudascope_agent", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def child_run(name: str, argv: list[str], env: dict, cwd: str, preexec) -> dict:
    result = subprocess.run(
        argv,
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=50,
        preexec_fn=preexec,
    )
    output = result.stdout.strip()
    print(f"CUDA_LANDLOCK_{name} exit={result.returncode} output={output[-950:]}", flush=True)
    if result.returncode:
        raise AssertionError(f"{name} failed with exit {result.returncode}: {output[-1200:]}")
    lines = output.splitlines()
    return json.loads(lines[-1]) if lines and lines[-1].startswith("{") else {"raw": output}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent", type=pathlib.Path, required=True)
    parser.add_argument("--workspace-root", type=pathlib.Path, required=True)
    parser.add_argument("--gpu-index", type=int, default=1)
    parser.add_argument("--require-nvidia", action="store_true")
    args = parser.parse_args()
    workspace = str(args.workspace_root.resolve(strict=True))
    agent = load_agent(args.agent.resolve(strict=True))
    assert agent.AGENT_VERSION == "1.1.50", agent.AGENT_VERSION
    abi = agent.landlock_abi()
    assert abi >= 1, "Landlock ABI 1+ required"
    devices = agent.landlock_runtime_device_paths()
    procfs = agent.landlock_cuda_procfs_write_compat(devices)
    assert agent.landlock_cuda_procfs_write_compat([]) is None
    assert agent.landlock_cuda_procfs_write_compat(["/dev/kfd", "/dev/dri/renderD128"]) is None
    if procfs is None:
        if args.require_nvidia:
            raise AssertionError("NVIDIA procfs exception unavailable on required CUDA host")
        print(json.dumps({"skipped": "NVIDIA character devices unavailable"}))
        return 0
    assert procfs == "/proc"
    assert os.path.ismount(procfs)
    assert agent.landlock_runtime_device_directories() == ["/dev/pts"]
    print(json.dumps({"version": agent.AGENT_VERSION, "landlockAbi": abi, "procfs": procfs, "permission": "WRITE_FILE"}), flush=True)

    preexec = lambda: agent.apply_write_landlock([workspace], abi)
    env = os.environ.copy()
    env["DEVSPACE_CUDA_TEST_GPU_INDEX"] = str(args.gpu_index)
    env.pop("DEVSPACE_CUDA_TEST_ALLOC", None)
    direct = [sys.executable, "-c", CUDA_PROBE]
    shell_cmd = f"{shlex.quote(sys.executable)} -c {shlex.quote(CUDA_PROBE)}"
    modes = {
        "DIRECT": direct,
        "BASH_CHILD": ["bash", "-lc", shell_cmd],
        "NESTED_BASH": ["bash", "-lc", "bash -lc " + shlex.quote(shell_cmd)],
        "BASH_BACKGROUND": ["bash", "-lc", "(" + shell_cmd + ") & wait $!"],
        "PY_SUBPROCESS": [sys.executable, "-c",
                          "import subprocess,sys;subprocess.run([sys.executable,'-c',"
                          + repr(CUDA_PROBE) + "],check=True)"],
        "PY_CONCURRENT_CHILDREN": [sys.executable, "-c",
                                   "import subprocess,sys;"
                                   "workers=[subprocess.Popen([sys.executable,'-c',"
                                   + repr(CUDA_PROBE)
                                   + "]) for _ in range(2)];"
                                   "assert all(p.wait(timeout=35)==0 for p in workers)"],
        "MULTIPROCESSING_FORK": [sys.executable, "-c",
                                 "import multiprocessing as mp;"
                                 "p=mp.get_context('fork').Process(target=lambda:exec("
                                 + repr(CUDA_PROBE) + "));"
                                 "p.start();p.join(35);assert p.exitcode==0"],
        "SH_CHILD": ["sh", "-c", shell_cmd],
    }
    results = {}
    for name, argv in modes.items():
        results[name] = child_run(name, argv, env, workspace, preexec)
        assert results[name]["cuInit"] == 0, name
    allocating = dict(env, DEVSPACE_CUDA_TEST_ALLOC="1")
    results["CONTEXT_ALLOC_4MIB"] = child_run(
        "CONTEXT_ALLOC_4MIB", ["bash", "-lc", shell_cmd], allocating, workspace, preexec
    )
    for key in ("cuCtxCreate_v2", "cuMemAlloc_v2", "cuMemFree_v2", "cuCtxDestroy_v2"):
        assert results["CONTEXT_ALLOC_4MIB"][key] == 0, key

    # Scoped writes inside explicitly writable project roots must still work.
    # The test creates and removes only its own uniquely named file.
    allowed_fd, allowed_file = tempfile.mkstemp(prefix=".devspace-dev3-allowed-", dir=workspace)
    os.close(allowed_fd)
    try:
        inside_code = ("import os,sys; fd=os.open(sys.argv[1],os.O_WRONLY);"
                       "os.write(fd,b'allowed');os.close(fd);print('INSIDE_WRITE_ALLOWED')")
        inside = child_run("INSIDE_WRITE_ALLOWANCE",
                           [sys.executable, "-c", inside_code, allowed_file],
                           env, workspace, preexec)
        assert "INSIDE_WRITE_ALLOWED" in inside.get("raw", "")
        assert pathlib.Path(allowed_file).read_bytes() == b"allowed"
    finally:
        os.unlink(allowed_file)

    # This file is intentionally outside configured writableRoots but owned
    # by the current user: DAC alone would allow writes, so EACCES proves
    # that scoped Landlock is still protecting durable external paths.
    home = pathlib.Path.home().resolve()
    if home == pathlib.Path(workspace) or pathlib.Path(workspace) in home.parents:
        raise AssertionError("HOME must be outside workspace for negative security test")
    fd, outside = tempfile.mkstemp(prefix=".devspace-dev3-landlock-deny-", dir=home)
    os.close(fd)
    try:
        security_code = """
import errno, os, sys
try:
    fd = os.open(sys.argv[1], os.O_WRONLY)
except OSError as e:
    print("OUTSIDE_WRITE_DENIED", e.errno)
    sys.exit(0 if e.errno in (errno.EACCES, errno.EPERM) else 9)
else:
    os.close(fd)
    print("SECURITY_FAILURE_OUTSIDE_WRITE_ALLOWED")
    sys.exit(10)
"""
        checked = child_run(
            "OUTSIDE_WRITE_DENIAL", [sys.executable, "-c", security_code, outside],
            env, workspace, preexec
        )
        assert "OUTSIDE_WRITE_DENIED" in checked.get("raw", "")
        assert pathlib.Path(outside).stat().st_size == 0
    finally:
        os.unlink(outside)

    print(json.dumps({
        "status": "PASS", "cudaModes": list(results), "landlockAbi": abi,
        "scopedWritesOutsideRootDenied": True, "scopedWritesInsideRootAllowed": True,
        "NoNewPrivsPreserved": True,
        "productionAgentRestarted": False,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
