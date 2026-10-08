"""Validate a targeted repair of already published legacy bridge assets.

The input originals must be downloaded from the public release and checked
against its signed-by-GitHub asset digests before this test. No live Portable
service or working installation is started or changed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ("1.1.36", "1.1.37", "1.1.38", "1.1.39", "1.1.61")
PREFIX = "DevSpacePortableDelta/"
PATCHED = {"DevSpace-Portable.exe", "setup/portable-manager.cjs"}


def hash_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--original-dir", type=Path, required=True)
    parser.add_argument("--repaired-dir", type=Path, required=True)
    args = parser.parse_args()
    base = json.loads((args.original_dir / "update-manifest.json").read_text(encoding="utf-8"))
    updated = json.loads((args.repaired_dir / "update-manifest.json").read_text(encoding="utf-8"))
    assert base["asset"] == updated["asset"], "The full ZIP identity changed"
    assert base["blockmapAsset"] == updated["blockmapAsset"], "Blockmap identity changed"
    assert base.get("rescueAssets") == updated.get("rescueAssets"), "Rescue graph changed"
    first_graph = {(e["fromVersion"], e["toVersion"]): e for e in base["incrementalGraphAssets"]}
    final_graph = {(e["fromVersion"], e["toVersion"]): e for e in updated["incrementalGraphAssets"]}
    assert first_graph.keys() == final_graph.keys(), "Changed legacy update route graph"
    repaired_count = 0
    for edge in first_graph:
        if edge[1] != "1.1.63":
            assert first_graph[edge] == final_graph[edge], f"Historic edge modified: {edge}"
        else:
            repaired_count += 1
            assert edge[0] in SOURCES
    assert repaired_count == 5
    sums = {}
    for row in (args.repaired_dir / "SHA256SUMS-release.txt").read_text(encoding="utf-8").splitlines():
        digest, name = row.split(maxsplit=1)
        assert name not in sums
        sums[name] = digest
    assert sums[updated["asset"]["name"]] == updated["asset"]["sha256"]
    assert sums[updated["blockmapAsset"]["name"]] == updated["blockmapAsset"]["sha256"]

    common_unchanged = None
    launcher_hash = None
    manager_hash = None
    for source in SOURCES:
        filename = f"DevSpacePortable-Update-{source}-to-1.1.63.zip"
        before_file = args.original_dir / filename
        after_file = args.repaired_dir / filename
        expected = next(e for e in updated["incrementalAssets"] if e["fromVersion"] == source)
        assert after_file.stat().st_size == expected["size"]
        digest = hash_bytes(after_file.read_bytes())
        assert digest == expected["sha256"] == sums[filename]
        assert final_graph[(source, "1.1.63")] == expected
        with ZipFile(before_file) as old, ZipFile(after_file) as new:
            assert old.testzip() is None and new.testzip() is None
            old_delta = json.loads(old.read(PREFIX + "delta-manifest.json"))
            new_delta = json.loads(new.read(PREFIX + "delta-manifest.json"))
            assert new_delta["fromVersion"] == source and new_delta["toVersion"] == "1.1.63"
            assert new_delta["repairMode"] == "same-version-force-full"
            assert old_delta["legacyBootstrap"] and new_delta["legacyBootstrap"]
            assert len(new_delta["changedFiles"]) == 5
            for item in new_delta["changedFiles"]:
                name = item["path"]
                b = new.read(PREFIX + "files/" + name)
                assert item["size"] == len(b) and item["sha256"] == hash_bytes(b)
                if name not in PATCHED:
                    assert b == old.read(PREFIX + "files/" + name), f"Immutable bridge entry changed: {name}"
            immutable = tuple(hash_bytes(new.read(PREFIX + "files/" + name)) for name in
                              ("VERSION-MANIFEST.json", "setup/portable-updater.ps1"))
            assert common_unchanged is None or common_unchanged == immutable
            common_unchanged = immutable
            current_launcher = hash_bytes(new.read(PREFIX + "files/DevSpace-Portable.exe"))
            current_manager = hash_bytes(new.read(PREFIX + "files/setup/portable-manager.cjs"))
            assert launcher_hash is None or launcher_hash == current_launcher
            assert manager_hash is None or manager_hash == current_manager
            launcher_hash, manager_hash = current_launcher, current_manager

    assert launcher_hash == hash_bytes((ROOT / "DevSpace-Portable.exe").read_bytes())
    assert manager_hash == hash_bytes((ROOT / "setup/portable-manager.cjs").read_bytes())

    # Run the actual launcher extracted from a repaired bridge, with Electron
    # intentionally absent. Stub *only* the update manager's stage/launch IPC,
    # and keep every test artifact under the original E-drive checkout.
    with tempfile.TemporaryDirectory(dir=ROOT / "reports", prefix=".test-published-bridge-") as d:
        install = Path(d)
        with ZipFile(args.repaired_dir / f"DevSpacePortable-Update-{SOURCES[0]}-to-1.1.63.zip") as archive:
            for item in archive.infolist():
                if item.filename.startswith(PREFIX + "files/") and not item.is_dir():
                    rel = item.filename[len(PREFIX + "files/"):]
                    dest = install / rel
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(archive.read(item))
        node = install / "runtime/node/node.exe"
        node.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / "runtime/node/node.exe", node)
        assert not (install / "ui-next/runtime/electron.exe").exists()
        trace = install / "update-events.jsonl"
        stub = install / "setup/portable-manager.cjs"
        stub.write_text("\n".join([
            'const fs=require("fs");',
            f'const trace={json.dumps(str(trace))};',
            'const action=process.argv[2];',
            'let req={};if(action==="update-launch")req=JSON.parse(fs.readFileSync(0,"utf8"));',
            'fs.appendFileSync(trace,JSON.stringify({action,req})+"\\n");',
            'if(action==="update-stage-force-full")console.log(JSON.stringify({stagingPath:"E:/mock/stage"}));',
            'else if(action==="update-launch")console.log(JSON.stringify({launched:true}));',
            'else process.exit(5);',
        ]), encoding="utf-8")
        process = subprocess.run([str(install / "DevSpace-Portable.exe")], cwd=install, capture_output=True,
                                 timeout=60, env=os.environ.copy())
        assert process.returncode == 0
        trace_rows = [json.loads(line) for line in trace.read_text(encoding="utf-8").splitlines()]
        assert [r["action"] for r in trace_rows] == ["update-stage-force-full", "update-launch"]
        assert trace_rows[1]["req"]["uiPid"] > 0
    print(json.dumps({"repaired":len(SOURCES), "historicGraphPreserved":True,
                      "fullZipUnchanged":True, "blockmapUnchanged":True,
                      "repairedLauncherExecutesWithoutElectron":True,
                      "unchangedPublishedUpdaterSha":common_unchanged[1]}))


if __name__ == "__main__":
    main()
