from __future__ import annotations

import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "setup" / "create-update-manifest.py"
spec = importlib.util.spec_from_file_location("devspace_update_manifest", MODULE_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError(f"Unable to load {MODULE_PATH}")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

repository = "E3N-glotm/DevSpace-Deploy-Portable"


def edge(from_version: str, to_version: str, marker: str, *, url: str | None = None) -> dict[str, object]:
    name = f"DevSpacePortable-Update-{from_version}-to-{to_version}.zip"
    return {
        "format": "file-delta-v1",
        "fromVersion": from_version,
        "toVersion": to_version,
        "name": name,
        "size": 100 + len(marker),
        "sha256": (marker * 64)[:64],
        "downloadUrl": url
        or f"https://github.com/{repository}/releases/download/v{to_version}/{name}",
    }


previous = {
    "repository": repository,
    "incrementalGraphAssets": [
        edge("1.1.39", "1.1.40", "a"),
        edge("1.1.40", "1.1.41", "b"),
        edge("1.1.41", "1.1.42", "c", url="https://example.invalid/poison.zip"),
    ],
    "incrementalAssets": [edge("1.1.38", "1.1.39", "d")],
}
current = [
    edge("1.1.41", "1.1.42", "e"),
    edge("1.1.40", "1.1.41", "f"),
]

merged = module.merge_incremental_graph(repository, current, previous)
keys = [(item["fromVersion"], item["toVersion"]) for item in merged]
assert keys == [
    ("1.1.38", "1.1.39"),
    ("1.1.39", "1.1.40"),
    ("1.1.40", "1.1.41"),
    ("1.1.41", "1.1.42"),
]
assert next(item for item in merged if item["toVersion"] == "1.1.42")["sha256"] == "e" * 64
assert next(item for item in merged if item["toVersion"] == "1.1.41")["sha256"] == "f" * 64
assert all(str(item["downloadUrl"]).startswith(f"https://github.com/{repository}/releases/download/v") for item in merged)

try:
    module.merge_incremental_graph("other/repository", [], previous)
except SystemExit as error:
    assert "repository" in str(error).lower()
else:
    raise AssertionError("repository mismatch must fail closed")

print(
    {
        "carryForwardGraph": True,
        "untrustedEdgeFiltered": True,
        "currentEdgeWins": True,
        "repositoryMismatchFailsClosed": True,
        "edgeCount": len(merged),
    }
)
