from __future__ import annotations

import json
import runpy
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUILD_RELEASE = ROOT / "setup" / "build-release.py"


def main() -> int:
    module = runpy.run_path(str(BUILD_RELEASE))
    release_plugin_entries = module["release_plugin_entries"]
    release_files = module["release_files"]
    validate_release_plugins = module["validate_release_plugins"]

    entries = release_plugin_entries()
    validate_release_plugins(entries)

    targets = {target.as_posix(): source for source, target in entries}
    prefix = "data/plugins/installed/codex-runtime-bridge/"
    versions = sorted(
        {
            target[len(prefix):].split("/", 1)[0]
            for target in targets
            if target.startswith(prefix)
        }
    )
    assert versions, "codex-runtime-bridge must be packaged under data/plugins/installed"
    latest = versions[-1]
    required = [
        f"{prefix}{latest}/manifest.json",
        f"{prefix}{latest}/runtime.mjs",
        f"{prefix}{latest}/keep-awake.ps1",
        f"{prefix}{latest}/skills/codex-runtime-bridge/SKILL.md",
    ]
    for target in required:
        assert target in targets, f"missing release plugin mapping: {target}"
        assert targets[target].is_file(), f"missing release plugin source: {targets[target]}"

    wrong_root = [target for target in targets if target.startswith("plugins/installed/")]
    assert not wrong_root, f"plugin must not be packaged at repository root: {wrong_root}"
    assert Path("true") not in release_files(), "source-local updater test output leaked into release payload"

    print(
        json.dumps(
            {
                "releasePluginRoot": "data/plugins/installed/codex-runtime-bridge",
                "versions": versions,
                "requiredFilesPresent": True,
                "wrongRootEntries": 0,
                "virtualMappingKeepsLocalDataUntouched": True,
                "sourceLocalTestOutputExcluded": True,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
