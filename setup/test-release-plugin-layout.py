from __future__ import annotations

import json
import runpy
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUILD_RELEASE = ROOT / "setup" / "build-release.py"


def main() -> int:
    module = runpy.run_path(str(BUILD_RELEASE))
    prepare_release_plugins = module["prepare_release_plugins"]
    release_files = module["release_files"]
    validate_release_plugins = module["validate_release_plugins"]

    mirrored = prepare_release_plugins()
    files = release_files()
    validate_release_plugins(files, mirrored)

    codex_root = ROOT / "plugins" / "installed" / "codex-runtime-bridge"
    versions = sorted(path.name for path in codex_root.iterdir() if path.is_dir())
    assert versions, "codex-runtime-bridge must be mirrored into plugins/installed"
    latest = codex_root / versions[-1]
    required = [
        latest / "manifest.json",
        latest / "runtime.mjs",
        latest / "keep-awake.ps1",
        latest / "skills" / "codex-runtime-bridge" / "SKILL.md",
    ]
    for path in required:
        assert path.is_file(), f"missing release plugin file: {path.relative_to(ROOT)}"

    release_paths = {path.as_posix() for path in files}
    for path in required:
        assert path.relative_to(ROOT).as_posix() in release_paths

    print(
        json.dumps(
            {
                "releasePluginRoot": "plugins/installed/codex-runtime-bridge",
                "versions": versions,
                "requiredFilesPresent": True,
                "includedByReleaseScanner": True,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
