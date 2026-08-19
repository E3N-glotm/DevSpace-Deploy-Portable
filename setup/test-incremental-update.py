from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "setup" / "create-incremental-update.py"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def make_release(path: Path, files: dict[str, bytes]) -> None:
    checksums = "".join(
        f"{digest(data)}  {relative}\n"
        for relative, data in sorted(files.items())
        if relative != "SHA256SUMS.txt"
    ).encode("utf-8")
    payload = dict(files)
    payload["SHA256SUMS.txt"] = checksums
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        archive.writestr("DevSpacePortable/", b"")
        for relative, data in sorted(payload.items()):
            archive.writestr(f"DevSpacePortable/{relative}", data)


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="devspace-delta-test-") as temp_raw:
        temp = Path(temp_raw)
        base = temp / "DevSpacePortable-Windows-x64-1.1.15.zip"
        target = temp / "DevSpacePortable-Windows-x64-1.1.16.zip"
        delta = temp / "DevSpacePortable-Update-1.1.15-to-1.1.16.zip"
        make_release(
            base,
            {
                "VERSION-MANIFEST.json": b'{"runtime":{"devspacePortable":"1.1.15"}}\n',
                "setup/a.txt": b"old\n",
                "runtime/keep.bin": b"same-runtime",
                "setup/bundled-plugins/codex-runtime-bridge/1.1.1/manifest.json": b'{"id":"codex-runtime-bridge","version":"1.1.1"}\n',
                "setup/bundled-plugins/codex-runtime-bridge/1.1.1/runtime.mjs": b"export const runtime = true;\n",
                "setup/bundled-plugins/codex-runtime-bridge/1.1.1/keep-awake.ps1": b"Write-Output keep-awake\n",
                "setup/bundled-plugins/codex-runtime-bridge/1.1.1/skills/codex-runtime-bridge/SKILL.md": b"# Codex Runtime Bridge\n",
                "packages/waishnav-devspace-1.0.5.tgz": b"historical-core-repack-a",
                "obsolete.txt": b"delete-me",
                "data/user-state.txt": b"persistent-old",
            },
        )
        make_release(
            target,
            {
                "VERSION-MANIFEST.json": b'{"runtime":{"devspacePortable":"1.1.16"}}\n',
                "setup/a.txt": b"new\n",
                "setup/new.txt": b"brand-new\n",
                "runtime/keep.bin": b"same-runtime",
                "setup/bundled-plugins/codex-runtime-bridge/1.1.1/manifest.json": b'{"id":"codex-runtime-bridge","version":"1.1.1"}\n',
                "setup/bundled-plugins/codex-runtime-bridge/1.1.1/runtime.mjs": b"export const runtime = true;\n",
                "setup/bundled-plugins/codex-runtime-bridge/1.1.1/keep-awake.ps1": b"Write-Output keep-awake\n",
                "setup/bundled-plugins/codex-runtime-bridge/1.1.1/skills/codex-runtime-bridge/SKILL.md": b"# Codex Runtime Bridge\n",
                "packages/waishnav-devspace-1.0.7.tgz": b"current-core",
                "data/user-state.txt": b"persistent-new-should-not-be-delta",
            },
        )
        subprocess.run(
            [
                sys.executable,
                str(BUILDER),
                "--base-zip",
                str(base),
                "--target-zip",
                str(target),
                "--output",
                str(delta),
            ],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        with zipfile.ZipFile(delta, "r") as archive:
            manifest = json.loads(archive.read("DevSpacePortableDelta/delta-manifest.json"))
            names = set(archive.namelist())

        changed = {entry["path"]: entry for entry in manifest["changedFiles"]}
        deleted = {entry["path"]: entry for entry in manifest["deletedFiles"]}
        retained_obsolete = set(manifest["retainedObsoleteFiles"])
        assert manifest["format"] == "file-delta-v1"
        assert manifest["fromVersion"] == "1.1.15"
        assert manifest["toVersion"] == "1.1.16"
        assert "setup/a.txt" in changed
        assert "setup/new.txt" in changed
        assert "VERSION-MANIFEST.json" in changed
        assert "SHA256SUMS.txt" in changed
        assert "runtime/keep.bin" not in changed
        assert "data/user-state.txt" not in changed
        bundled_prefix = "setup/bundled-plugins/codex-runtime-bridge/1.1.1/"
        for relative in [
            "manifest.json",
            "runtime.mjs",
            "keep-awake.ps1",
            "skills/codex-runtime-bridge/SKILL.md",
        ]:
            path = bundled_prefix + relative
            assert path in changed, f"mandatory bundled plugin file missing from delta manifest: {path}"
            assert "DevSpacePortableDelta/files/" + path in names
        assert manifest["alwaysIncludedPrefixes"] == ["setup/bundled-plugins/codex-runtime-bridge/"]
        assert "obsolete.txt" in deleted
        assert "packages/waishnav-devspace-1.0.5.tgz" not in deleted
        assert "packages/waishnav-devspace-1.0.5.tgz" in retained_obsolete
        assert "packages/waishnav-devspace-1.0.7.tgz" in changed
        assert "DevSpacePortableDelta/files/setup/a.txt" in names
        assert "DevSpacePortableDelta/files/setup/new.txt" in names
        assert "DevSpacePortableDelta/files/runtime/keep.bin" not in names
        assert not any("data/user-state.txt" in name for name in names)
        assert changed["setup/a.txt"]["baseSha256"] == digest(b"old\n")
        assert changed["setup/a.txt"]["sha256"] == digest(b"new\n")
        print(
            json.dumps(
                {
                    "fileDeltaV1": True,
                    "changedFilesPlusMandatoryBundledPlugins": True,
                    "deleteManifest": True,
                    "persistentRootsExcluded": True,
                    "baseHashPreflight": True,
                    "codexRuntimeBridgeAlwaysIncluded": True,
                    "obsoleteCoreArchiveRetained": True,
                }
            )
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
