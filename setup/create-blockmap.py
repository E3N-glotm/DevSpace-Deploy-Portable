from __future__ import annotations

import argparse
import hashlib
import json
import zipfile
from pathlib import Path


BLOCK_SIZE = 1024 * 1024


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def build_file_blocks(handle, size: int) -> list[dict[str, object]]:
    blocks = []
    offset = 0
    while offset < size:
        handle.seek(offset)
        chunk = handle.read(min(BLOCK_SIZE, size - offset))
        if not chunk:
            break
        blocks.append({
            "offset": offset,
            "size": len(chunk),
            "sha256": sha256(chunk),
        })
        offset += len(chunk)
    return blocks


def build_blockmap(root: Path) -> dict:
    files: dict[str, list[dict[str, object]]] = {}
    if root.is_file() and root.suffix.lower() == ".zip":
        with zipfile.ZipFile(root, "r") as archive:
            for entry in sorted(archive.infolist(), key=lambda item: item.filename):
                if entry.is_dir():
                    continue
                with archive.open(entry, "r") as handle:
                    data = handle.read()
                blocks = []
                for offset in range(0, len(data), BLOCK_SIZE):
                    chunk = data[offset:offset + BLOCK_SIZE]
                    blocks.append({
                        "offset": offset,
                        "size": len(chunk),
                        "sha256": sha256(chunk),
                    })
                files[entry.filename] = blocks
        return {
            "schemaVersion": 1,
            "source": "zip-entry-content",
            "blockSize": BLOCK_SIZE,
            "archiveSha256": sha256(root.read_bytes()),
            "files": files,
        }
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        blocks = []
        with path.open("rb") as handle:
            offset = 0
            while True:
                chunk = handle.read(BLOCK_SIZE)
                if not chunk:
                    break
                blocks.append({
                    "offset": offset,
                    "size": len(chunk),
                    "sha256": sha256(chunk),
                })
                offset += len(chunk)
        files[relative] = blocks
    return {
        "schemaVersion": 1,
        "source": "directory-content",
        "blockSize": BLOCK_SIZE,
        "files": files,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Create DevSpace Portable blockmap metadata")
    parser.add_argument("root")
    parser.add_argument("output")
    args = parser.parse_args()
    result = build_blockmap(Path(args.root).resolve())
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
