"""Ensure unrelated operator files in the source root never enter Portable ZIPs."""

from __future__ import annotations

import importlib.util
import pathlib
import uuid


ROOT = pathlib.Path(__file__).resolve().parents[1]
BUILDER = ROOT / "setup" / "build-release.py"
spec = importlib.util.spec_from_file_location("devspace_release_root_guard", BUILDER)
assert spec is not None and spec.loader is not None
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)

expected_roots = {
    "BUILD-ACCEPTANCE.md",
    "DevSpace-Portable-Next.exe",
    "DevSpace-Portable.cmd",
    "DevSpace-Portable.exe",
    "DevSpace-SshAskPass.exe",
    "LICENSE",
    "MIGRATION-CHECKLIST.md",
    "NOTICE",
    "README-PORTABLE.md",
    "README.md",
    "SECURITY.md",
    "THIRD-PARTY-NOTICES.md",
    "Update.exe",
    "VERSION-MANIFEST.json",
}
assert builder.APPROVED_TOP_LEVEL_RELEASE_FILES == expected_roots

sentinel = ROOT / f"devspace-root-release-guard-{uuid.uuid4().hex}.txt"
assert not sentinel.exists()
try:
    sentinel.write_text("Unrelated local operator content: must not be distributed.\n", encoding="utf-8")
    paths = builder.release_files()
    root_names = {path.name for path in paths if path.parent == pathlib.Path(".")}
    assert root_names == expected_roots, (sorted(root_names), sorted(expected_roots - root_names))
    assert pathlib.Path(sentinel.name) not in paths
    assert pathlib.Path("pc_net.txt") not in paths
    assert pathlib.Path("SHA256SUMS.txt") not in paths
    assert all(path.parent != pathlib.Path(".") or path.name in expected_roots for path in paths)
finally:
    sentinel.unlink(missing_ok=True)

print({"rootLevelAllowlist": True, "operatorLocalFileExcluded": True, "approvedRootFiles": len(expected_roots)})
