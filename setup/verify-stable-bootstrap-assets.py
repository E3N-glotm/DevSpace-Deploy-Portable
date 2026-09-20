"""Fail closed before publishing the first stable legacy-updater bootstrap.

This verifies the ACTUAL built ZIPs and published manifest, not small fixtures.
The fixture/historical Apply suite remains separately required by test-source.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
POLICY = json.loads((ROOT / "setup/legacy-release-policy.json").read_text(encoding="utf-8"))
BOOTSTRAP = POLICY["bootstrapVersion"]
TARGET = f"DevSpacePortable-Windows-x64-{BOOTSTRAP}.zip"
PREFIX = "DevSpacePortable/"
DELTA = "DevSpacePortableDelta/"
FILES = {
    "DevSpace-Portable.exe",
    "VERSION-MANIFEST.json",
    "setup/portable-updater.ps1",
    "setup/portable-manager.cjs",
    "setup/legacy-upgrade-bootstrap.json",
}


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def assert_asset(asset: dict, name: str) -> Path:
    assert asset["name"] == name, f"asset name mismatch: {asset['name']} != {name}"
    path = ROOT / name
    assert path.is_file(), f"missing release asset: {name}"
    assert path.stat().st_size == asset["size"], f"size mismatch: {name}"
    assert digest(path) == asset["sha256"], f"digest mismatch: {name}"
    expected_url = (
        f"https://github.com/E3N-glotm/DevSpace-Deploy-Portable/"
        f"releases/download/v{BOOTSTRAP}/{name}"
    )
    assert asset["downloadUrl"] == expected_url, f"download URL mismatch: {name}"
    return path


manifest = json.loads((ROOT / "release-assets/update-manifest.json").read_text(encoding="utf-8"))
assert BOOTSTRAP == "1.1.61", "this first-bootstrap verification must be revised for a new baseline"
assert manifest["version"] == BOOTSTRAP and manifest["tag"] == f"v{BOOTSTRAP}"
assert manifest["channel"] == "stable"
assert manifest["repository"] == "E3N-glotm/DevSpace-Deploy-Portable"
full_zip = assert_asset(manifest["asset"], TARGET)
blockmap_name = f"DevSpacePortable-Windows-x64-{BOOTSTRAP}.blockmap"
assert_asset(manifest["blockmapAsset"], blockmap_name)

sources = set(POLICY["legacyFromVersions"])
assert len(sources) == 20
assets = manifest["incrementalAssets"]
graph = manifest["incrementalGraphAssets"]
assert len(assets) == len(graph) == len(sources), "missing, extra or duplicated historical edges"
assert {a["fromVersion"] for a in assets} == sources
assert {a["fromVersion"] for a in graph} == sources
assert all(a["toVersion"] == BOOTSTRAP and a["format"] == "file-delta-v1" for a in assets)
assert all(a["toVersion"] == BOOTSTRAP for a in graph), "unpublished 1.1.60 transit is forbidden"

with ZipFile(full_zip) as archive:
    target_manifest = json.loads(archive.read(PREFIX + "VERSION-MANIFEST.json"))
    assert target_manifest["runtime"]["devspacePortable"] == BOOTSTRAP
    assert not target_manifest.get("development"), "dev builds cannot be stable bootstrap targets"
    full_hashes = {
        name: hashlib.sha256(archive.read(PREFIX + name)).hexdigest()
        for name in FILES if name != "setup/legacy-upgrade-bootstrap.json"
    }

for asset in assets:
    from_version = asset["fromVersion"]
    name = f"DevSpacePortable-Update-{from_version}-to-{BOOTSTRAP}.zip"
    path = assert_asset(asset, name)
    with ZipFile(path) as archive:
        delta = json.loads(archive.read(DELTA + "delta-manifest.json"))
        assert delta["format"] == "file-delta-v1"
        assert delta["fromVersion"] == from_version and delta["toVersion"] == BOOTSTRAP
        assert delta["legacyBootstrap"] is True and delta["repairMode"] == "same-version-force-full"
        assert delta["deletedFiles"] == []
        changed = delta["changedFiles"]
        assert len(changed) == len(FILES)
        assert {entry["path"] for entry in changed} == FILES
        for entry in changed:
            relative = entry["path"]
            content = archive.read(DELTA + "files/" + relative)
            assert len(content) == entry["size"]
            actual = hashlib.sha256(content).hexdigest()
            assert actual == entry["sha256"]
            if relative in full_hashes:
                assert actual == full_hashes[relative], f"bootstrap does not match full ZIP: {relative}"
            else:
                marker = json.loads(content)
                assert marker["fromVersion"] == from_version and marker["targetVersion"] == BOOTSTRAP

rescue_assets = manifest["rescueAssets"]
assert len(rescue_assets) == 1, "the first stable release requires the exact 1.1.33 rescue"
rescue = rescue_assets[0]
assert rescue["fromVersion"] == "1.1.33" and rescue["toVersion"] == BOOTSTRAP
rescue_name = f"DevSpacePortable-Rescue-1.1.33-to-{BOOTSTRAP}.zip"
with ZipFile(assert_asset(rescue, rescue_name)) as archive:
    names = set(archive.namelist())
    assert "RESCUE-MANIFEST.json" in names
    rescued = json.loads(archive.read("RESCUE-MANIFEST.json"))
    assert rescued["fromVersion"] == "1.1.33" and rescued["toVersion"] == BOOTSTRAP
    assert not any(name.split("/", 1)[0] in {"data", "logs", "reports"} for name in names)
    assert "VERSION-MANIFEST.json" in names and "setup/portable-updater.ps1" in names

checksums = (ROOT / "release-assets/SHA256SUMS-release.txt").read_text(encoding="utf-8")
for asset in [manifest["asset"], manifest["blockmapAsset"], *assets, *rescue_assets]:
    assert f"{asset['sha256']}  {asset['name']}" in checksums, f"missing checksum line: {asset['name']}"

print(json.dumps({
    "firstStableBootstrap": BOOTSTRAP,
    "historicalDirectAssetsVerified": len(assets),
    "historicalSourceVersions": sorted(sources),
    "sameVersionFullRepairMarkerVerified": True,
    "fullZipBlockmapAndRescueDigestsVerified": True,
    "unpublishedIntermediateReleaseRequired": False,
    "ownerDataIncludedInUpdateAssets": False,
}))
