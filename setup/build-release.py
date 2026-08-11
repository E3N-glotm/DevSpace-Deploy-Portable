from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECKSUM_FILE = ROOT / "SHA256SUMS.txt"
BUNDLED_PLUGIN_SOURCE = ROOT / "setup" / "bundled-plugins"
RELEASE_PLUGIN_PREFIX = Path("data/plugins/installed")
EMPTY_RELEASE_DIRS = ("data/", "data/run/", "logs/", "reports/")
EXCLUDED_TOP_LEVEL_DIRS = {
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


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


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
    codex_root = Path("data/plugins/installed/codex-runtime-bridge")
    codex_manifests = [
        target for _, target in entries
        if codex_root in target.parents and target.name == "manifest.json"
    ]
    if not codex_manifests:
        raise RuntimeError(
            "Release payload must contain data/plugins/installed/codex-runtime-bridge/<version>/manifest.json"
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
        else:
            dir_names[:] = sorted(name for name in dir_names if name != "__pycache__")
        for file_name in sorted(file_names):
            file_path = current / file_name
            relative = file_path.relative_to(ROOT)
            if relative.parent == Path(".") and file_name in EXCLUDED_TOP_LEVEL_FILES:
                continue
            if relative == Path("SHA256SUMS.txt"):
                continue
            if relative.suffix.lower() == ".zip":
                continue
            if relative.suffix.lower() in {".pyc", ".pyo"}:
                continue
            if relative.parent == Path(".") and TEMP_NATIVE_UI_PATTERN.fullmatch(file_name):
                continue
            files.append(relative)
    return sorted(files, key=lambda item: item.as_posix())


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
    subprocess.run([str(node), str(native_ui_builder)], cwd=ROOT, check=True)
    version = release_version()
    plugin_entries = release_plugin_entries()
    validate_release_plugins(plugin_entries)
    files = release_files()
    print(f"Release {version}: {len(files) + len(plugin_entries)} payload files", flush=True)
    write_checksums(files, plugin_entries)
    output = write_zip(files, plugin_entries, version)
    print(f"Created: {output}", flush=True)
    print(f"SHA-256: {sha256_file(output)}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
