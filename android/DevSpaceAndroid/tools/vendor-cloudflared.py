#!/usr/bin/env python3
"""Vendor the pinned Termux Android cloudflared binary into APK assets.

The Termux package is used instead of Cloudflare's generic Linux binary because
it is built for Android/Bionic. This script verifies the exact Debian package
hash before extracting the executable from data.tar.*.
"""

from __future__ import annotations

import hashlib
import io
import lzma
from pathlib import Path
import tarfile
import urllib.request


VERSION = "2026.8.2"
ARCH = "aarch64"
DEB_SHA256 = "7ecda51a05326f34a832be6e763eb7c6f71edf4ad49f096b291fa6f8ec5a5377"
DEB_URL = (
    "https://packages.termux.dev/apt/termux-main/pool/main/c/cloudflared/"
    f"cloudflared_{VERSION}_{ARCH}.deb"
)

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent
VENDOR = PROJECT / "vendor"
ASSETS = PROJECT / "app" / "src" / "main" / "assets"
DEB = VENDOR / f"cloudflared_{VERSION}_{ARCH}.deb"
OUT = ASSETS / "cloudflared-arm64-v8a"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def download() -> bytes:
    VENDOR.mkdir(parents=True, exist_ok=True)
    if DEB.exists():
        data = DEB.read_bytes()
        if sha256(data) == DEB_SHA256:
            return data
        DEB.unlink()
    with urllib.request.urlopen(DEB_URL, timeout=120) as response:
        data = response.read()
    actual = sha256(data)
    if actual != DEB_SHA256:
        raise RuntimeError(f"Termux cloudflared .deb hash mismatch: {actual}")
    DEB.write_bytes(data)
    return data


def ar_members(data: bytes) -> dict[str, bytes]:
    if not data.startswith(b"!<arch>\n"):
        raise RuntimeError("Downloaded file is not a Debian ar archive")
    result: dict[str, bytes] = {}
    offset = 8
    while offset + 60 <= len(data):
        header = data[offset : offset + 60]
        if header[58:60] != b"`\n":
            raise RuntimeError("Invalid ar member header")
        name = header[:16].decode("ascii", "replace").strip().rstrip("/")
        size = int(header[48:58].decode("ascii").strip())
        start = offset + 60
        end = start + size
        if end > len(data):
            raise RuntimeError("Truncated ar member")
        result[name] = data[start:end]
        offset = end + (size & 1)
    return result


def extract_cloudflared(deb: bytes) -> bytes:
    members = ar_members(deb)
    data_name = next((name for name in members if name.startswith("data.tar")), None)
    if data_name is None:
        raise RuntimeError("Debian package has no data.tar payload")
    payload = members[data_name]
    if data_name.endswith(".xz"):
        payload = lzma.decompress(payload)
    elif not data_name.endswith(".tar"):
        raise RuntimeError(f"Unsupported Debian payload compression: {data_name}")
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:") as archive:
        candidates = [
            "data/data/com.termux/files/usr/bin/cloudflared",
            "./data/data/com.termux/files/usr/bin/cloudflared",
        ]
        for name in candidates:
            try:
                member = archive.getmember(name)
            except KeyError:
                continue
            stream = archive.extractfile(member)
            if stream is None:
                break
            return stream.read()
        names = [member.name for member in archive.getmembers() if member.name.endswith("/bin/cloudflared")]
        if len(names) == 1:
            stream = archive.extractfile(names[0])
            if stream is not None:
                return stream.read()
    raise RuntimeError("cloudflared executable was not found in Termux package")


def main() -> None:
    deb = download()
    if sha256(deb) != DEB_SHA256:
        raise RuntimeError("Pinned Debian package verification failed")
    binary = extract_cloudflared(deb)
    if not binary.startswith(b"\x7fELF"):
        raise RuntimeError("Extracted cloudflared is not an ELF executable")
    ASSETS.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(binary)
    print(f"cloudflared={VERSION}")
    print(f"deb_sha256={DEB_SHA256}")
    print(f"binary_sha256={sha256(binary)}")
    print(f"binary_bytes={len(binary)}")
    print(f"asset={OUT}")


if __name__ == "__main__":
    main()
