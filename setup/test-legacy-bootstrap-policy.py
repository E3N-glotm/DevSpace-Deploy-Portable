from __future__ import annotations

import importlib.util
import json
import subprocess
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
POLICY = json.loads((ROOT / "setup/legacy-release-policy.json").read_text())


def load(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "setup" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bridge = load("create-legacy-upgrade-bridge")
manifest_builder = load("create-update-manifest")
cache = ROOT / ".test-cache"
cache.mkdir(exist_ok=True)
repository = "E3N-glotm/DevSpace-Deploy-Portable"


def expect_rejected(action, message):
    try:
        action()
    except (ValueError, SystemExit) as error:
        assert message in str(error), str(error)
    else:
        raise AssertionError("invalid release operation was accepted")


with tempfile.TemporaryDirectory(prefix="bootstrap-policy-", dir=cache) as directory:
    work = Path(directory)

    def target(version: str, development=False):
        output = work / f"DevSpacePortable-Windows-x64-{version}.zip"
        metadata = {"runtime": {"devspacePortable": version}}
        if development:
            metadata["development"] = {"channel": "dev", "iteration": 67}
        with zipfile.ZipFile(output, "w") as archive:
            for relative in bridge.BRIDGE_TARGET_FILES:
                # Packaging fixture only: no full installation/deployment claim.
                content = (json.dumps(metadata).encode() if relative == "VERSION-MANIFEST.json"
                           else (ROOT / relative).read_bytes())
                archive.writestr(bridge.PORTABLE_PREFIX + relative, content)
        return output

    def asset(path: Path):
        with zipfile.ZipFile(path) as archive:
            delta = json.loads(archive.read(bridge.DELTA_PREFIX + "delta-manifest.json"))
            assert delta["legacyBootstrap"] is True
            assert len(delta["changedFiles"]) == 5
            assert delta["deletedFiles"] == []
            for entry in delta["changedFiles"]:
                data = archive.read(bridge.DELTA_PREFIX + "files/" + entry["path"])
                assert bridge.sha256_bytes(data) == entry["sha256"]
                assert len(data) == entry["size"]
        return {
            "format": "file-delta-v1", "fromVersion": delta["fromVersion"],
            "toVersion": delta["toVersion"], "name": path.name,
            "size": path.stat().st_size, "sha256": bridge.sha256_file(path),
            "downloadUrl": f"https://github.com/{repository}/releases/download/v{delta['toVersion']}/{path.name}",
        }

    bootstrap_version = POLICY["bootstrapVersion"]
    future_version = "1.1.62" if bootstrap_version == "1.1.61" else "1.1.61"
    baseline = target(bootstrap_version)
    baseline_assets = [asset(bridge.create_bridge(source, baseline)) for source in POLICY["legacyFromVersions"]]
    assert len(baseline_assets) == 20
    future = target(future_version)
    future_assets = [asset(bridge.create_bridge(source, future))
                     for source in [bootstrap_version, *POLICY["legacyDirectOnlyVersions"]]]
    assert len(future_assets) == 5
    graph = manifest_builder.merge_incremental_graph(repository, future_assets, {
        "repository": repository, "incrementalGraphAssets": baseline_assets,
    })
    assert len(graph) == 25
    assert all(f"/v{bootstrap_version}/" in edge["downloadUrl"] for edge in graph if edge["toVersion"] == bootstrap_version)
    expect_rejected(lambda: bridge.create_bridge("1.1.49", future), "bootstrap policy")
    expect_rejected(lambda: bridge.create_bridge("1.1.49", target("1.1.59", True)), "bootstrap policy")
    expect_rejected(lambda: bridge.create_bridge("1.1.49", target(bootstrap_version, True)), "stable Portable metadata")
    expect_rejected(lambda: bridge.create_bridge(future_version, future), "forward")

    fixture = {
        "baseline": {"version": bootstrap_version, "manifest": {"incrementalAssets": baseline_assets},
                     "release": {"assets": baseline_assets}},
        "future": {"version": future_version, "manifest": {"incrementalAssets": future_assets},
                   "release": {"assets": future_assets}},
        "legacyVersions": POLICY["legacyFromVersions"],
        "directOnlyVersions": POLICY["legacyDirectOnlyVersions"],
        "edges": [{"manifest": edge, "asset": edge} for edge in graph],
    }
    (work / "fixtures.json").write_text(json.dumps(fixture), encoding="utf-8")
    for version in POLICY["legacyFromVersions"]:
        tag = f"v{version}"
        result = subprocess.run(["git", "show", f"{tag}:setup/portable-updater.ps1"], cwd=ROOT,
                                capture_output=True, check=True)
        (work / f"{tag}.ps1").write_bytes(result.stdout)
    subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                    str(ROOT / "setup/test-legacy-bootstrap-host.ps1"), "-FixtureRoot", str(work)],
                   cwd=ROOT, check=True)

for argv, text in [
    (["python", "setup/finalize-release.py", "1.1.59"], "development-only"),
    (["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/publish-github-release.ps1", "-Version", "1.1.59"], "development-only"),
]:
    result = subprocess.run(argv, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
    assert result.returncode != 0 and text in result.stdout + result.stderr, result.stdout + result.stderr

print(json.dumps({"baselineBridges": len(POLICY["legacyFromVersions"]), "historicalUpdatersExercised": len(POLICY["legacyFromVersions"]), "futureBridgesFixedCount": 5,
                  "devPublicationRejected": True, "historicalUrlsPreserved": True,
                  "verificationScope": "packaging and historical planning; not a full installation"}))
