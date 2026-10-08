"""Repair shallow legacy bridges without changing an already published full ZIP.

Use the exact bridge ZIPs downloaded from the existing GitHub Release as the
source of truth. Their manifest, updater and bootstrap marker were extracted
from the *published* full package; only the bootstrap launcher and manager may
be replaced. The output manifest preserves the immutable full ZIP/blockmap
identities and historical update graph while updating the five affected edges.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


DELTA_PREFIX = "DevSpacePortableDelta/"
REPAIR_FILES = {"DevSpace-Portable.exe", "setup/portable-manager.cjs"}
BRIDGE_FILES = {
    "DevSpace-Portable.exe", "VERSION-MANIFEST.json",
    "setup/legacy-upgrade-bootstrap.json", "setup/portable-manager.cjs",
    "setup/portable-updater.ps1",
}
SOURCE_VERSIONS = ("1.1.36", "1.1.37", "1.1.38", "1.1.39", "1.1.61")
VERSION = "1.1.63"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for part in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(part)
    return digest.hexdigest()


def bridge_name(source: str) -> str:
    return f"DevSpacePortable-Update-{source}-to-{VERSION}.zip"


def verified_contents(path: Path, entry: dict) -> tuple[dict, dict[str, bytes]]:
    assert path.is_file() and path.stat().st_size == entry["size"], path
    assert sha256_file(path) == entry["sha256"], f"Original release asset digest mismatch: {path}"
    with ZipFile(path) as archive:
        assert archive.testzip() is None, f"Damaged original bridge: {path}"
        manifest = json.loads(archive.read(DELTA_PREFIX + "delta-manifest.json"))
        assert manifest["format"] == "file-delta-v1"
        assert manifest["fromVersion"] == entry["fromVersion"]
        assert manifest["toVersion"] == VERSION and manifest["legacyBootstrap"] is True
        assert manifest["repairMode"] == "same-version-force-full"
        assert manifest["deletedFiles"] == []
        assert {row["path"] for row in manifest["changedFiles"]} == BRIDGE_FILES
        assert {x.filename for x in archive.infolist()} == {
            DELTA_PREFIX, DELTA_PREFIX + "files/", DELTA_PREFIX + "delta-manifest.json",
            *(DELTA_PREFIX + "files/" + f for f in BRIDGE_FILES),
        }
        values = {name: archive.read(DELTA_PREFIX + "files/" + name) for name in BRIDGE_FILES}
    for item in manifest["changedFiles"]:
        value = values[item["path"]]
        assert len(value) == item["size"] and sha256(value) == item["sha256"]
    version_manifest = json.loads(values["VERSION-MANIFEST.json"])
    assert version_manifest["runtime"]["devspacePortable"] == VERSION
    assert not version_manifest.get("development")
    marker = json.loads(values["setup/legacy-upgrade-bootstrap.json"])
    assert marker["fromVersion"] == entry["fromVersion"]
    assert marker["targetVersion"] == VERSION
    return manifest, values


def rebuild(base_dir: Path, out_dir: Path, launcher: Path, manager: Path) -> dict:
    base_manifest = json.loads((base_dir / "update-manifest.json").read_text(encoding="utf-8"))
    assert base_manifest["version"] == VERSION and base_manifest["tag"] == "v" + VERSION
    assert base_manifest["channel"] == "stable"
    assert len(base_manifest["incrementalAssets"]) == len(SOURCE_VERSIONS)
    assert {row["fromVersion"] for row in base_manifest["incrementalAssets"]} == set(SOURCE_VERSIONS)

    expected_immutable = {
        x["name"]: x["sha256"] for x in
        [base_manifest["asset"], base_manifest["blockmapAsset"], *base_manifest.get("rescueAssets", [])]
    }
    replacement = {
        "DevSpace-Portable.exe": launcher.read_bytes(),
        "setup/portable-manager.cjs": manager.read_bytes(),
    }
    assert len(replacement["DevSpace-Portable.exe"]) >= 6000
    assert b"Get-WmiObject Win32_Process" in replacement["setup/portable-manager.cjs"]

    # Every bridge must inherit the same *published* updater and version
    # manifest, not a similarly named local development ZIP.
    shared_immutable: dict[str, str] = {}
    new_entries = []
    out_dir.mkdir(parents=True, exist_ok=True)
    for item in base_manifest["incrementalAssets"]:
        name = bridge_name(item["fromVersion"])
        assert item["name"] == name
        delta, original = verified_contents(base_dir / name, item)
        for relative in ("VERSION-MANIFEST.json", "setup/portable-updater.ps1"):
            value = sha256(original[relative])
            assert relative not in shared_immutable or shared_immutable[relative] == value
            shared_immutable[relative] = value
        original.update(replacement)
        delta["createdAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        delta["changedFiles"] = [
            {"path": key, "size": len(original[key]), "sha256": sha256(original[key])}
            for key in sorted(BRIDGE_FILES)
        ]
        dest = out_dir / name
        with ZipFile(dest, "w", compression=ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
            archive.writestr(DELTA_PREFIX, b"")
            archive.writestr(DELTA_PREFIX + "files/", b"")
            archive.writestr(DELTA_PREFIX + "delta-manifest.json", json.dumps(
                delta, ensure_ascii=False, indent=2).encode("utf-8") + b"\n")
            for key in sorted(BRIDGE_FILES):
                archive.writestr(DELTA_PREFIX + "files/" + key, original[key])
        new_item = dict(item)
        new_item["size"] = dest.stat().st_size
        new_item["sha256"] = sha256_file(dest)
        new_entries.append(new_item)

    # Change only five v1.1.63 graph edges; all historic 1.1.61 and earlier
    # graph links remain byte-for-byte equivalent in JSON data.
    mapping = {(x["fromVersion"], x["toVersion"]): x for x in new_entries}
    new_manifest = dict(base_manifest)
    new_manifest["incrementalAssets"] = new_entries
    patched = 0
    graph = []
    for edge in base_manifest["incrementalGraphAssets"]:
        replacement_edge = mapping.get((edge["fromVersion"], edge["toVersion"]))
        if replacement_edge:
            assert edge["name"] == replacement_edge["name"]
            graph.append(replacement_edge)
            patched += 1
        else:
            graph.append(edge)
    assert patched == len(SOURCE_VERSIONS), f"Unexpected graph matches: {patched}"
    new_manifest["incrementalGraphAssets"] = graph
    assert {x["name"]: x["sha256"] for x in
            [new_manifest["asset"], new_manifest["blockmapAsset"], *new_manifest.get("rescueAssets", [])]} == expected_immutable
    (out_dir / "update-manifest.json").write_text(json.dumps(
        new_manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    # Keep all original hash lines that are not part of the five bridges.
    sums = (base_dir / "SHA256SUMS-release.txt").read_text(encoding="utf-8").splitlines()
    new_by_name = {x["name"]: x["sha256"] for x in new_entries}
    replaced = set()
    result = []
    for line in sums:
        digest, name = line.split(maxsplit=1)
        if name in new_by_name:
            result.append(f"{new_by_name[name]}  {name}")
            replaced.add(name)
        else:
            assert name not in expected_immutable or expected_immutable[name] == digest
            result.append(line)
    assert replaced == set(new_by_name)
    (out_dir / "SHA256SUMS-release.txt").write_text("\n".join(result) + "\n", encoding="utf-8")
    result = {
        "version": VERSION, "repairedBridges": new_entries,
        "unchangedFullZip": expected_immutable[base_manifest["asset"]["name"]],
        "unchangedBlockmap": expected_immutable[base_manifest["blockmapAsset"]["name"]],
        "outputManifestSha256": sha256_file(out_dir / "update-manifest.json"),
        "outputChecksumsSha256": sha256_file(out_dir / "SHA256SUMS-release.txt"),
    }
    (out_dir / "repair-summary.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--original-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--launcher", type=Path, required=True)
    parser.add_argument("--manager", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(rebuild(args.original_dir, args.output_dir, args.launcher, args.manager), indent=2))


if __name__ == "__main__":
    main()
