#!/usr/bin/env python3
"""Build the Android-native embedded ngrok Agent SDK bridge.

This intentionally does not use the upstream Linux CLI binary. ngrok's own
documentation recommends an Agent SDK when the native agent executable does
not run on a target platform. The bridge is a static GOOS=android/arm64 ELF and
reads the authtoken from stdin rather than argv/environment.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import shutil
import subprocess


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "native" / "ngrokbridge"
OUT = ROOT / "app" / "src" / "main" / "assets" / "ngrok-android-arm64"


def resolve_go() -> str:
    override = os.environ.get("DEVSPACE_GO")
    if override and Path(override).is_file():
        return override
    found = shutil.which("go")
    if found:
        return found
    candidates = [
        Path(r"E:\Cache\DevSpaceTools\go1.27.0\bin\go.exe"),
        Path(r"E:\Cache\DevSpaceTools\go1.27.0-extract\go\bin\go.exe"),
    ]
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    raise SystemExit("Go toolchain not found; set DEVSPACE_GO to go.exe")


def main() -> None:
    go = resolve_go()
    env = os.environ.copy()
    env.update({
        "GOOS": "android",
        "GOARCH": "arm64",
        "CGO_ENABLED": "0",
        "GOTOOLCHAIN": "local",
        "GOPROXY": env.get("GOPROXY", "https://goproxy.cn,direct"),
    })
    OUT.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([go, "mod", "download"], cwd=SOURCE, env=env, check=True)
    subprocess.run([
        go, "build", "-trimpath", "-ldflags=-s -w",
        "-o", str(OUT), ".",
    ], cwd=SOURCE, env=env, check=True)
    data = OUT.read_bytes()
    if not data.startswith(b"\x7fELF"):
        raise SystemExit("ngrok bridge output is not ELF")
    digest = hashlib.sha256(data).hexdigest()
    print(f"asset={OUT}")
    print(f"bytes={len(data)}")
    print(f"sha256={digest}")


if __name__ == "__main__":
    main()
