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
DELTA_PREFIX = "DevSpacePortableDelta/"
PERSISTENT_ROOTS = ("data", "logs", "reports")
REQUIRED_BUNDLED_PREFIXES = (
    "setup/bundled-plugins/codex-runtime-bridge/",
)
RETAINABLE_OBSOLETE_PATTERNS = (
    # The packed core archive is a build/install input referenced by the
    # release-specific app/package-lock.json.  After an update points the
    # lockfile at a newer archive, an older archive is inert.  Some historical
    # same-version Portable repacks produced byte-different TGZs, so putting
    # these obsolete archives in deletedFiles makes old updaters reject an
    # otherwise safe delta with "deleted file has local drift".  Retain the
    # stale archive instead; it is neither executed nor referenced by the
    # target release.
    re.compile(r"^packages/waishnav-devspace-\d+\.\d+\.\d+\.tgz$"),
)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def parse_version_from_zip(path: Path) -> str:
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
    first = PurePosixPath(relative).parts[0] if PurePosixPath(relative).parts else ""
    return first in PERSISTENT_ROOTS


def is_retainable_obsolete(relative: str) -> bool:
    return any(pattern.fullmatch(relative) for pattern in RETAINABLE_OBSOLETE_PATTERNS)


def release_file_infos(archive: zipfile.ZipFile) -> dict[str, zipfile.ZipInfo]:
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
    checksum_name = PORTABLE_PREFIX + "SHA256SUMS.txt"
    try:
        text = archive.read(checksum_name).decode("utf-8")
    except KeyError as exc:
        raise ValueError(f"Release ZIP is missing {checksum_name}") from exc
    result: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) != 2 or len(parts[0]) != 64:
            raise ValueError(f"Malformed checksum line: {raw}")
        relative = normalize_relative(parts[1].strip())
        if is_persistent(relative):
            continue
        result[relative] = parts[0].lower()
    return result


def entry_sha256(archive: zipfile.ZipFile, info: zipfile.ZipInfo) -> str:
    digest = hashlib.sha256()
    with archive.open(info, "r") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a file-level incremental Portable update package.")
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
    base_version = parse_version_from_zip(base_zip)
    target_version = parse_version_from_zip(target_zip)
    output = (
        Path(args.output).resolve()
        if args.output
        else ROOT / f"DevSpacePortable-Update-{base_version}-to-{target_version}.zip"
    )

    with zipfile.ZipFile(base_zip, "r") as base_archive, zipfile.ZipFile(target_zip, "r") as target_archive:
        base_infos = release_file_infos(base_archive)
        target_infos = release_file_infos(target_archive)
        base_hashes = checksum_map(base_archive)
        target_hashes = checksum_map(target_archive)

        # SHA256SUMS.txt intentionally does not hash itself, so add its digest
        # explicitly. This also guarantees that a delta installs the target
        # release checksum inventory.
        base_checksum_info = base_infos.get("SHA256SUMS.txt")
        target_checksum_info = target_infos.get("SHA256SUMS.txt")
        if base_checksum_info is not None:
            base_hashes["SHA256SUMS.txt"] = entry_sha256(base_archive, base_checksum_info)
        if target_checksum_info is not None:
            target_hashes["SHA256SUMS.txt"] = entry_sha256(target_archive, target_checksum_info)

        changed_paths = sorted(
            path for path in target_infos
            if target_hashes.get(path) != base_hashes.get(path)
        )
        required_bundled_paths = sorted(
            path for path in target_infos
            if any(path.startswith(prefix) for prefix in REQUIRED_BUNDLED_PREFIXES)
        )
        for prefix in REQUIRED_BUNDLED_PREFIXES:
            if not any(path.startswith(prefix) for path in required_bundled_paths):
                raise ValueError(
                    f"Target release ZIP is missing mandatory bundled plugin payload under {prefix}"
                )
        included_paths = sorted(set(changed_paths) | set(required_bundled_paths))
        removed_paths = sorted(path for path in base_infos if path not in target_infos)
        retained_obsolete_paths = sorted(
            path for path in removed_paths if is_retainable_obsolete(path)
        )
        deleted_paths = sorted(
            path for path in removed_paths if not is_retainable_obsolete(path)
        )

        changed_files: list[dict[str, object]] = []
        for relative in included_paths:
            info = target_infos[relative]
            target_hash = target_hashes.get(relative) or entry_sha256(target_archive, info)
            base_hash = base_hashes.get(relative)
            changed_files.append(
                {
                    "path": relative,
                    "size": info.file_size,
                    "sha256": target_hash,
                    "baseSha256": base_hash,
                }
            )

        deleted_files: list[dict[str, object]] = []
        for relative in deleted_paths:
            info = base_infos[relative]
            deleted_files.append(
                {
                    "path": relative,
                    "baseSha256": base_hashes.get(relative) or entry_sha256(base_archive, info),
                }
            )

        delta_manifest = {
            "schemaVersion": 1,
            "format": "file-delta-v1",
            "fromVersion": base_version,
            "toVersion": target_version,
            "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "baseRelease": {
                "name": base_zip.name,
                "sha256": sha256_file(base_zip),
            },
            "targetRelease": {
                "name": target_zip.name,
                "sha256": sha256_file(target_zip),
            },
            "persistentRoots": list(PERSISTENT_ROOTS),
            "alwaysIncludedPrefixes": list(REQUIRED_BUNDLED_PREFIXES),
            "retainedObsoleteFiles": retained_obsolete_paths,
            "changedFiles": changed_files,
            "deletedFiles": deleted_files,
        }

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
        ) as delta:
            delta.writestr(DELTA_PREFIX, b"")
            delta.writestr(DELTA_PREFIX + "files/", b"")
            delta.writestr(
                DELTA_PREFIX + "delta-manifest.json",
                json.dumps(delta_manifest, ensure_ascii=False, indent=2).encode("utf-8") + b"\n",
            )
            for index, relative in enumerate(included_paths, start=1):
                info = target_infos[relative]
                delta.writestr(
                    DELTA_PREFIX + "files/" + relative,
                    target_archive.read(info),
                )
                if index % 500 == 0 or index == len(included_paths):
                    print(f"[delta] {index}/{len(included_paths)} update files", flush=True)
        temporary.replace(output)

    print(
        json.dumps(
            {
                "fromVersion": base_version,
                "toVersion": target_version,
                "changedFiles": len(changed_paths),
                "includedFiles": len(included_paths),
                "requiredBundledFiles": len(required_bundled_paths),
                "deletedFiles": len(deleted_paths),
                "retainedObsoleteFiles": len(retained_obsolete_paths),
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
