from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UPDATER = ROOT / "setup" / "portable-updater.ps1"
NODE = ROOT / "runtime" / "node" / "node.exe"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def version_manifest(version: str) -> bytes:
    return (json.dumps({"runtime": {"devspacePortable": version}}, indent=2) + "\n").encode("utf-8")


def changed_entry(path: str, content: bytes, base: bytes | None) -> dict[str, object]:
    return {
        "path": path,
        "size": len(content),
        "sha256": digest(content),
        "baseSha256": digest(base) if base is not None else None,
    }


def write_step(
    stage: Path,
    index: int,
    from_version: str,
    to_version: str,
    changed: dict[str, tuple[bytes, bytes | None]],
    deleted: dict[str, bytes],
) -> dict[str, object]:
    step = stage / "steps" / f"{index:03d}-{from_version}-to-{to_version}"
    files = step / "payload" / "DevSpacePortableDelta" / "files"
    files.mkdir(parents=True)
    changed_files = []
    for relative, (content, base) in changed.items():
        target = files / Path(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        changed_files.append(changed_entry(relative, content, base))
    deleted_files = [{"path": relative, "baseSha256": digest(content)} for relative, content in deleted.items()]
    delta = {
        "schemaVersion": 1,
        "format": "file-delta-v1",
        "fromVersion": from_version,
        "toVersion": to_version,
        "changedFiles": changed_files,
        "deletedFiles": deleted_files,
    }
    manifest_path = step / "payload" / "DevSpacePortableDelta" / "delta-manifest.json"
    manifest_path.write_text(json.dumps(delta, indent=2) + "\n", encoding="utf-8")
    return {
        "fromVersion": from_version,
        "toVersion": to_version,
        "payloadRoot": str(files),
        "deltaManifestPath": str(manifest_path),
    }


def prepare_root(base: Path, bad_delete_hash: bool = False) -> tuple[Path, Path]:
    root = base / "portable"
    (root / "runtime" / "node").mkdir(parents=True)
    (root / "setup").mkdir(parents=True)
    shutil.copy2(NODE, root / "runtime" / "node" / "node.exe")
    (root / "setup" / "portable-manager.cjs").write_text("process.exit(0);\n", encoding="utf-8")

    manifest_140 = version_manifest("1.1.40")
    manifest_141 = version_manifest("1.1.41")
    manifest_142 = version_manifest("1.1.42")
    a_140 = b"original-140\n"
    a_141 = b"intermediate-141\n"
    a_142 = b"final-142\n"
    delete_original = b"delete-me-at-142\n"
    (root / "VERSION-MANIFEST.json").write_bytes(manifest_140)
    (root / "setup" / "a.txt").write_bytes(a_140)
    (root / "setup" / "delete.txt").write_bytes(delete_original)

    stage = root / ".update-staging" / "1.1.42-chain-test"
    stage.mkdir(parents=True)
    step1 = write_step(
        stage,
        1,
        "1.1.40",
        "1.1.41",
        {
            "VERSION-MANIFEST.json": (manifest_141, manifest_140),
            "setup/a.txt": (a_141, a_140),
        },
        {},
    )
    delete_base = b"incorrect-base\n" if bad_delete_hash else delete_original
    step2 = write_step(
        stage,
        2,
        "1.1.41",
        "1.1.42",
        {
            "VERSION-MANIFEST.json": (manifest_142, manifest_141),
            "setup/a.txt": (a_142, a_141),
        },
        {"setup/delete.txt": delete_base},
    )
    stage_info = {
        "formatVersion": 2,
        "currentVersion": "1.1.40",
        "targetVersion": "1.1.42",
        "repository": "E3N-glotm/DevSpace-Deploy-Portable",
        "updateMode": "incremental-chain",
        "steps": [step1, step2],
    }
    (stage / "stage-info.json").write_text(json.dumps(stage_info, indent=2) + "\n", encoding="utf-8")
    return root, stage


def run_apply(root: Path, stage: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(UPDATER),
            "-Action",
            "Apply",
            "-Root",
            str(root),
            "-CurrentVersion",
            "1.1.40",
            "-StagingPath",
            str(stage),
        ],
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        timeout=90,
    )


def main() -> int:
    if not NODE.is_file():
        raise SystemExit(f"Bundled Node runtime is missing: {NODE}")

    with tempfile.TemporaryDirectory(prefix="devspace-chain-success-") as temp:
        root, stage = prepare_root(Path(temp))
        result = run_apply(root, stage)
        if result.returncode != 0:
            raise AssertionError(f"incremental-chain apply failed:\n{result.stdout}\n{result.stderr}")
        assert json.loads((root / "VERSION-MANIFEST.json").read_text(encoding="utf-8"))["runtime"]["devspacePortable"] == "1.1.42"
        assert (root / "setup" / "a.txt").read_bytes() == b"final-142\n"
        assert not (root / "setup" / "delete.txt").exists()
        applied = json.loads((root / "data" / "state" / "update-result.json").read_text(encoding="utf-8-sig"))
        assert applied["success"] is True
        assert applied["updateMode"] == "incremental-chain"

    with tempfile.TemporaryDirectory(prefix="devspace-chain-rollback-") as temp:
        root, stage = prepare_root(Path(temp), bad_delete_hash=True)
        result = run_apply(root, stage)
        if result.returncode == 0:
            raise AssertionError("corrupt incremental-chain deletion unexpectedly succeeded")
        assert json.loads((root / "VERSION-MANIFEST.json").read_text(encoding="utf-8"))["runtime"]["devspacePortable"] == "1.1.40"
        assert (root / "setup" / "a.txt").read_bytes() == b"original-140\n"
        assert (root / "setup" / "delete.txt").read_bytes() == b"delete-me-at-142\n"
        rolled_back = json.loads((root / "data" / "state" / "update-result.json").read_text(encoding="utf-8-sig"))
        assert rolled_back["success"] is False
        assert rolled_back["rolledBack"] is True
        assert rolled_back["updateMode"] == "incremental-chain"

    print(json.dumps({"incrementalChainApply": True, "multiStepSameFile": True, "deletionValidation": True, "transactionRollback": True}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
