from __future__ import annotations

import argparse
import hashlib
import json
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath


PORTABLE_PREFIX = "DevSpacePortable/"
DELTA_PREFIX = "DevSpacePortableDelta/"
MARKER_PATH = "setup/legacy-upgrade-bootstrap.json"
BRIDGE_TARGET_FILES = (
    "DevSpace-Portable.exe",
    "VERSION-MANIFEST.json",
    "setup/portable-updater.ps1",
    "setup/portable-manager.cjs",
)

# These are the published Portable releases that already understand the
# file-delta-v1 compatibility path but pre-date the hardened long-path/progress
# updater.  A direct bridge for each version lets an installed legacy updater
# avoid unpacking the full modern node_modules tree before the hardened updater
# has been installed.
LEGACY_BRIDGE_FROM_VERSIONS = (
    "1.1.36",
    "1.1.37",
    "1.1.38",
    "1.1.39",
    "1.1.40",
    "1.1.41",
    "1.1.42",
    "1.1.43",
    "1.1.44",
    "1.1.45",
    "1.1.46",
    "1.1.47",
    "1.1.48",
    "1.1.49",
    "1.1.51",
    "1.1.52",
    "1.1.54",
    "1.1.56",
    "1.1.57",
    "1.1.58",
)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def validate_version(value: str) -> str:
    version = str(value).strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError(f"Unsupported Portable version: {value}")
    return version


def target_version_from_zip(path: Path) -> str:
    prefix = "DevSpacePortable-Windows-x64-"
    if not path.name.startswith(prefix) or path.suffix.lower() != ".zip":
        raise ValueError(f"Cannot infer Portable version from ZIP name: {path.name}")
    return validate_version(path.stem.removeprefix(prefix))


def safe_relative(value: str) -> str:
    text = str(value).replace("\\", "/").lstrip("/")
    path = PurePosixPath(text)
    if not text or path.is_absolute() or ".." in path.parts or ":" in path.parts[0]:
        raise ValueError(f"Unsafe bridge path: {value}")
    return path.as_posix()


def read_target_file(archive: zipfile.ZipFile, relative: str) -> bytes:
    relative = safe_relative(relative)
    try:
        return archive.read(PORTABLE_PREFIX + relative)
    except KeyError as exc:
        raise ValueError(f"Target release ZIP is missing bridge file: {relative}") from exc


def create_bridge(from_version: str, target_zip: Path, output: Path | None = None) -> Path:
    from_version = validate_version(from_version)
    target_zip = target_zip.resolve()
    if not target_zip.is_file():
        raise ValueError(f"Target release ZIP not found: {target_zip}")
    target_version = target_version_from_zip(target_zip)
    if tuple(map(int, from_version.split("."))) >= tuple(map(int, target_version.split("."))):
        raise ValueError("Legacy bridge must move forward in version order")
    policy = json.loads((Path(__file__).with_name("legacy-release-policy.json")).read_text(encoding="utf-8"))
    bootstrap = policy["bootstrapVersion"]
    allowed_sources = (policy["legacyFromVersions"] if target_version == bootstrap
                       else [bootstrap, *policy["legacyDirectOnlyVersions"]])
    if target_version in policy["developmentOnlyVersions"] or from_version not in allowed_sources:
        raise ValueError("Legacy bridges must use the stable 1.1.60 bootstrap policy")

    output = (
        output.resolve()
        if output is not None
        else target_zip.parent / f"DevSpacePortable-Update-{from_version}-to-{target_version}.zip"
    )

    marker = json.dumps(
        {
            "schemaVersion": 1,
            "kind": "legacy-upgrade-bootstrap",
            "fromVersion": from_version,
            "targetVersion": target_version,
            "repairMode": "same-version-force-full",
        },
        ensure_ascii=False,
        indent=2,
    ).encode("utf-8") + b"\n"

    with zipfile.ZipFile(target_zip, "r") as target:
        payload: dict[str, bytes] = {
            relative: read_target_file(target, relative)
            for relative in BRIDGE_TARGET_FILES
        }
    version_manifest = json.loads(payload["VERSION-MANIFEST.json"].decode("utf-8-sig"))
    if version_manifest.get("development") or str(version_manifest.get("runtime", {}).get("devspacePortable", "")) != target_version:
        raise ValueError("Bridge target must contain matching stable Portable metadata")
    payload[MARKER_PATH] = marker

    changed_files = [
        {
            "path": relative,
            "size": len(content),
            "sha256": sha256_bytes(content),
        }
        for relative, content in sorted(payload.items())
    ]
    delta_manifest = {
        "schemaVersion": 1,
        "format": "file-delta-v1",
        "fromVersion": from_version,
        "toVersion": target_version,
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "legacyBootstrap": True,
        "repairMode": "same-version-force-full",
        "changedFiles": changed_files,
        "deletedFiles": [],
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
    ) as bridge:
        bridge.writestr(DELTA_PREFIX, b"")
        bridge.writestr(DELTA_PREFIX + "files/", b"")
        bridge.writestr(
            DELTA_PREFIX + "delta-manifest.json",
            json.dumps(delta_manifest, ensure_ascii=False, indent=2).encode("utf-8") + b"\n",
        )
        for relative, content in sorted(payload.items()):
            bridge.writestr(DELTA_PREFIX + "files/" + relative, content)
    temporary.replace(output)
    return output


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Create a shallow file-delta-v1 bridge that bootstraps hardened Portable updates on legacy clients."
    )
    parser.add_argument("--from-version", required=True)
    parser.add_argument("--target-zip", required=True)
    parser.add_argument("--output")
    args = parser.parse_args()

    output = create_bridge(
        args.from_version,
        Path(args.target_zip),
        Path(args.output) if args.output else None,
    )
    with zipfile.ZipFile(output, "r") as archive:
        longest = max(len(info.filename) for info in archive.infolist())
    print(
        json.dumps(
            {
                "fromVersion": validate_version(args.from_version),
                "toVersion": target_version_from_zip(Path(args.target_zip)),
                "output": str(output),
                "bytes": output.stat().st_size,
                "sha256": sha256_file(output),
                "longestArchivePath": longest,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
