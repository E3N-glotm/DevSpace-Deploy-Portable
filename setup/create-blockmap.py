from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import struct
import tempfile
import zlib
import zipfile
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Iterable, Iterator


BLOCK_SIZE = 1024 * 1024
MAGIC = b"DSPBLK2\n"
PRELUDE_STRUCT = struct.Struct("<8sQQ")
PERSISTENT_ROOTS = {"data", "logs", "reports"}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def validate_relative_path(value: str) -> str:
    normalized = value.replace("\\", "/").lstrip("/")
    path = PurePosixPath(normalized)
    if not normalized or path.is_absolute() or ".." in path.parts:
        raise ValueError(f"unsafe blockmap path: {value}")
    if len(path.parts) > 0 and path.parts[0].endswith(":"):
        raise ValueError(f"unsafe blockmap path: {value}")
    return path.as_posix()


def iter_zip_files(path: Path) -> Iterator[tuple[str, int, BinaryIO]]:
    archive = zipfile.ZipFile(path, "r")
    try:
        for entry in sorted(archive.infolist(), key=lambda item: item.filename):
            if entry.is_dir():
                continue
            name = entry.filename.replace("\\", "/")
            prefix = "DevSpacePortable/"
            if not name.startswith(prefix):
                raise ValueError(f"release ZIP entry is outside DevSpacePortable/: {name}")
            relative = validate_relative_path(name[len(prefix):])
            handle = archive.open(entry, "r")
            try:
                yield relative, int(entry.file_size), handle
            finally:
                handle.close()
    finally:
        archive.close()


def iter_directory_files(path: Path) -> Iterator[tuple[str, int, BinaryIO]]:
    for file_path in sorted(path.rglob("*")):
        if not file_path.is_file():
            continue
        relative = validate_relative_path(file_path.relative_to(path).as_posix())
        handle = file_path.open("rb")
        try:
            yield relative, int(file_path.stat().st_size), handle
        finally:
            handle.close()


def encode_chunk(chunk: bytes) -> tuple[str, bytes]:
    compressed = zlib.compress(chunk, level=6)
    # Small/already-compressed binaries often become larger after a second
    # compression pass. Store those chunks verbatim so the block pack remains
    # close to the normal release ZIP size.
    if len(compressed) >= len(chunk):
        return "raw", chunk
    return "zlib", compressed


def build_block_pack(source: Path, output: Path, explicit_target_version: str = "") -> dict[str, object]:
    if not source.exists():
        raise FileNotFoundError(source)

    iterator_factory = iter_zip_files if source.is_file() and source.suffix.lower() == ".zip" else iter_directory_files
    if source.is_file() and source.suffix.lower() != ".zip":
        raise ValueError("block pack source must be a release ZIP or directory")

    files: list[dict[str, object]] = []
    chunks: dict[str, dict[str, object]] = {}
    total_target_bytes = 0
    target_version = explicit_target_version.strip()
    if target_version and not re.fullmatch(r"\d+\.\d+\.\d+", target_version):
        raise ValueError(f"invalid explicit target version: {target_version}")
    if source.is_file():
        match = re.fullmatch(r"DevSpacePortable-Windows-x64-(\d+\.\d+\.\d+)\.zip", source.name)
        if not match:
            raise ValueError(f"release ZIP name does not encode a semantic version: {source.name}")
        archive_version = match.group(1)
        if target_version and target_version != archive_version:
            raise ValueError(f"explicit target version {target_version} does not match archive version {archive_version}")
        target_version = archive_version
    if not target_version:
        raise ValueError("target version is required when the block-pack source is a directory")
    output.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.NamedTemporaryFile(prefix="devspace-blocks-", suffix=".bin", delete=False, dir=output.parent) as block_file:
        block_path = Path(block_file.name)
        try:
            for relative, declared_size, handle in iterator_factory(source):
                first = PurePosixPath(relative).parts[0]
                if first in PERSISTENT_ROOTS:
                    # Release packages intentionally do not carry durable user
                    # state. Ignore any accidental payload here rather than
                    # teaching the differential engine to overwrite it.
                    continue
                file_digest = hashlib.sha256()
                file_blocks: list[dict[str, object]] = []
                observed_size = 0
                while True:
                    raw = handle.read(BLOCK_SIZE)
                    if not raw:
                        break
                    observed_size += len(raw)
                    total_target_bytes += len(raw)
                    file_digest.update(raw)
                    chunk_hash = hashlib.sha256(raw).hexdigest()
                    file_blocks.append({"sha256": chunk_hash, "size": len(raw)})
                    if chunk_hash not in chunks:
                        encoding, encoded = encode_chunk(raw)
                        offset = block_file.tell()
                        block_file.write(encoded)
                        chunks[chunk_hash] = {
                            "offset": offset,
                            "compressedSize": len(encoded),
                            "size": len(raw),
                            "encoding": encoding,
                        }
                if observed_size != declared_size:
                    raise ValueError(
                        f"release entry size changed while reading {relative}: expected {declared_size}, got {observed_size}"
                    )
                files.append(
                    {
                        "path": relative,
                        "size": observed_size,
                        "sha256": file_digest.hexdigest(),
                        "blocks": file_blocks,
                    }
                )

            block_file.flush()
            os.fsync(block_file.fileno())

            header = {
                "schemaVersion": 2,
                "format": "devspace-block-pack-v2",
                "blockSize": BLOCK_SIZE,
                "persistentRoots": sorted(PERSISTENT_ROOTS),
                "source": "release-zip-content" if source.is_file() else "directory-content",
                "targetVersion": target_version,
                "sourceArchive": (
                    {
                        "name": source.name,
                        "size": source.stat().st_size,
                        "sha256": sha256_file(source),
                    }
                    if source.is_file()
                    else None
                ),
                "targetFileCount": len(files),
                "targetTotalBytes": total_target_bytes,
                "uniqueChunkCount": len(chunks),
                "files": files,
                "chunks": chunks,
            }
            raw_header = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            compressed_header = zlib.compress(raw_header, level=9)

            temporary = output.with_suffix(output.suffix + ".tmp")
            temporary.unlink(missing_ok=True)
            with temporary.open("wb") as target:
                target.write(PRELUDE_STRUCT.pack(MAGIC, len(compressed_header), len(raw_header)))
                target.write(compressed_header)
                with block_path.open("rb") as source_blocks:
                    shutil.copyfileobj(source_blocks, target, length=4 * 1024 * 1024)
                target.flush()
                os.fsync(target.fileno())
            temporary.replace(output)

            return {
                "format": "devspace-block-pack-v2",
                "path": str(output),
                "size": output.stat().st_size,
                "sha256": sha256_file(output),
                "headerCompressedSize": len(compressed_header),
                "headerRawSize": len(raw_header),
                "headerSha256": hashlib.sha256(compressed_header).hexdigest(),
                "targetFileCount": len(files),
                "targetTotalBytes": total_target_bytes,
                "uniqueChunkCount": len(chunks),
            }
        finally:
            # Windows does not allow unlinking an open NamedTemporaryFile.
            # Close explicitly before cleanup; the context manager's second
            # close on exit is harmless.
            block_file.close()
            block_path.unlink(missing_ok=True)


def read_pack_metadata(path: Path) -> dict[str, object]:
    with path.open("rb") as handle:
        prelude = handle.read(PRELUDE_STRUCT.size)
        if len(prelude) != PRELUDE_STRUCT.size:
            raise ValueError("block pack prelude is truncated")
        magic, compressed_size, raw_size = PRELUDE_STRUCT.unpack(prelude)
        if magic != MAGIC:
            raise ValueError("block pack magic is invalid")
        compressed = handle.read(compressed_size)
        if len(compressed) != compressed_size:
            raise ValueError("block pack header is truncated")
    raw = zlib.decompress(compressed)
    if len(raw) != raw_size:
        raise ValueError("block pack raw header size is invalid")
    header = json.loads(raw.decode("utf-8"))
    return {
        "format": str(header.get("format", "")),
        "schemaVersion": int(header.get("schemaVersion", 0)),
        "headerCompressedSize": compressed_size,
        "headerRawSize": raw_size,
        "headerSha256": hashlib.sha256(compressed).hexdigest(),
        "dataOffset": PRELUDE_STRUCT.size + compressed_size,
        "targetFileCount": int(header.get("targetFileCount", 0)),
        "targetTotalBytes": int(header.get("targetTotalBytes", 0)),
        "uniqueChunkCount": int(header.get("uniqueChunkCount", 0)),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a DevSpace Portable content-addressed block pack")
    parser.add_argument("root", help="Release ZIP or extracted release directory")
    parser.add_argument("output", help="Output .blockmap block-pack asset")
    parser.add_argument("--target-version", default="", help="Required only when root is a directory")
    parser.add_argument("--inspect", action="store_true", help="Inspect an existing block pack instead of creating one")
    args = parser.parse_args()

    output = Path(args.output).resolve()
    if args.inspect:
        metadata = read_pack_metadata(Path(args.root).resolve())
    else:
        metadata = build_block_pack(Path(args.root).resolve(), output, args.target_version)
    print(json.dumps(metadata, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
