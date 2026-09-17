from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".test-cache"
CACHE.mkdir(exist_ok=True)
POLICY = json.loads((ROOT / "setup/legacy-release-policy.json").read_text(encoding="utf-8"))
POWERSHELL = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
SOURCE_NODE = ROOT / "runtime/node/node.exe"
CURRENT_UPDATER = ROOT / "setup/portable-updater.ps1"
CURRENT_MANAGER = ROOT / "setup/portable-manager.cjs"
NOOP_EXE = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/where.exe"
REPOSITORY = "E3N-glotm/DevSpace-Deploy-Portable"
TARGET_VERSION = POLICY["bootstrapVersion"]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def install_node(target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(SOURCE_NODE, target)
    except OSError:
        shutil.copy2(SOURCE_NODE, target)


def stub_manager() -> str:
    return r'''"use strict";
const command = process.argv[2] || "";
if (command === "stop") {
  process.stdout.write("fixture Portable stopped\n");
  process.exit(0);
}
if (command === "install-tasks" || command === "start") {
  process.stdout.write("fixture " + command + "\n");
  process.exit(0);
}
process.stderr.write("unexpected fixture manager command: " + command + "\n");
process.exit(9);
'''


def build_target_zip(work: Path) -> Path:
    target = work / f"DevSpacePortable-Windows-x64-{TARGET_VERSION}.zip"
    manifest = {
        "formatVersion": 2,
        "release": f"DevSpacePortable-Windows-x64-{TARGET_VERSION}",
        "runtime": {"devspacePortable": TARGET_VERSION},
    }
    entries = {
        "DevSpace-Portable.exe": NOOP_EXE.read_bytes(),
        "VERSION-MANIFEST.json": (json.dumps(manifest, indent=2) + "\n").encode(),
        "setup/portable-updater.ps1": CURRENT_UPDATER.read_bytes(),
        "setup/portable-manager.cjs": CURRENT_MANAGER.read_bytes(),
    }
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
        for relative, data in entries.items():
            archive.writestr("DevSpacePortable/" + relative, data)
    return target


def historical_updater(version: str) -> bytes:
    result = subprocess.run(
        ["git", "show", f"v{version}:setup/portable-updater.ps1"],
        cwd=ROOT,
        capture_output=True,
        check=True,
    )
    return result.stdout


def build_bridge(version: str, target_zip: Path, work: Path) -> Path:
    output = work / f"DevSpacePortable-Update-{version}-to-{TARGET_VERSION}.zip"
    subprocess.run(
        [
            "python", str(ROOT / "setup/create-legacy-upgrade-bridge.py"),
            "--from-version", version,
            "--target-zip", str(target_zip),
            "--output", str(output),
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return output


def create_install_root(work: Path, version: str) -> tuple[Path, dict[str, str]]:
    root = work / f"installed-{version}"
    (root / "setup").mkdir(parents=True)
    (root / "data/state").mkdir(parents=True)
    (root / "logs").mkdir(parents=True)
    (root / "reports").mkdir(parents=True)
    install_node(root / "runtime/node/node.exe")
    shutil.copy2(NOOP_EXE, root / "DevSpace-Portable.exe")
    write_json(root / "VERSION-MANIFEST.json", {"runtime": {"devspacePortable": version}})
    (root / "setup/portable-manager.cjs").write_text(stub_manager(), encoding="utf-8")
    sentinels = {
        "data/state/owner-sentinel.txt": f"owner-data-{version}",
        "logs/owner-sentinel.log": f"owner-log-{version}",
        "reports/owner-sentinel.txt": f"owner-report-{version}",
    }
    for relative, value in sentinels.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value, encoding="utf-8")
    return root, sentinels


def stage_bridge(root: Path, bridge: Path, updater_bytes: bytes) -> Path:
    stage = root / ".update-staging" / f"{TARGET_VERSION}-legacy-bridge"
    extracted = stage / "extracted"
    extracted.mkdir(parents=True)
    with zipfile.ZipFile(bridge) as archive:
        archive.extractall(extracted)
    delta_root = extracted / "DevSpacePortableDelta"
    payload = delta_root / "files"
    delta_manifest = delta_root / "delta-manifest.json"
    (stage / "portable-updater.ps1").write_bytes(updater_bytes)
    write_json(stage / "stage-info.json", {
        "targetVersion": TARGET_VERSION,
        "updateMode": "incremental",
        "payloadRoot": str(payload.resolve()),
        "deltaManifestPath": str(delta_manifest.resolve()),
    })
    return stage


def run_apply(updater: Path, root: Path, current_version: str, stage: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            str(POWERSHELL), "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-File", str(updater),
            "-Action", "Apply",
            "-Root", str(root),
            "-Repository", REPOSITORY,
            "-CurrentVersion", current_version,
            "-StagingPath", str(stage),
            "-UiPid", "0",
        ],
        cwd=root,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
    )


def assert_sentinels(root: Path, sentinels: dict[str, str]) -> None:
    for relative, expected in sentinels.items():
        actual = (root / relative).read_text(encoding="utf-8")
        assert actual == expected, f"persistent sentinel changed: {relative}"


def apply_legacy_bridge(work: Path, version: str, bridge: Path) -> tuple[Path, dict[str, str]]:
    root, sentinels = create_install_root(work, version)
    stage = stage_bridge(root, bridge, historical_updater(version))
    result = run_apply(stage / "portable-updater.ps1", root, version, stage)
    assert result.returncode == 0, f"historical Apply failed for {version}:\n{result.stdout}\n{result.stderr}"
    assert read_json(root / "VERSION-MANIFEST.json")["runtime"]["devspacePortable"] == TARGET_VERSION
    marker = read_json(root / "setup/legacy-upgrade-bootstrap.json")
    assert marker["kind"] == "legacy-upgrade-bootstrap"
    assert marker["fromVersion"] == version and marker["targetVersion"] == TARGET_VERSION
    assert marker["repairMode"] == "same-version-force-full"
    assert sha256(root / "setup/portable-updater.ps1") == sha256(CURRENT_UPDATER)
    assert sha256(root / "setup/portable-manager.cjs") == sha256(CURRENT_MANAGER)
    assert_sentinels(root, sentinels)
    return root, sentinels


def apply_same_version_full_repair(root: Path, sentinels: dict[str, str]) -> None:
    # Keep the test hermetic: the updater transaction is real, while its manager
    # stop hook is a fixture stub so no machine-level DevSpace task/service is
    # touched by this compatibility test.
    (root / "setup/portable-manager.cjs").write_text(stub_manager(), encoding="utf-8")
    stage = root / ".update-staging" / f"{TARGET_VERSION}-force-full"
    payload = stage / "payload"
    (payload / "setup").mkdir(parents=True)
    (payload / "app").mkdir(parents=True)
    shutil.copy2(NOOP_EXE, payload / "DevSpace-Portable.exe")
    write_json(payload / "VERSION-MANIFEST.json", {
        "formatVersion": 2,
        "release": f"DevSpacePortable-Windows-x64-{TARGET_VERSION}",
        "runtime": {"devspacePortable": TARGET_VERSION},
    })
    shutil.copy2(CURRENT_UPDATER, payload / "setup/portable-updater.ps1")
    shutil.copy2(CURRENT_MANAGER, payload / "setup/portable-manager.cjs")
    (payload / "setup/full-repair-complete.txt").write_text("full\n", encoding="utf-8")
    (payload / "app/full-repair-complete.txt").write_text("full\n", encoding="utf-8")
    shutil.copy2(CURRENT_UPDATER, stage / "portable-updater.ps1")
    write_json(stage / "stage-info.json", {
        "targetVersion": TARGET_VERSION,
        "updateMode": "full",
        "payloadRoot": str(payload.resolve()),
    })
    result = run_apply(stage / "portable-updater.ps1", root, TARGET_VERSION, stage)
    assert result.returncode == 0, f"same-version full repair failed:\n{result.stdout}\n{result.stderr}"
    assert read_json(root / "VERSION-MANIFEST.json")["runtime"]["devspacePortable"] == TARGET_VERSION
    assert not (root / "setup/legacy-upgrade-bootstrap.json").exists(), "legacy marker survived full repair"
    assert (root / "setup/full-repair-complete.txt").read_text(encoding="utf-8") == "full\n"
    assert (root / "app/full-repair-complete.txt").read_text(encoding="utf-8") == "full\n"
    assert_sentinels(root, sentinels)


with tempfile.TemporaryDirectory(prefix="legacy-bootstrap-apply-", dir=CACHE) as raw:
    work = Path(raw)
    target_zip = build_target_zip(work)
    passed: list[str] = []
    final_root: Path | None = None
    final_sentinels: dict[str, str] | None = None
    for version in POLICY["legacyFromVersions"]:
        bridge = build_bridge(version, target_zip, work)
        root, sentinels = apply_legacy_bridge(work, version, bridge)
        passed.append(version)
        if version == POLICY["legacyFromVersions"][-1]:
            final_root, final_sentinels = root, sentinels
        else:
            shutil.rmtree(root, ignore_errors=True)
    assert final_root is not None and final_sentinels is not None
    apply_same_version_full_repair(final_root, final_sentinels)
    print(json.dumps({
        "historicalApplyVersions": passed,
        "historicalApplyCount": len(passed),
        "sameVersionForceFullRepair": True,
        "persistentRootsPreserved": ["data", "logs", "reports"],
        "machineServicesTouched": False,
    }))
