from __future__ import annotations

import argparse
import base64
import hashlib
import json
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CORE_PACKAGE_JSON = ROOT / "vendor" / "waishnav-devspace" / "package.json"
CORE_VERSION = json.loads(CORE_PACKAGE_JSON.read_text(encoding="utf-8"))["version"]
PACKAGE_TGZ = ROOT / "packages" / f"waishnav-devspace-{CORE_VERSION}.tgz"
LOCK_FILE = ROOT / "app" / "package-lock.json"
MANIFEST_FILE = ROOT / "VERSION-MANIFEST.json"
ROOT_PACKAGE_JSON = ROOT / "package.json"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def sha512_integrity(path: Path) -> str:
    digest = hashlib.sha512(path.read_bytes()).digest()
    return "sha512-" + base64.b64encode(digest).decode("ascii")


def update_lock() -> None:
    lock = json.loads(LOCK_FILE.read_text(encoding="utf-8"))
    package = lock["packages"]["node_modules/@waishnav/devspace"]
    package["integrity"] = sha512_integrity(PACKAGE_TGZ)
    LOCK_FILE.write_text(
        json.dumps(lock, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def normalize_dev_iteration(dev_iteration: str | None) -> tuple[int | None, str | None]:
    if not dev_iteration:
        return None, None
    value = str(dev_iteration).strip().lower()
    if value.startswith("dev"):
        value = value[3:]
    if not value.isdigit() or int(value) <= 0:
        raise SystemExit("--dev/--dev-iteration must be a positive integer or devN, for example --dev 12")
    iteration = int(value)
    return iteration, f"dev{iteration}"


def validate_release_version(version: str, dev_iteration: str | None = None) -> None:
    package_version = json.loads(ROOT_PACKAGE_JSON.read_text(encoding="utf-8"))["version"]
    if package_version != version:
        raise SystemExit(
            f"Portable version identity mismatch: package.json is {package_version}, requested release is {version}"
        )

    _, dev_label = normalize_dev_iteration(dev_iteration)
    display_version = f"{version} {dev_label}" if dev_label else version
    expected_fragments = {
        ROOT / "scripts" / "start-devspace.sh": f'export DEVSPACE_PORTABLE_VERSION="{version}"',
        ROOT / "vendor" / "waishnav-devspace" / "dist" / "capabilities.js": f'DEVSPACE_SERVER_VERSION = "{version}"',
        ROOT / "vendor" / "waishnav-devspace" / "dist" / "ui" / "assets" / "runtime-enhancements.js": f"DevSpace Portable {display_version} · Protocol 1.5",
        ROOT / "setup" / "native" / "DevSpacePortableApp.cs": f"DevSpace Portable {display_version} · Protocol 1.5",
    }
    mismatches: list[str] = []
    portable_manager_source = (ROOT / "setup" / "portable-manager.cjs").read_text(encoding="utf-8")
    if f'const PORTABLE_VERSION = "{version}";' not in portable_manager_source:
        mismatches.append(f"setup/portable-manager.cjs: missing stable PORTABLE_VERSION {version!r}")
    if dev_label and f'const PORTABLE_DEV_ITERATION = "{dev_label}";' not in portable_manager_source:
        mismatches.append(f"setup/portable-manager.cjs: missing development iteration {dev_label!r}")
    for path, expected in expected_fragments.items():
        if expected not in path.read_text(encoding="utf-8"):
            mismatches.append(f"{path.relative_to(ROOT).as_posix()}: missing {expected!r}")
    if mismatches:
        raise SystemExit("Portable version identity mismatch:\n" + "\n".join(mismatches))


def update_manifest(version: str, hotfix: str | None, dev_iteration: str | None) -> None:
    manifest = json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))
    manifest["release"] = f"DevSpacePortable-Windows-x64-{version}"
    manifest["builtAt"] = datetime.now().astimezone().isoformat(timespec="seconds")
    manifest.setdefault("runtime", {})["devspacePortable"] = version
    manifest["runtime"]["devspace"] = CORE_VERSION
    # Development iterations inside the same semantic version must not be
    # represented as fake releases. Keep the stable updater identity as
    # 1.1.x, while exposing an optional dev suffix for internal builds.
    iteration, dev_label = normalize_dev_iteration(dev_iteration)
    if dev_label:
        manifest["displayVersion"] = f"{version} {dev_label}"
        manifest["development"] = {
            "channel": "dev",
            "iteration": iteration,
            "label": dev_label,
        }
    else:
        manifest["displayVersion"] = version
        manifest.pop("development", None)

    key_files: dict[str, str] = manifest.setdefault("keyFiles", {})
    candidates = {
        (key.removesuffix(".sha256") if key.endswith(".sha256") else key).replace("\\", "/")
        for key in key_files
    }
    # Rebuild the mapping from normalized POSIX-style paths so a Windows
    # command-line --hotfix using backslashes cannot leave duplicate logical
    # keys such as docs/releases/x.md and docs\releases\x.md.
    key_files.clear()
    candidates.update(
        {
            f"packages/waishnav-devspace-{CORE_VERSION}.tgz",
            "app/package-lock.json",
            "app/package.json",
            "app/node_modules/@earendil-works/pi-coding-agent/package.json",
            "app/node_modules/@earendil-works/pi-coding-agent/npm-shrinkwrap.json",
            "app/node_modules/@earendil-works/pi-coding-agent/node_modules/undici/package.json",
            "setup/portable-manager.cjs",
            "setup/logged-launcher.cjs",
            "DevSpace-Portable.exe",
            "Update.exe",
            "DevSpace-SshAskPass.exe",
            "DevSpace-Portable.cmd",
            "setup/computer-use-broker.cjs",
            "setup/Portable-Setup.hta",
            "setup/legacy/Portable-Setup-1.1.8.hta",
            "setup/build-native-ui.cmd",
            "setup/build-native-ui.cjs",
            "setup/native/DevSpaceBrandIcon.cs",
            "setup/native/DevSpacePortableApp.cs",
            "setup/native/DevSpaceUpdaterApp.cs",
            "setup/native/DevSpaceSshAskPass.cs",
            "setup/tunnel-launcher.cjs",
            "setup/build-release.py",
            "setup/finalize-release.py",
            "setup/create-update-manifest.py",
            "setup/create-incremental-update.py",
            "setup/create-rescue-overlay.py",
            "setup/create-blockmap.py",
            "setup/blockmap-updater.cjs",
            "setup/portable-updater.ps1",
            "setup/test-runtime-cards.mjs",
            "setup/test-runtime-log-ui.mjs",
            "setup/test-plugin-manager.mjs",
            "setup/test-codex-runtime-bridge.mjs",
            "setup/test-session-capabilities.mjs",
            "setup/test-computer-use-broker.mjs",
            "setup/test-computer-use-live.mjs",
            "setup/test-computer-use-batch.mjs",
            "setup/test-portable-ui-heartbeat.mjs",
            "setup/test-native-ui-resilience.mjs",
            "setup/test-native-close-tray.mjs",
            "setup/test-upstream-workspace-reuse.mjs",
            "setup/test-remote-workspace-backend.mjs",
            "setup/test-linux-agent-contract.mjs",
            "setup/test-continuation-guard.mjs",
            "setup/test-remote-agent-ssh-rescue.mjs",
            "setup/test-portable-ui-workflows.mjs",
            "setup/test-oauth-client-compatibility.mjs",
            "setup/test-standalone-updater.mjs",
            "setup/test-selected-file-diff.mjs",
            "setup/test-online-updater-contract.mjs",
            "setup/test-blockmap-update.mjs",
            "setup/test-release-migration-contract.mjs",
            "setup/test-updater-apply-recovery.mjs",
            "setup/test-update-launch-ack.mjs",
            "setup/test-dashboard-live-status.mjs",
            "setup/test-dashboard-probe-concurrency.mjs",
            "setup/test-network-isolation-contract.mjs",
            "setup/test-core-memory-bounds.mjs",
            "setup/test-incremental-update.py",
            "setup/test-incremental-chain.py",
            "setup/test-update-manifest-graph.py",
            "setup/test-rescue-overlay.py",
            "setup/test-release-plugin-layout.py",
            "setup/test-strict-stop.mjs",
            "setup/test-tunnel-network-coexistence.mjs",
            "setup/build-computer-use-helper.cmd",
            "setup/native/computer-use-capture.cpp",
            "setup/native/computer-use-input.cpp",
            "setup/harden-nested-dependencies.mjs",
            "scripts/start-devspace.sh",
            "scripts/pack-devspace-core.mjs",
            "scripts/pack-devspace-core.py",
            "scripts/verify-source-tree.mjs",
            "scripts/bootstrap-dev.ps1",
            "scripts/test-source.ps1",
            "scripts/hydrate-runtime-from-release.ps1",
            "scripts/publish-github-release.ps1",
            "app/node_modules/@waishnav/devspace/dist/server.js",
            "app/node_modules/@waishnav/devspace/dist/cli.js",
            "app/node_modules/@waishnav/devspace/dist/remote-agent-manager.js",
            "app/node_modules/@waishnav/devspace/dist/remote-agent-store.js",
            "app/node_modules/@waishnav/devspace/dist/linux-agent/devspace-agent.py",
            "app/node_modules/@waishnav/devspace/dist/linux-agent/install.sh",
            "app/node_modules/@waishnav/devspace/dist/process-sessions.js",
            "app/node_modules/@waishnav/devspace/dist/process-registry.js",
            "app/node_modules/@waishnav/devspace/dist/doctor.js",
            "app/node_modules/@waishnav/devspace/dist/db/migrations.js",
            "app/node_modules/@waishnav/devspace/dist/db/schema.js",
            "app/node_modules/@waishnav/devspace/dist/workspace-store.js",
            "app/node_modules/@waishnav/devspace/dist/workspaces.js",
            "app/node_modules/@waishnav/devspace/dist/request-meta.js",
            "app/node_modules/@waishnav/devspace/dist/redaction.js",
            "app/node_modules/@waishnav/devspace/dist/runtime-state.js",
            "app/node_modules/@waishnav/devspace/dist/file-watch.js",
            "app/node_modules/@waishnav/devspace/dist/permission-rules.js",
            "setup/permission-rules.example.json",
            "app/node_modules/@waishnav/devspace/dist/plugin-manager.js",
            "app/node_modules/@waishnav/devspace/dist/plugin-tools.js",
            "app/node_modules/@waishnav/devspace/dist/capabilities.js",
            "app/node_modules/@waishnav/devspace/dist/oauth-store.js",
            "app/node_modules/@waishnav/devspace/dist/oauth-provider.js",
            "app/node_modules/@waishnav/devspace/dist/ui-session.js",
            "app/node_modules/@waishnav/devspace/dist/memory-store.js",
            "app/node_modules/@waishnav/devspace/dist/hook-manager.js",
            "app/node_modules/@waishnav/devspace/dist/feature-tools.js",
            "app/node_modules/@waishnav/devspace/dist/computer-use.js",
            "app/node_modules/@waishnav/devspace/dist/helpers/computer-use.ps1",
            "app/node_modules/@waishnav/devspace/dist/helpers/computer-use-capture.exe",
            "app/node_modules/@waishnav/devspace/dist/helpers/computer-use-input.exe",
            "app/node_modules/@waishnav/devspace/dist/review-checkpoints.js",
            "app/node_modules/@waishnav/devspace/dist/schema-bundle.js",
            "app/node_modules/@waishnav/devspace/dist/ui/workspace-app.html",
            "app/node_modules/@waishnav/devspace/dist/ui/assets/runtime-enhancements.js",
            "app/node_modules/@waishnav/devspace/dist/ui/assets/runtime-enhancements.css",
            "app/node_modules/@waishnav/devspace/dist/ui/assets/continuation-guard.js",
            "app/node_modules/@waishnav/devspace/dist/ui/assets/continuation-coordinator.js",
            "app/node_modules/@waishnav/devspace/dist/ui/assets/runtime-timeline.css",
            "app/node_modules/@waishnav/devspace/dist/ui/assets/session-review.css",
            "app/plugin-dispatcher.mjs",
            "app/plugin-admin.mjs",
            "app/DevSpace-Plugin.cmd",
            "setup/plugin-example/manifest.json",
            "setup/plugin-example/skills/devspace-plugin-example/SKILL.md",
            "setup/bundled-plugins/codex-runtime-bridge/1.1.1/manifest.json",
            "setup/bundled-plugins/codex-runtime-bridge/1.1.1/runtime.mjs",
            "setup/bundled-plugins/codex-runtime-bridge/1.1.1/keep-awake.ps1",
            "setup/bundled-plugins/codex-runtime-bridge/1.1.1/skills/codex-runtime-bridge/SKILL.md",
            "docs/CODEX-GAP-1.1.6.md",
        }
    )
    candidates.update(
        path.relative_to(ROOT).as_posix()
        for path in (ROOT / "docs" / "releases").glob("HOTFIX-*.md")
        if path.is_file()
    )
    if hotfix:
        candidates.add(hotfix.replace("\\", "/"))
    for relative in sorted(candidates):
        path = ROOT / relative
        key_files.pop(relative, None)
        key_files.pop(f"{relative}.sha256", None)
        if path.is_file():
            key_files[f"{relative}.sha256"] = sha256_file(path)

    MANIFEST_FILE.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("version")
    parser.add_argument(
        "--hotfix",
        help="Optional hotfix/release-notes path to include in VERSION-MANIFEST keyFiles; not a development iteration.",
    )
    parser.add_argument(
        "--dev",
        "--dev-iteration",
        dest="dev_iteration",
        help="Development iteration inside the same stable SemVer, for example 12 or dev12.",
    )
    args = parser.parse_args()
    validate_release_version(args.version, args.dev_iteration)
    if not PACKAGE_TGZ.is_file():
        raise SystemExit(f"Missing packed DevSpace package: {PACKAGE_TGZ}")
    update_lock()
    update_manifest(args.version, args.hotfix, args.dev_iteration)
    _, dev_label = normalize_dev_iteration(args.dev_iteration)
    display_version = f"{args.version} {dev_label}" if dev_label else args.version
    print(f"Finalized metadata for {display_version}")
    print(f"Package SHA-256: {sha256_file(PACKAGE_TGZ)}")
    print(f"Package integrity: {sha512_integrity(PACKAGE_TGZ)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
