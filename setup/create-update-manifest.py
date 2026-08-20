from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION_MANIFEST = ROOT / "VERSION-MANIFEST.json"
OUTPUT_DIRECTORY = ROOT / "release-assets"
BLOCKMAP_MAGIC = b"DSPBLK2\n"
BLOCKMAP_PRELUDE = struct.Struct("<8sQQ")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def read_blockmap_metadata(path: Path) -> dict[str, object]:
    with path.open("rb") as handle:
        prelude = handle.read(BLOCKMAP_PRELUDE.size)
        if len(prelude) != BLOCKMAP_PRELUDE.size:
            raise SystemExit(f"Blockmap prelude is truncated: {path}")
        magic, compressed_size, raw_size = BLOCKMAP_PRELUDE.unpack(prelude)
        if magic != BLOCKMAP_MAGIC:
            raise SystemExit(f"Unsupported blockmap magic: {path}")
        if compressed_size <= 0 or raw_size <= 0 or compressed_size > path.stat().st_size - BLOCKMAP_PRELUDE.size:
            raise SystemExit(f"Invalid blockmap header sizes: {path}")
        compressed_header = handle.read(compressed_size)
        if len(compressed_header) != compressed_size:
            raise SystemExit(f"Blockmap header is truncated: {path}")
    return {
        "format": "block-pack-v2",
        "headerCompressedSize": compressed_size,
        "headerRawSize": raw_size,
        "headerSha256": hashlib.sha256(compressed_header).hexdigest(),
    }


def merge_incremental_graph(
    repository: str,
    current_assets: list[dict[str, object]],
    previous_manifest: dict[str, object] | None,
) -> list[dict[str, object]]:
    merged: dict[tuple[str, str, str], dict[str, object]] = {}

    def add(item: object) -> None:
        if not isinstance(item, dict):
            return
        if str(item.get("format", "")) != "file-delta-v1":
            return
        from_version = str(item.get("fromVersion", ""))
        to_version = str(item.get("toVersion", ""))
        name = str(item.get("name", ""))
        if not re.fullmatch(r"\d+\.\d+\.\d+", from_version):
            return
        if not re.fullmatch(r"\d+\.\d+\.\d+", to_version):
            return
        expected_name = f"DevSpacePortable-Update-{from_version}-to-{to_version}.zip"
        if name != expected_name:
            return
        try:
            size = int(item.get("size", 0))
        except (TypeError, ValueError):
            return
        sha256 = str(item.get("sha256", "")).lower()
        download_url = str(item.get("downloadUrl", ""))
        expected_url = f"https://github.com/{repository}/releases/download/v{to_version}/{name}"
        if size <= 0 or not re.fullmatch(r"[0-9a-f]{64}", sha256) or download_url != expected_url:
            return
        merged[(from_version, to_version, name)] = {
            "format": "file-delta-v1",
            "fromVersion": from_version,
            "toVersion": to_version,
            "name": name,
            "size": size,
            "sha256": sha256,
            "downloadUrl": download_url,
        }

    if previous_manifest:
        if str(previous_manifest.get("repository", "")) != repository:
            raise SystemExit("Carry-forward update manifest repository does not match the configured repository.")
        for item in previous_manifest.get("incrementalGraphAssets", []):
            add(item)
        for item in previous_manifest.get("incrementalAssets", []):
            add(item)
    for item in current_assets:
        add(item)

    def version_key(value: str) -> tuple[int, int, int]:
        return tuple(int(part) for part in value.split("."))  # type: ignore[return-value]

    return sorted(
        merged.values(),
        key=lambda item: (
            version_key(str(item["toVersion"])),
            version_key(str(item["fromVersion"])),
            str(item["name"]),
        ),
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", default="E3N-glotm/DevSpace-Deploy-Portable")
    parser.add_argument("--zip")
    parser.add_argument("--incremental", action="append", default=[])
    parser.add_argument("--blockmap")
    parser.add_argument("--rescue", action="append", default=[])
    parser.add_argument("--carry-forward-manifest")
    parser.add_argument("--channel", default="stable", choices=("stable", "beta", "nightly"))
    args = parser.parse_args()

    version_manifest = json.loads(VERSION_MANIFEST.read_text(encoding="utf-8"))
    release_metadata = version_manifest.get("releaseMetadata", {})
    release_name = str(version_manifest["release"])
    prefix = "DevSpacePortable-Windows-x64-"
    if not release_name.startswith(prefix):
        raise SystemExit(f"Invalid release name: {release_name}")
    version = release_name.removeprefix(prefix)
    archive = Path(args.zip).resolve() if args.zip else ROOT / f"{release_name}.zip"
    if not archive.is_file():
        raise SystemExit(f"Release ZIP not found: {archive}")

    digest = sha256_file(archive)
    asset_name = archive.name
    incremental_assets = []
    delta_pattern = re.compile(r"^DevSpacePortable-Update-(\d+\.\d+\.\d+)-to-(\d+\.\d+\.\d+)\.zip$")
    for raw in args.incremental:
        delta = Path(raw).resolve()
        if not delta.is_file():
            raise SystemExit(f"Incremental update ZIP not found: {delta}")
        match = delta_pattern.fullmatch(delta.name)
        if not match:
            raise SystemExit(f"Invalid incremental update asset name: {delta.name}")
        from_version, to_version = match.groups()
        if to_version != version:
            raise SystemExit(f"Incremental update target {to_version} does not match release {version}")
        incremental_assets.append(
            {
                "format": "file-delta-v1",
                "fromVersion": from_version,
                "toVersion": to_version,
                "name": delta.name,
                "size": delta.stat().st_size,
                "sha256": sha256_file(delta),
                "downloadUrl": f"https://github.com/{args.repository}/releases/download/v{version}/{delta.name}",
            }
        )
    rescue_assets = []
    rescue_pattern = re.compile(r"^DevSpacePortable-Rescue-(\d+\.\d+\.\d+)-to-(\d+\.\d+\.\d+)\.zip$")
    for raw in args.rescue:
        rescue = Path(raw).resolve()
        if not rescue.is_file():
            raise SystemExit(f"Rescue overlay ZIP not found: {rescue}")
        match = rescue_pattern.fullmatch(rescue.name)
        if not match:
            raise SystemExit(f"Invalid rescue overlay asset name: {rescue.name}")
        from_version, to_version = match.groups()
        if to_version != version:
            raise SystemExit(f"Rescue overlay target {to_version} does not match release {version}")
        rescue_assets.append(
            {
                "format": "direct-overlay-v1",
                "fromVersion": from_version,
                "toVersion": to_version,
                "name": rescue.name,
                "size": rescue.stat().st_size,
                "sha256": sha256_file(rescue),
                "downloadUrl": f"https://github.com/{args.repository}/releases/download/v{version}/{rescue.name}",
            }
        )
    previous_manifest = None
    if args.carry_forward_manifest:
        carry_forward = Path(args.carry_forward_manifest).resolve()
        if not carry_forward.is_file():
            raise SystemExit(f"Carry-forward update manifest not found: {carry_forward}")
        previous_manifest = json.loads(carry_forward.read_text(encoding="utf-8-sig"))
    incremental_graph_assets = merge_incremental_graph(args.repository, incremental_assets, previous_manifest)
    blockmap_asset = None
    if args.blockmap:
        blockmap = Path(args.blockmap).resolve()
        if not blockmap.is_file():
            raise SystemExit(f"Blockmap not found: {blockmap}")
        metadata = read_blockmap_metadata(blockmap)
        blockmap_asset = {
            **metadata,
            "name": blockmap.name,
            "size": blockmap.stat().st_size,
            "sha256": sha256_file(blockmap),
            "targetVersion": version,
            "downloadUrl": f"https://github.com/{args.repository}/releases/download/v{version}/{blockmap.name}",
        }
    manifest = {
        "schemaVersion": 3,
        "channel": args.channel,
        "version": version,
        "tag": f"v{version}",
        "publishedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "repository": args.repository,
        "protocolVersion": str(version_manifest.get("devspaceSource", {}).get("portableProtocolVersion", "1.5")),
        "dataSchemaVersion": 5,
        "minimumUpdaterVersion": "1.0.0",
        "mandatory": False,
        "restartRequired": True,
        "requiresToolSchemaRefresh": bool(release_metadata.get("requiresToolSchemaRefresh", False)),
        "updateStrategy": "blockmap-first-full-fallback" if blockmap_asset else "incremental-first-full-fallback",
        "asset": {
            "name": asset_name,
            "size": archive.stat().st_size,
            "sha256": digest,
            "downloadUrl": f"https://github.com/{args.repository}/releases/download/v{version}/{asset_name}",
        },
        "incrementalAssets": incremental_assets,
        "incrementalGraphAssets": incremental_graph_assets,
        "blockmapAsset": blockmap_asset,
        "rescueAssets": rescue_assets,
        "releaseNotes": f"docs/releases/HOTFIX-{version}.md",
    }

    OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIRECTORY / "update-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    checksum_lines = [f"{digest}  {asset_name}\n"]
    if blockmap_asset:
        checksum_lines.append(f"{blockmap_asset['sha256']}  {blockmap_asset['name']}\n")
    checksum_lines.extend(f"{item['sha256']}  {item['name']}\n" for item in incremental_assets)
    checksum_lines.extend(f"{item['sha256']}  {item['name']}\n" for item in rescue_assets)
    (OUTPUT_DIRECTORY / "SHA256SUMS-release.txt").write_text(
        "".join(checksum_lines),
        encoding="utf-8",
        newline="\n",
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

