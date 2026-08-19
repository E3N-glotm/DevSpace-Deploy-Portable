from __future__ import annotations

import argparse
import gzip
import json
import os
import tarfile
from pathlib import Path, PurePosixPath


def normalized_info(path: Path, archive_name: str) -> tarfile.TarInfo:
    stat = path.lstat()
    info = tarfile.TarInfo(archive_name)
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mtime = 0
    if path.is_dir():
        info.type = tarfile.DIRTYPE
        info.mode = 0o755
        info.size = 0
    elif path.is_file():
        info.type = tarfile.REGTYPE
        executable = bool(stat.st_mode & 0o111) or path.suffix.lower() in {".sh", ".cmd", ".bat", ".ps1"}
        info.mode = 0o755 if executable else 0o644
        info.size = stat.st_size
    else:
        raise RuntimeError(f"Unsupported package entry: {path}")
    return info


def build_package(source: Path, output: Path) -> dict[str, object]:
    package = json.loads((source / "package.json").read_text(encoding="utf-8"))
    if package.get("name") != "@waishnav/devspace":
        raise RuntimeError(f"Unexpected package name: {package.get('name')}")
    if not (source / "dist" / "server.js").is_file():
        raise RuntimeError(f"Portable core source is incomplete: {source}")

    entries = sorted(
        (
            path
            for path in source.rglob("*")
            if ".git" not in path.relative_to(source).parts
            and "__pycache__" not in path.relative_to(source).parts
            and path.suffix.lower() not in {".pyc", ".pyo"}
        ),
        key=lambda path: path.relative_to(source).as_posix(),
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.unlink(missing_ok=True)
    with temporary.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=9, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
                root_info = tarfile.TarInfo("package")
                root_info.type = tarfile.DIRTYPE
                root_info.mode = 0o755
                root_info.uid = root_info.gid = 0
                root_info.uname = root_info.gname = ""
                root_info.mtime = 0
                archive.addfile(root_info)
                for path in entries:
                    relative = PurePosixPath(path.relative_to(source).as_posix())
                    archive_name = str(PurePosixPath("package") / relative)
                    info = normalized_info(path, archive_name)
                    if path.is_file():
                        with path.open("rb") as handle:
                            archive.addfile(info, handle)
                    else:
                        archive.addfile(info)
    os.replace(temporary, output)
    return {
        "name": package["name"],
        "version": package["version"],
        "files": sum(1 for path in entries if path.is_file()),
        "bytes": output.stat().st_size,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    result = build_package(Path(args.source).resolve(), Path(args.output).resolve())
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
