from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import tarfile
import zipfile
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECKSUM_FILE = ROOT / "SHA256SUMS.txt"
BUNDLED_PLUGIN_SOURCE = ROOT / "setup" / "bundled-plugins"
RELEASE_PLUGIN_PREFIX = Path("data/plugins/installed")
REQUIRED_BUNDLED_PLUGIN_FILES = {
    "codex-runtime-bridge": {
        "manifest.json",
        "runtime.mjs",
        "keep-awake.ps1",
        "skills/codex-runtime-bridge/SKILL.md",
    },
}
EMPTY_RELEASE_DIRS = ("data/", "data/run/", "logs/", "reports/")
EXCLUDED_TOP_LEVEL_DIRS = {
    ".test-cache",
    ".tmp-delta-audit",
    ".update-staging",
    # The source checkout may also host the independently developed Android
    # client workspace.  It is not part of the Windows Portable payload and
    # may be untracked/operator-local, so never let it leak into a ZIP build.
    "android",
    "data",
    "logs",
    "reports",
    ".git",
    ".github",
    ".idea",
    ".vs",
    ".vscode",
    "vendor",
    "release-assets",
    "release-output",
    # Local live-deployment snapshots may intentionally preserve auth.json,
    # OAuth/SQLite state, and other operator data for rollback.  They are
    # never distributable source material.
    "workspace-archives",
}
EXCLUDED_TOP_LEVEL_FILES = {
    ".gitattributes",
    ".gitignore",
    "CHANGELOG.md",
    "CODE_OF_CONDUCT.md",
    "CONTRIBUTING.md",
    "package.json",
    # A legacy updater UI self-test accidentally redirected its JSON result to
    # this extensionless file in the 1.1.27 local build. Keep source-local
    # diagnostics out of distributable payloads.
    "true",
}
RELEASE_DIRECTORY_PREFIX = "DevSpacePortable-Windows-x64-"
TEMP_NATIVE_UI_PATTERN = re.compile(r"^[0-9a-fA-F-]{36}_DevSpace-Portable\.exe$")
FORBIDDEN_RELEASE_BASENAMES = {
    "auth.json",
}
FORBIDDEN_RELEASE_STATE_SUFFIXES = {
    ".sqlite",
    ".sqlite3",
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def sha512_integrity(path: Path) -> str:
    digest = hashlib.sha512()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return "sha512-" + base64.b64encode(digest.digest()).decode("ascii")


def validate_source_checkout(node: Path) -> None:
    verifier = ROOT / "scripts" / "verify-source-tree.mjs"
    if not verifier.is_file():
        raise RuntimeError(f"Source-tree verifier is missing: {verifier}")
    subprocess.run([str(node), str(verifier)], cwd=ROOT, check=True)


def validate_installed_core() -> None:
    package_json = ROOT / "vendor" / "waishnav-devspace" / "package.json"
    if not package_json.is_file():
        raise RuntimeError(f"Maintained core package metadata is missing: {package_json}")
    core_version = str(json.loads(package_json.read_text(encoding="utf-8"))["version"])
    archive = ROOT / "packages" / f"waishnav-devspace-{core_version}.tgz"
    lock_path = ROOT / "app" / "package-lock.json"
    installed_root = ROOT / "app" / "node_modules" / "@waishnav" / "devspace"
    if not archive.is_file():
        raise RuntimeError(
            f"Packed core archive is missing: {archive}. Run npm run core:pack before building a release."
        )
    if not lock_path.is_file():
        raise RuntimeError(f"Portable app lockfile is missing: {lock_path}")
    if not installed_root.is_dir():
        raise RuntimeError(
            f"Installed Portable core is missing: {installed_root}. Run npm ci --prefix app before building a release."
        )

    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    dependency = lock.get("packages", {}).get("node_modules/@waishnav/devspace")
    if not dependency:
        raise RuntimeError("app/package-lock.json has no @waishnav/devspace package entry.")
    expected_integrity = sha512_integrity(archive)
    if dependency.get("integrity") != expected_integrity:
        raise RuntimeError(
            "Packed core and app/package-lock.json are out of sync. "
            "Run npm run core:pack before building a release."
        )
    expected_resolved = f"file:../packages/{archive.name}"
    if dependency.get("resolved") != expected_resolved:
        raise RuntimeError(
            f"Unexpected @waishnav/devspace lockfile source: {dependency.get('resolved')!r}; "
            f"expected {expected_resolved!r}."
        )

    mismatches: list[str] = []
    checked = 0
    with tarfile.open(archive, mode="r:gz") as package:
        for member in package.getmembers():
            if not member.isfile() or not member.name.startswith("package/"):
                continue
            relative = member.name.removeprefix("package/")
            target = installed_root / Path(relative)
            if not target.is_file():
                mismatches.append(f"missing installed core file: {relative}")
                if len(mismatches) >= 20:
                    break
                continue
            source = package.extractfile(member)
            if source is None:
                mismatches.append(f"cannot read packed core file: {relative}")
                if len(mismatches) >= 20:
                    break
                continue
            packed_digest = hashlib.sha256(source.read()).hexdigest()
            installed_digest = sha256_file(target)
            checked += 1
            if packed_digest != installed_digest:
                mismatches.append(f"stale installed core file: {relative}")
                if len(mismatches) >= 20:
                    break
    if mismatches:
        raise RuntimeError(
            "app/node_modules/@waishnav/devspace does not match the packed core. "
            "Run npm ci --prefix app before building a release:\n" + "\n".join(mismatches)
        )
    print(f"Validated installed core: {checked} packed files match app/node_modules/@waishnav/devspace", flush=True)


def release_plugin_entries() -> list[tuple[Path, Path]]:
    """Map bundled plugin sources to their real installed path in the ZIP.

    The source checkout keeps bundled plugin templates under
    setup/bundled-plugins.  The distributable must additionally contain the
    bundled bridge at data/plugins/installed/<plugin>/<version>/ so a fresh
    extraction already has the plugin in the same location used by
    PluginManager.  The mapping is virtual: build-release never writes into
    the checkout's local data/ tree, which may contain developer credentials
    and runtime state.
    """
    entries: list[tuple[Path, Path]] = []
    if not BUNDLED_PLUGIN_SOURCE.is_dir():
        return entries

    for source in sorted(BUNDLED_PLUGIN_SOURCE.rglob("*")):
        if not source.is_file():
            continue
        relative = source.relative_to(BUNDLED_PLUGIN_SOURCE)
        entries.append((source, RELEASE_PLUGIN_PREFIX / relative))
    return entries


def validate_release_plugins(entries: list[tuple[Path, Path]]) -> None:
    targets = {target.as_posix() for _, target in entries}
    for plugin_id, required_files in REQUIRED_BUNDLED_PLUGIN_FILES.items():
        prefix = f"{RELEASE_PLUGIN_PREFIX.as_posix()}/{plugin_id}/"
        versions = sorted(
            {
                target[len(prefix):].split("/", 1)[0]
                for target in targets
                if target.startswith(prefix) and "/" in target[len(prefix):]
            }
        )
        if not versions:
            raise RuntimeError(
                f"Release payload must contain bundled plugin {plugin_id} under "
                f"{prefix}<version>/"
            )
        for version in versions:
            missing = sorted(
                relative
                for relative in required_files
                if f"{prefix}{version}/{relative}" not in targets
            )
            if missing:
                raise RuntimeError(
                    f"Bundled plugin {plugin_id}@{version} is incomplete; missing: {', '.join(missing)}"
                )


def release_files() -> list[Path]:
    files: list[Path] = []
    for current_root, dir_names, file_names in os.walk(ROOT):
        current = Path(current_root)
        relative_dir = current.relative_to(ROOT)
        if relative_dir == Path("."):
            dir_names[:] = sorted(
                name
                for name in dir_names
                if name not in EXCLUDED_TOP_LEVEL_DIRS
                and not name.startswith(".hotupdate-")
                and not name.startswith(".live-upgrade-")
                and not name.startswith(RELEASE_DIRECTORY_PREFIX)
                and name != "__pycache__"
            )
        elif relative_dir == Path("packages"):
            dir_names[:] = sorted(name for name in dir_names if name not in {"__pycache__", "staging"})
        else:
            dir_names[:] = sorted(name for name in dir_names if name != "__pycache__")
        for file_name in sorted(file_names):
            file_path = current / file_name
            relative = file_path.relative_to(ROOT)
            if relative.parent == Path(".") and file_name in EXCLUDED_TOP_LEVEL_FILES:
                continue
            # Source/regression tests intentionally leave a handful of
            # root-local `.tmp-*` diagnostics behind for post-failure review.
            # They are runtime/test state, not distributable payload. Exclude
            # the entire root-level namespace so future tests cannot silently
            # leak another temporary log/json/text artifact into a release ZIP.
            if relative.parent == Path(".") and file_name.startswith(".tmp-"):
                continue
            # Full regression runs may write progress/output logs beside the
            # source tree. They are operator diagnostics, not release inputs.
            if relative.parent == Path(".") and relative.suffix.lower() == ".log":
                continue
            if relative == Path("SHA256SUMS.txt"):
                continue
            if relative.suffix.lower() == ".zip":
                continue
            if relative.parent == Path(".") and relative.suffix.lower() == ".blockmap":
                continue
            if relative.suffix.lower() in {".pyc", ".pyo"}:
                continue
            if relative.parent == Path(".") and TEMP_NATIVE_UI_PATTERN.fullmatch(file_name):
                continue
            files.append(relative)
    return sorted(files, key=lambda item: item.as_posix())


def validate_release_payload(files: list[Path]) -> None:
    """Fail closed if runtime credentials/state escaped the directory filters.

    Directory exclusions are the first line of defense, but source checkouts
    can accumulate live-deployment snapshots under new directory names.  A
    second content-independent path check prevents a future backup folder from
    silently placing authentication or SQLite state in a release archive.
    The validator inspects names only and never opens sensitive files.
    """
    forbidden: list[str] = []
    for relative in files:
        name = relative.name.lower()
        if name in FORBIDDEN_RELEASE_BASENAMES or relative.suffix.lower() in FORBIDDEN_RELEASE_STATE_SUFFIXES:
            forbidden.append(relative.as_posix())
    if forbidden:
        preview = "\n".join(forbidden[:20])
        remainder = len(forbidden) - min(len(forbidden), 20)
        if remainder:
            preview += f"\n... and {remainder} more"
        raise RuntimeError(
            "Release payload contains credential/runtime-state file names and was blocked before checksumming:\n"
            + preview
        )


def refresh_manifest_keyfiles() -> None:
    """Re-hash the exact payload inputs after all release-time generators ran.

    finalize-release.py records key-file hashes before build-release.py runs.
    The native UI builder (and any other release-time generator invoked before
    this point) is allowed to replace generated artifacts, so carrying the old
    hashes into the ZIP can make VERSION-MANIFEST.json disagree with the files
    shipped beside it.  Refresh the existing fail-closed key-file set only
    after those generators finish, immediately before checksumming/archiving.
    """
    manifest_path = ROOT / "VERSION-MANIFEST.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    key_files = manifest.get("keyFiles")
    if not isinstance(key_files, dict) or not key_files:
        raise RuntimeError("VERSION-MANIFEST.json has no keyFiles mapping")

    refreshed: dict[str, str] = {}
    missing: list[str] = []
    for raw_key in sorted(key_files):
        relative = str(raw_key)
        if relative.endswith(".sha256"):
            relative = relative.removesuffix(".sha256")
        relative = relative.replace("\\", "/")
        source = ROOT / Path(relative)
        if not source.is_file():
            missing.append(relative)
            continue
        refreshed[f"{relative}.sha256"] = sha256_file(source)

    if missing:
        preview = "\n".join(missing[:20])
        raise RuntimeError(
            "VERSION-MANIFEST.json references missing release key files:\n" + preview
        )

    manifest["builtAt"] = datetime.now().astimezone().isoformat(timespec="seconds")
    manifest["keyFiles"] = refreshed
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )

    for key, expected in refreshed.items():
        relative = key.removesuffix(".sha256")
        actual = sha256_file(ROOT / Path(relative))
        if actual != expected:
            raise RuntimeError(
                f"release key-file hash changed while finalizing manifest: {relative}"
            )
    print(f"Refreshed release key-file manifest: {len(refreshed)} files", flush=True)


def release_version() -> str:
    manifest = json.loads((ROOT / "VERSION-MANIFEST.json").read_text(encoding="utf-8"))
    release = str(manifest.get("release", ""))
    prefix = "DevSpacePortable-Windows-x64-"
    if not release.startswith(prefix):
        raise RuntimeError(f"Unexpected release name in VERSION-MANIFEST.json: {release}")
    return release.removeprefix(prefix)


def write_checksums(files: list[Path], plugin_entries: list[tuple[Path, Path]]) -> None:
    lines: list[str] = []
    total = len(files) + len(plugin_entries)
    index = 0
    for index, relative in enumerate(files, start=1):
        lines.append(f"{sha256_file(ROOT / relative)}  {relative.as_posix()}\n")
        if index % 2000 == 0 or index == total:
            print(f"[checksum] {index}/{total}", flush=True)
    for source, target in plugin_entries:
        index += 1
        lines.append(f"{sha256_file(source)}  {target.as_posix()}\n")
        if index % 2000 == 0 or index == total:
            print(f"[checksum] {index}/{total}", flush=True)
    temporary = CHECKSUM_FILE.with_suffix(".txt.tmp")
    temporary.write_text("".join(lines), encoding="utf-8", newline="\n")
    temporary.replace(CHECKSUM_FILE)


def write_zip(files: list[Path], plugin_entries: list[tuple[Path, Path]], version: str) -> Path:
    output = ROOT / f"DevSpacePortable-Windows-x64-{version}.zip"
    temporary = output.with_suffix(".zip.tmp")
    temporary.unlink(missing_ok=True)
    output.unlink(missing_ok=True)
    archive_files = [*files, Path("SHA256SUMS.txt")]
    total = len(archive_files) + len(plugin_entries)
    index = 0
    with zipfile.ZipFile(
        temporary,
        mode="w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=6,
        allowZip64=True,
        strict_timestamps=False,
    ) as archive:
        archive.writestr("DevSpacePortable/", b"")
        for directory in EMPTY_RELEASE_DIRS:
            archive.writestr(f"DevSpacePortable/{directory}", b"")
        for index, relative in enumerate(archive_files, start=1):
            archive.write(ROOT / relative, f"DevSpacePortable/{relative.as_posix()}")
            if index % 2000 == 0 or index == total:
                print(f"[zip] {index}/{total}", flush=True)
        for source, target in plugin_entries:
            index += 1
            archive.write(source, f"DevSpacePortable/{target.as_posix()}")
            if index % 2000 == 0 or index == total:
                print(f"[zip] {index}/{total}", flush=True)
    temporary.replace(output)
    return output


def main() -> int:
    node = ROOT / "runtime" / "node" / "node.exe"
    native_ui_builder = ROOT / "setup" / "build-native-ui.cjs"
    if not node.exists():
        raise RuntimeError(f"Bundled Node runtime is missing: {node}")
    if not native_ui_builder.exists():
        raise RuntimeError(f"Native UI builder is missing: {native_ui_builder}")
    validate_source_checkout(node)
    validate_installed_core()
    subprocess.run([str(node), str(native_ui_builder)], cwd=ROOT, check=True)
    refresh_manifest_keyfiles()
    version = release_version()
    plugin_entries = release_plugin_entries()
    validate_release_plugins(plugin_entries)
    files = release_files()
    validate_release_payload(files)
    print(f"Release {version}: {len(files) + len(plugin_entries)} payload files", flush=True)
    write_checksums(files, plugin_entries)
    output = write_zip(files, plugin_entries, version)
    print(f"Created: {output}", flush=True)
    print(f"SHA-256: {sha256_file(output)}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
