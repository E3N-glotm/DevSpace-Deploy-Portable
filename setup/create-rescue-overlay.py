from __future__ import annotations

import argparse
import hashlib
import json
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[1]
PORTABLE_PREFIX = "DevSpacePortable/"
PERSISTENT_ROOTS = ("data", "logs", "reports")
CORE_ARCHIVE_PATTERN = re.compile(r"^packages/waishnav-devspace-(\d+\.\d+\.\d+)\.tgz$")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def parse_version(path: Path) -> str:
    prefix = "DevSpacePortable-Windows-x64-"
    if not path.name.startswith(prefix) or path.suffix.lower() != ".zip":
        raise ValueError(f"Cannot infer Portable version from ZIP name: {path.name}")
    version = path.stem.removeprefix(prefix)
    parts = version.split(".")
    if len(parts) != 3 or not all(part.isdigit() for part in parts):
        raise ValueError(f"Unsupported Portable version: {version}")
    return version


def normalize_relative(value: str) -> str:
    text = value.replace("\\", "/").lstrip("/")
    path = PurePosixPath(text)
    if not text or path.is_absolute() or ".." in path.parts or ":" in path.parts[0]:
        raise ValueError(f"Unsafe release path: {value}")
    return path.as_posix()


def is_persistent(relative: str) -> bool:
    parts = PurePosixPath(relative).parts
    return bool(parts) and parts[0] in PERSISTENT_ROOTS


def is_safe_obsolete_core_archive(relative: str, target_paths: set[str]) -> bool:
    match = CORE_ARCHIVE_PATTERN.fullmatch(relative)
    if not match:
        return False
    old_version = match.group(1)
    return any(
        (target_match := CORE_ARCHIVE_PATTERN.fullmatch(candidate)) is not None
        and target_match.group(1) != old_version
        for candidate in target_paths
    )


def hoisted_nested_dependency_path(relative: str) -> str | None:
    """Return the target hoisted path for one nested node_modules file.

    Example:
      app/node_modules/pkg/node_modules/ws/lib/x.js
      -> app/node_modules/ws/lib/x.js

    Scoped parents/dependencies are handled naturally by taking the suffix
    after the final nested `/node_modules/` boundary.
    """
    prefix = "app/node_modules/"
    if not relative.startswith(prefix):
        return None
    marker = "/node_modules/"
    nested_at = relative.rfind(marker)
    if nested_at < len(prefix):
        return None
    suffix = relative[nested_at + len(marker):]
    if not suffix:
        return None
    return prefix + suffix


def is_safe_redundant_nested_dependency(
    relative: str,
    *,
    base_hashes: dict[str, str],
    target_hashes: dict[str, str],
) -> bool:
    """Allow a deleted nested dependency file only when target hoists an
    exact byte-identical copy.

    A direct-extract overlay cannot delete the old nested file. Leaving it is
    safe only if Node resolving that stale nested path would obtain the exact
    same bytes as the target's hoisted dependency. Any missing or different
    target file remains fail-closed.
    """
    hoisted = hoisted_nested_dependency_path(relative)
    if not hoisted:
        return False
    base_digest = base_hashes.get(relative)
    target_digest = target_hashes.get(hoisted)
    return bool(base_digest and target_digest and base_digest == target_digest)


def file_infos(archive: zipfile.ZipFile) -> dict[str, zipfile.ZipInfo]:
    result: dict[str, zipfile.ZipInfo] = {}
    for info in archive.infolist():
        name = info.filename.replace("\\", "/")
        if info.is_dir() or not name.startswith(PORTABLE_PREFIX):
            continue
        relative = normalize_relative(name.removeprefix(PORTABLE_PREFIX))
        if is_persistent(relative):
            continue
        result[relative] = info
    return result


def checksum_map(archive: zipfile.ZipFile) -> dict[str, str]:
    result: dict[str, str] = {}
    text = archive.read(PORTABLE_PREFIX + "SHA256SUMS.txt").decode("utf-8")
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        digest, relative_raw = line.split(None, 1)
        relative = normalize_relative(relative_raw.strip())
        if is_persistent(relative):
            continue
        result[relative] = digest.lower()
    checksum_info = file_infos(archive).get("SHA256SUMS.txt")
    if checksum_info is not None:
        result["SHA256SUMS.txt"] = hashlib.sha256(archive.read(checksum_info)).hexdigest()
    return result


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Create a direct-extract rescue overlay for one exact Portable base version."
    )
    parser.add_argument("--base-zip", required=True)
    parser.add_argument("--target-zip", required=True)
    parser.add_argument("--output")
    args = parser.parse_args()

    base_zip = Path(args.base_zip).resolve()
    target_zip = Path(args.target_zip).resolve()
    if not base_zip.is_file():
        raise SystemExit(f"Base release ZIP not found: {base_zip}")
    if not target_zip.is_file():
        raise SystemExit(f"Target release ZIP not found: {target_zip}")

    from_version = parse_version(base_zip)
    to_version = parse_version(target_zip)
    output = (
        Path(args.output).resolve()
        if args.output
        else ROOT / f"DevSpacePortable-Rescue-{from_version}-to-{to_version}.zip"
    )

    with zipfile.ZipFile(base_zip, "r") as base_archive, zipfile.ZipFile(target_zip, "r") as target_archive:
        base_infos = file_infos(base_archive)
        target_infos = file_infos(target_archive)
        base_hashes = checksum_map(base_archive)
        target_hashes = checksum_map(target_archive)

        changed_paths = sorted(
            relative
            for relative in target_infos
            if target_hashes.get(relative) != base_hashes.get(relative)
        )
        deleted_paths = sorted(relative for relative in base_infos if relative not in target_infos)
        ignored_obsolete_files = sorted(
            relative
            for relative in deleted_paths
            if is_safe_obsolete_core_archive(relative, set(target_infos))
            or is_safe_redundant_nested_dependency(
                relative,
                base_hashes=base_hashes,
                target_hashes=target_hashes,
            )
        )
        unsafe_deleted_paths = sorted(set(deleted_paths) - set(ignored_obsolete_files))
        if unsafe_deleted_paths:
            preview = ", ".join(unsafe_deleted_paths[:12])
            raise SystemExit(
                "Direct-extract rescue overlay is not safe because the target removes files from the base release: "
                + preview
            )

        mandatory = {
            "DevSpace-Portable.exe",
            "Update.exe",
            "VERSION-MANIFEST.json",
            "SHA256SUMS.txt",
            "setup/portable-manager.cjs",
            "setup/portable-updater.ps1",
        }
        missing = sorted(relative for relative in mandatory if relative not in changed_paths)
        if missing:
            raise SystemExit(
                "Rescue overlay would not replace mandatory updater/version files: " + ", ".join(missing)
            )

        manifest = {
            "schemaVersion": 1,
            "format": "direct-overlay-v1",
            "fromVersion": from_version,
            "toVersion": to_version,
            "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "baseRelease": {"name": base_zip.name, "sha256": sha256_file(base_zip)},
            "targetRelease": {"name": target_zip.name, "sha256": sha256_file(target_zip)},
            "persistentRootsExcluded": list(PERSISTENT_ROOTS),
            "changedFiles": changed_paths,
            "deletedFiles": [],
            "ignoredObsoleteFiles": ignored_obsolete_files,
        }
        readme = f"""DevSpace Portable {from_version} -> {to_version} rescue overlay

用途：绕过 {from_version} 自带 Update.exe 的在线安装事务，直接覆盖升级到 {to_version}。

使用方法：
1. 先关闭 DevSpace Portable 控制中心和 Update.exe，并停止 DevSpace Portable 服务。
2. 把本 ZIP 的内容直接解压到原 DevSpacePortable 安装目录根部。
3. Windows 询问同名文件时选择“全部替换”。
4. 重新启动 DevSpace-Portable.exe；VERSION-MANIFEST.json 应显示 {to_version}。

本救援包不包含 data、logs、reports，因此不会覆盖 Owner Password、OAuth、Token、插件运行状态、SQLite、用户配置和日志。
如果基础版本残留旧 packages/waishnav-devspace-<version>.tgz，且目标版本已携带新的 core TGZ，本救援包允许该旧归档继续留在 packages 目录；它不会被运行时加载，app/package.json 与 lockfile 只指向目标版本 core。
如果基础版本残留已被 npm 提升到 app/node_modules 的嵌套依赖文件，本救援包只会在旧嵌套文件与目标 hoisted 文件 SHA-256 完全一致时允许其继续留存；任何字节差异仍会拒绝生成 Rescue。
本包只允许从 {from_version} 使用；不要用于其他基础版本。
"""

        temporary = output.with_suffix(output.suffix + ".tmp")
        temporary.unlink(missing_ok=True)
        output.unlink(missing_ok=True)
        with zipfile.ZipFile(
            temporary,
            mode="w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=6,
            allowZip64=True,
            strict_timestamps=False,
        ) as rescue:
            rescue.writestr(
                "RESCUE-MANIFEST.json",
                json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8") + b"\n",
            )
            rescue.writestr(
                f"README-RESCUE-{from_version}-to-{to_version}.txt",
                readme.encode("utf-8"),
            )
            for index, relative in enumerate(changed_paths, start=1):
                rescue.writestr(relative, target_archive.read(target_infos[relative]))
                if index % 500 == 0 or index == len(changed_paths):
                    print(f"[rescue] {index}/{len(changed_paths)} overlay files", flush=True)
        temporary.replace(output)

    print(
        json.dumps(
            {
                "fromVersion": from_version,
                "toVersion": to_version,
                "changedFiles": len(changed_paths),
                "deletedFiles": 0,
                "ignoredObsoleteFiles": ignored_obsolete_files,
                "persistentRootsExcluded": list(PERSISTENT_ROOTS),
                "output": str(output),
                "bytes": output.stat().st_size,
                "sha256": sha256_file(output),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
