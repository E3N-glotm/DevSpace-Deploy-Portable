from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "setup" / "create-rescue-overlay.py"
MANDATORY = (
    "DevSpace-Portable.exe",
    "Update.exe",
    "VERSION-MANIFEST.json",
    "SHA256SUMS.txt",
    "setup/portable-manager.cjs",
    "setup/portable-updater.ps1",
)


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def write_release(
    path: Path,
    version: str,
    marker: str,
    *,
    omit: set[str] | None = None,
    extra_files: dict[str, bytes] | None = None,
) -> None:
    omit = omit or set()
    files: dict[str, bytes] = {
        "DevSpace-Portable.exe": f"ui-{marker}".encode(),
        "Update.exe": f"updater-{marker}".encode(),
        "VERSION-MANIFEST.json": json.dumps({"runtime": {"devspacePortable": version}}).encode(),
        "setup/portable-manager.cjs": f"manager-{marker}".encode(),
        "setup/portable-updater.ps1": f"updater-script-{marker}".encode(),
        "setup/unchanged.txt": b"same",
        "data/config/config.json": f"persistent-{marker}".encode(),
        "logs/update.log": f"log-{marker}".encode(),
    }
    for relative in omit:
        files.pop(relative, None)
    files.update(extra_files or {})
    checksums = "".join(
        f"{digest(content)}  {relative}\n"
        for relative, content in sorted(files.items())
        if not relative.startswith(("data/", "logs/", "reports/"))
    ).encode()
    files["SHA256SUMS.txt"] = checksums
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("DevSpacePortable/", b"")
        for relative, content in files.items():
            archive.writestr("DevSpacePortable/" + relative, content)


with tempfile.TemporaryDirectory(prefix="devspace-rescue-test-") as raw:
    temporary = Path(raw)
    base = temporary / "DevSpacePortable-Windows-x64-1.1.33.zip"
    target = temporary / "DevSpacePortable-Windows-x64-1.1.36.zip"
    output = temporary / "DevSpacePortable-Rescue-1.1.33-to-1.1.36.zip"
    write_release(base, "1.1.33", "base")
    write_release(target, "1.1.36", "target")

    result = subprocess.run(
        ["python", str(BUILDER), "--base-zip", str(base), "--target-zip", str(target), "--output", str(output)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    with zipfile.ZipFile(output, "r") as archive:
        names = set(archive.namelist())
        assert "RESCUE-MANIFEST.json" in names
        assert "README-RESCUE-1.1.33-to-1.1.36.txt" in names
        for relative in MANDATORY:
            assert relative in names, relative
        assert "setup/unchanged.txt" not in names
        assert not any(name.startswith("DevSpacePortable/") for name in names)
        assert not any(name.startswith(("data/", "logs/", "reports/")) for name in names)
        manifest = json.loads(archive.read("RESCUE-MANIFEST.json"))
        assert manifest["format"] == "direct-overlay-v1"
        assert manifest["fromVersion"] == "1.1.33"
        assert manifest["toVersion"] == "1.1.36"
        assert manifest["deletedFiles"] == []
        assert manifest["ignoredObsoleteFiles"] == []
        assert manifest["persistentRootsExcluded"] == ["data", "logs", "reports"]

    core_base_dir = temporary / "core-base"
    core_target_dir = temporary / "core-target"
    core_base_dir.mkdir()
    core_target_dir.mkdir()
    core_base = core_base_dir / "DevSpacePortable-Windows-x64-1.1.33.zip"
    core_target = core_target_dir / "DevSpacePortable-Windows-x64-1.1.36.zip"
    core_output = temporary / "core-upgrade-rescue.zip"
    write_release(
        core_base,
        "1.1.33",
        "base",
        extra_files={"packages/waishnav-devspace-1.0.5.tgz": b"old-core"},
    )
    write_release(
        core_target,
        "1.1.36",
        "target",
        extra_files={"packages/waishnav-devspace-1.0.7.tgz": b"new-core"},
    )
    core_result = subprocess.run(
        ["python", str(BUILDER), "--base-zip", str(core_base), "--target-zip", str(core_target), "--output", str(core_output)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert core_result.returncode == 0, core_result.stderr or core_result.stdout
    with zipfile.ZipFile(core_output, "r") as archive:
        manifest = json.loads(archive.read("RESCUE-MANIFEST.json"))
        assert manifest["ignoredObsoleteFiles"] == ["packages/waishnav-devspace-1.0.5.tgz"]
        assert "packages/waishnav-devspace-1.0.7.tgz" in archive.namelist()

    nested_base_dir = temporary / "nested-base"
    nested_target_dir = temporary / "nested-target"
    nested_base_dir.mkdir()
    nested_target_dir.mkdir()
    nested_base = nested_base_dir / "DevSpacePortable-Windows-x64-1.1.33.zip"
    nested_target = nested_target_dir / "DevSpacePortable-Windows-x64-1.1.36.zip"
    nested_output = temporary / "nested-hoist-rescue.zip"
    nested_file = "app/node_modules/parent/node_modules/ws/index.js"
    hoisted_file = "app/node_modules/ws/index.js"
    write_release(
        nested_base,
        "1.1.33",
        "base",
        extra_files={nested_file: b"byte-identical-ws"},
    )
    write_release(
        nested_target,
        "1.1.36",
        "target",
        extra_files={hoisted_file: b"byte-identical-ws"},
    )
    nested_result = subprocess.run(
        ["python", str(BUILDER), "--base-zip", str(nested_base), "--target-zip", str(nested_target), "--output", str(nested_output)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert nested_result.returncode == 0, nested_result.stderr or nested_result.stdout
    with zipfile.ZipFile(nested_output, "r") as archive:
        manifest = json.loads(archive.read("RESCUE-MANIFEST.json"))
        assert nested_file in manifest["ignoredObsoleteFiles"]
        assert hoisted_file in archive.namelist()

    mismatched_target_dir = temporary / "nested-mismatch"
    mismatched_target_dir.mkdir()
    mismatched_target = mismatched_target_dir / "DevSpacePortable-Windows-x64-1.1.36.zip"
    write_release(
        mismatched_target,
        "1.1.36",
        "target",
        extra_files={hoisted_file: b"different-ws-bytes"},
    )
    mismatched = subprocess.run(
        [
            "python",
            str(BUILDER),
            "--base-zip",
            str(nested_base),
            "--target-zip",
            str(mismatched_target),
            "--output",
            str(temporary / "nested-mismatch-must-not-exist.zip"),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert mismatched.returncode != 0
    assert nested_file in (mismatched.stderr + mismatched.stdout)

    deletion_target = temporary / "DevSpacePortable-Windows-x64-1.1.36-deletion-fixture.zip"
    # The builder infers the version from the filename, so use a valid release
    # name in a child directory for the deletion-negative case.
    deletion_dir = temporary / "deletion"
    deletion_dir.mkdir()
    deletion_target = deletion_dir / "DevSpacePortable-Windows-x64-1.1.36.zip"
    write_release(deletion_target, "1.1.36", "target", omit={"setup/unchanged.txt"})
    failed = subprocess.run(
        [
            "python",
            str(BUILDER),
            "--base-zip",
            str(base),
            "--target-zip",
            str(deletion_target),
            "--output",
            str(temporary / "must-not-exist.zip"),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert failed.returncode != 0
    assert "not safe" in (failed.stderr + failed.stdout)

print(
    json.dumps(
        {
            "directExtractOverlay": True,
            "persistentRootsExcluded": True,
            "mandatoryUpdaterFilesReplaced": True,
            "obsoleteCoreArchiveMayRemainInert": True,
            "byteIdenticalNestedDependencyMayRemainInert": True,
            "mismatchedNestedDependencyRejected": True,
            "deletedBaseFilesRejected": True,
        }
    )
)
