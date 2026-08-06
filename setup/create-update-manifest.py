from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION_MANIFEST = ROOT / "VERSION-MANIFEST.json"
OUTPUT_DIRECTORY = ROOT / "release-assets"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", default="E3N-glotm/DevSpace-Deploy-Portable")
    parser.add_argument("--zip")
    parser.add_argument("--channel", default="stable", choices=("stable", "beta", "nightly"))
    args = parser.parse_args()

    version_manifest = json.loads(VERSION_MANIFEST.read_text(encoding="utf-8"))
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
    manifest = {
        "schemaVersion": 1,
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
        "requiresToolSchemaRefresh": False,
        "asset": {
            "name": asset_name,
            "size": archive.stat().st_size,
            "sha256": digest,
            "downloadUrl": f"https://github.com/{args.repository}/releases/download/v{version}/{asset_name}",
        },
        "releaseNotes": f"docs/releases/HOTFIX-{version}.md",
    }

    OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIRECTORY / "update-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    (OUTPUT_DIRECTORY / "SHA256SUMS-release.txt").write_text(
        f"{digest}  {asset_name}\n",
        encoding="utf-8",
        newline="\n",
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

