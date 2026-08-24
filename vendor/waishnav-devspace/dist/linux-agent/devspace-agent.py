#!/usr/bin/env python3
"""DevSpace Linux Agent.

Dependency-free outbound execution/file agent for DevSpace Remote Workspace Backend.
The public MCP/OAuth control plane remains on the Windows DevSpace host; this
process only accepts authenticated RPC over an outbound WebSocket connection.
"""

from __future__ import annotations

import argparse
import base64
import ctypes
import errno
import fnmatch
import glob
import gzip
import hashlib
import json
import os
import pty
import queue
import re
import secrets
import shutil
import signal
import socket
import ssl
import stat as statmod
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path


AGENT_VERSION = "1.1.46"
PROTOCOL_VERSION = 1
DEFAULT_CONFIG = "/etc/devspace-agent/config.json"
DEFAULT_STATE_DIR = "/var/lib/devspace-agent"
MAX_MESSAGE_BYTES = 8 * 1024 * 1024
MAX_CAPTURE_BYTES = 4 * 1024 * 1024
SAMPLE_BYTES = 64 * 1024
MAX_SEARCH_RESULTS = 2000
MAX_GREP_CANDIDATES = 100_000
MAX_CONTEXT_FILES = 256
MAX_CONTEXT_SCAN_ENTRIES = 25_000
TRANSFER_CHUNK_BYTES = 512 * 1024
MAX_READ_TEXT_LINES = 10_000
MAX_READ_TEXT_BYTES = 4 * 1024 * 1024
MAX_LIST_ENTRIES = 5_000
MAX_WATCHES = 64
MAX_PROCESS_RECORDS = 500
MAX_LIVE_PROCESSES = 128
ENROLL_ATTEMPTS = 3


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def atomic_json(path: Path, value: object, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".tmp-{os.getpid()}-{secrets.token_hex(4)}")
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, mode)
    os.replace(temporary, path)


def read_json(path: Path, fallback: object) -> object:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return fallback


def encode_bytes(value: bytes) -> dict:
    if len(value) >= 4096:
        compressed = gzip.compress(value, compresslevel=6)
        if len(compressed) + 128 < len(value):
            return {"encoding": "gzip-base64", "data": base64.b64encode(compressed).decode("ascii")}
    return {"encoding": "base64", "data": base64.b64encode(value).decode("ascii")}


def decode_bytes(value: dict | None) -> bytes:
    if not value:
        return b""
    data = base64.b64decode(str(value.get("data", "")), validate=True)
    encoding = value.get("encoding")
    if encoding == "gzip-base64":
        return gzip.decompress(data)
    if encoding == "base64":
        return data
    raise ValueError(f"Unsupported content encoding: {encoding}")


def normalize_root(value: str) -> str:
    text = os.path.abspath(os.path.expanduser(str(value).strip()))
    if text == os.path.sep:
        raise ValueError("Agent writable root cannot be '/'.")
    return os.path.realpath(text) if os.path.exists(text) else text


def inside(root: str, candidate: str) -> bool:
    try:
        return os.path.commonpath([root, candidate]) == root
    except ValueError:
        return False


def closest_existing(path: str) -> str:
    current = path
    while not os.path.exists(current):
        parent = os.path.dirname(current)
        if parent == current:
            return current
        current = parent
    return current


LANDLOCK_CREATE_RULESET_VERSION = 1
LANDLOCK_RULE_PATH_BENEATH = 1
LANDLOCK_ACCESS_FS_WRITE_FILE = 1 << 1
LANDLOCK_ACCESS_FS_REMOVE_DIR = 1 << 4
LANDLOCK_ACCESS_FS_REMOVE_FILE = 1 << 5
LANDLOCK_ACCESS_FS_MAKE_CHAR = 1 << 6
LANDLOCK_ACCESS_FS_MAKE_DIR = 1 << 7
LANDLOCK_ACCESS_FS_MAKE_REG = 1 << 8
LANDLOCK_ACCESS_FS_MAKE_SOCK = 1 << 9
LANDLOCK_ACCESS_FS_MAKE_FIFO = 1 << 10
LANDLOCK_ACCESS_FS_MAKE_BLOCK = 1 << 11
LANDLOCK_ACCESS_FS_MAKE_SYM = 1 << 12
LANDLOCK_ACCESS_FS_REFER = 1 << 13
LANDLOCK_ACCESS_FS_TRUNCATE = 1 << 14
PR_SET_NO_NEW_PRIVS = 38
SYS_LANDLOCK_CREATE_RULESET = 444
SYS_LANDLOCK_ADD_RULE = 445
SYS_LANDLOCK_RESTRICT_SELF = 446


class LandlockRulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]


class LandlockPathBeneathAttr(ctypes.Structure):
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int)]


def landlock_abi() -> int:
    libc = ctypes.CDLL(None, use_errno=True)
    result = libc.syscall(SYS_LANDLOCK_CREATE_RULESET, 0, 0, LANDLOCK_CREATE_RULESET_VERSION)
    return int(result) if result >= 1 else 0


def landlock_runtime_scratch_paths() -> list[str]:
    """Ephemeral Linux runtime paths ordinary SSH shells can write safely.

    Scoped mode is intended to stop persistent writes outside writableRoots,
    not to break normal process runtime facilities.  Python/PyTorch/NCCL and
    many CLI tools legitimately need temporary files or shared memory even
    when all durable project output stays under the workspace.
    """
    candidates = ["/tmp", "/var/tmp", "/dev/shm", "/dev/mqueue"]
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    candidates.append(runtime_dir)
    result: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        resolved = os.path.realpath(candidate)
        if resolved in seen or not os.path.isdir(resolved):
            continue
        seen.add(resolved)
        result.append(resolved)
    return result


def landlock_runtime_device_paths() -> list[str]:
    """Return narrowly-scoped character devices that need O_RDWR semantics.

    Landlock WRITE_FILE also gates O_RDWR opens on character devices.  That
    accidentally blocked NVML/CUDA in scoped Remote Agent commands even when
    the same Linux user could use the GPU over SSH.  Restore parity only for
    non-persistent terminal/random/sink devices and accelerator device nodes;
    never grant block-device access or arbitrary /dev writes.
    """
    patterns = [
        "/dev/null",
        "/dev/zero",
        "/dev/full",
        "/dev/random",
        "/dev/urandom",
        "/dev/tty",
        "/dev/ptmx",
        "/dev/nvidiactl",
        "/dev/nvidia-uvm",
        "/dev/nvidia-uvm-tools",
        "/dev/nvidia[0-9]*",
        "/dev/dri/card[0-9]*",
        "/dev/dri/renderD[0-9]*",
        "/dev/kfd",
        "/dev/infiniband/uverbs*",
        "/dev/infiniband/rdma_cm",
        "/dev/infiniband/umad*",
        "/dev/infiniband/issm*",
    ]
    result: list[str] = []
    seen: set[str] = set()
    for pattern in patterns:
        matches = glob.glob(pattern) if any(char in pattern for char in "*?[") else [pattern]
        for candidate in matches:
            try:
                resolved = os.path.realpath(candidate)
                mode = os.stat(resolved).st_mode
            except OSError:
                continue
            if not statmod.S_ISCHR(mode) or resolved in seen:
                continue
            seen.add(resolved)
            result.append(resolved)
    return result


def landlock_runtime_device_directories() -> list[str]:
    """Directories containing dynamic character devices needed at runtime.

    PTY slave nodes under /dev/pts are created after /dev/ptmx is opened, so
    they cannot be enumerated before the Landlock ruleset is applied. Grant
    WRITE_FILE only to the devpts directory; Unix ownership/mode checks remain
    authoritative and no create/remove permissions are granted here.
    """
    result: list[str] = []
    for candidate in ["/dev/pts"]:
        resolved = os.path.realpath(candidate)
        if os.path.isdir(resolved):
            result.append(resolved)
    return result


def apply_write_landlock(roots: list[str], abi: int) -> None:
    handled = (
        LANDLOCK_ACCESS_FS_WRITE_FILE
        | LANDLOCK_ACCESS_FS_REMOVE_DIR
        | LANDLOCK_ACCESS_FS_REMOVE_FILE
        | LANDLOCK_ACCESS_FS_MAKE_CHAR
        | LANDLOCK_ACCESS_FS_MAKE_DIR
        | LANDLOCK_ACCESS_FS_MAKE_REG
        | LANDLOCK_ACCESS_FS_MAKE_SOCK
        | LANDLOCK_ACCESS_FS_MAKE_FIFO
        | LANDLOCK_ACCESS_FS_MAKE_BLOCK
        | LANDLOCK_ACCESS_FS_MAKE_SYM
    )
    if abi >= 2:
        handled |= LANDLOCK_ACCESS_FS_REFER
    if abi >= 3:
        handled |= LANDLOCK_ACCESS_FS_TRUNCATE
    libc = ctypes.CDLL(None, use_errno=True)
    ruleset_attr = LandlockRulesetAttr(handled_access_fs=handled)
    ruleset_fd = libc.syscall(SYS_LANDLOCK_CREATE_RULESET, ctypes.byref(ruleset_attr), ctypes.sizeof(ruleset_attr), 0)
    if ruleset_fd < 0:
        raise OSError(ctypes.get_errno(), "landlock_create_ruleset failed")
    opened: list[int] = []
    try:
        for root in roots:
            fd = os.open(root, getattr(os, "O_PATH", os.O_RDONLY) | os.O_CLOEXEC)
            opened.append(fd)
            path_attr = LandlockPathBeneathAttr(allowed_access=handled, parent_fd=fd)
            if libc.syscall(SYS_LANDLOCK_ADD_RULE, ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, ctypes.byref(path_attr), 0) < 0:
                raise OSError(ctypes.get_errno(), f"landlock_add_rule failed for {root}")
        # Runtime scratch is explicitly non-persistent.  Keep durable writes
        # confined to writableRoots while preserving ordinary Linux process
        # compatibility (tempfiles, multiprocessing shared memory, NCCL, etc.).
        scratch_access = handled & ~(LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_BLOCK)
        for scratch in landlock_runtime_scratch_paths():
            fd = os.open(scratch, getattr(os, "O_PATH", os.O_RDONLY) | os.O_CLOEXEC)
            opened.append(fd)
            scratch_attr = LandlockPathBeneathAttr(allowed_access=scratch_access, parent_fd=fd)
            if libc.syscall(SYS_LANDLOCK_ADD_RULE, ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, ctypes.byref(scratch_attr), 0) < 0:
                raise OSError(ctypes.get_errno(), f"landlock_add_rule failed for runtime scratch {scratch}")
        # O_RDWR on character devices is seen by Landlock as WRITE_FILE.  GPU
        # management/compute APIs (NVML/CUDA), PTYs and common sink/random
        # devices require that access even though they do not represent durable
        # filesystem writes.  Grant only WRITE_FILE to the allowlisted device
        # inode itself; block devices and arbitrary /dev paths stay denied.
        for device in landlock_runtime_device_paths():
            fd = os.open(device, getattr(os, "O_PATH", os.O_RDONLY) | os.O_CLOEXEC)
            opened.append(fd)
            device_attr = LandlockPathBeneathAttr(allowed_access=LANDLOCK_ACCESS_FS_WRITE_FILE, parent_fd=fd)
            if libc.syscall(SYS_LANDLOCK_ADD_RULE, ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, ctypes.byref(device_attr), 0) < 0:
                raise OSError(ctypes.get_errno(), f"landlock_add_rule failed for runtime device {device}")
        for directory in landlock_runtime_device_directories():
            fd = os.open(directory, getattr(os, "O_PATH", os.O_RDONLY) | os.O_CLOEXEC)
            opened.append(fd)
            directory_attr = LandlockPathBeneathAttr(allowed_access=LANDLOCK_ACCESS_FS_WRITE_FILE, parent_fd=fd)
            if libc.syscall(SYS_LANDLOCK_ADD_RULE, ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, ctypes.byref(directory_attr), 0) < 0:
                raise OSError(ctypes.get_errno(), f"landlock_add_rule failed for runtime device directory {directory}")
        if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "prctl(PR_SET_NO_NEW_PRIVS) failed")
        if libc.syscall(SYS_LANDLOCK_RESTRICT_SELF, ruleset_fd, 0) < 0:
            raise OSError(ctypes.get_errno(), "landlock_restrict_self failed")
    finally:
        for fd in opened:
            os.close(fd)
        os.close(ruleset_fd)


class PathGuard:
    def __init__(self, roots: list[str], access_mode: str = "scoped"):
        self.configure(roots, access_mode)

    def configure(self, roots: list[str], access_mode: str = "scoped") -> None:
        self.access_mode = "full-access" if str(access_mode).strip().lower() == "full-access" else "scoped"
        self.roots = [normalize_root(root) for root in roots]
        if self.access_mode != "full-access" and not self.roots:
            raise ValueError("Scoped Remote Agent access requires at least one writable root.")

    @property
    def full_access(self) -> bool:
        return self.access_mode == "full-access"

    def workspace_root(self, root: str) -> str:
        candidate = os.path.realpath(os.path.abspath(os.path.expanduser(root)))
        if not os.path.isdir(candidate):
            raise NotADirectoryError(candidate)
        return candidate

    def absolute(self, root: str, path: str | None = None) -> str:
        workspace_root = self.workspace_root(root)
        if path is None or str(path) in ("", "."):
            candidate = workspace_root
        elif os.path.isabs(str(path)):
            candidate = os.path.abspath(str(path))
        else:
            candidate = os.path.abspath(os.path.join(workspace_root, str(path)))
        existing = closest_existing(candidate)
        resolved_existing = os.path.realpath(existing)
        if not inside(workspace_root, resolved_existing):
            raise PermissionError(f"Path is outside the opened Remote Workspace: {candidate}")
        if os.path.exists(candidate):
            resolved = os.path.realpath(candidate)
            if not inside(workspace_root, resolved):
                raise PermissionError(f"Path resolves outside the opened Remote Workspace: {candidate}")
        return candidate

    def writable(self, root: str, path: str | None = None) -> str:
        candidate = self.absolute(root, path)
        if self.full_access:
            return candidate
        existing = closest_existing(candidate)
        resolved_existing = os.path.realpath(existing)
        if not any(inside(allowed, resolved_existing) for allowed in self.roots):
            raise PermissionError(f"Remote Agent write is outside configured writable roots: {candidate}")
        if os.path.exists(candidate):
            resolved = os.path.realpath(candidate)
            if not any(inside(allowed, resolved) for allowed in self.roots):
                raise PermissionError(f"Remote Agent write resolves outside configured writable roots: {candidate}")
        return candidate

    def owning_allowed_root(self, root: str) -> str:
        resolved = self.workspace_root(root)
        if self.full_access:
            return resolved
        matches = [allowed for allowed in self.roots if inside(allowed, resolved)]
        if not matches:
            raise PermissionError(f"Remote worktree source must be inside a configured writable root: {resolved}")
        return max(matches, key=len)

    def command_preexec_fn(self):
        if self.full_access:
            return None
        abi = landlock_abi()
        if abi < 1:
            raise RuntimeError("Scoped Remote Agent shell execution requires Linux Landlock support so commands cannot write outside configured writable roots. Use Full Access only if unrestricted SSH-user writes are intended.")
        roots = list(self.roots)
        return lambda: apply_write_landlock(roots, abi)


class WebSocketClient:
    def __init__(self, server_url: str):
        parsed = urllib.parse.urlparse(server_url)
        if parsed.scheme not in ("http", "https", "ws", "wss"):
            raise ValueError(f"Unsupported DevSpace server URL: {server_url}")
        self.secure = parsed.scheme in ("https", "wss")
        self.host = parsed.hostname or ""
        self.port = parsed.port or (443 if self.secure else 80)
        base_path = parsed.path.rstrip("/")
        self.path = (base_path if base_path and base_path != "/" else "") + "/agent/v1/connect"
        self.socket: socket.socket | ssl.SSLSocket | None = None
        self.send_lock = threading.Lock()

    def connect(self, timeout: float = 15.0) -> None:
        raw = socket.create_connection((self.host, self.port), timeout=timeout)
        raw.settimeout(None)
        if self.secure:
            context = ssl.create_default_context()
            sock = context.wrap_socket(raw, server_hostname=self.host)
        else:
            sock = raw
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        host_header = self.host if self.port in (80, 443) else f"{self.host}:{self.port}"
        request = (
            f"GET {self.path} HTTP/1.1\r\n"
            f"Host: {host_header}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "User-Agent: DevSpace-Linux-Agent/1\r\n"
            "\r\n"
        ).encode("ascii")
        sock.sendall(request)
        response = self._read_http_headers(sock)
        status = response.split(b"\r\n", 1)[0]
        if b" 101 " not in status:
            sock.close()
            raise ConnectionError(f"WebSocket upgrade failed: {status.decode('latin1', 'replace')}")
        headers = {}
        for line in response.split(b"\r\n")[1:]:
            if b":" in line:
                key_name, value = line.split(b":", 1)
                headers[key_name.strip().lower()] = value.strip()
        expected = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest())
        if headers.get(b"sec-websocket-accept") != expected:
            sock.close()
            raise ConnectionError("WebSocket server returned an invalid Sec-WebSocket-Accept value.")
        self.socket = sock

    @staticmethod
    def _read_http_headers(sock: socket.socket) -> bytes:
        data = bytearray()
        while b"\r\n\r\n" not in data:
            chunk = sock.recv(4096)
            if not chunk:
                raise ConnectionError("Connection closed during WebSocket handshake.")
            data.extend(chunk)
            if len(data) > 64 * 1024:
                raise ConnectionError("WebSocket handshake headers are too large.")
        header, _separator, remainder = bytes(data).partition(b"\r\n\r\n")
        if remainder:
            # The DevSpace server does not send application frames before hello,
            # so receiving bytes here indicates an invalid handshake boundary.
            raise ConnectionError("Unexpected WebSocket payload during handshake.")
        return header + b"\r\n\r\n"

    def close(self) -> None:
        sock = self.socket
        self.socket = None
        if not sock:
            return
        try:
            self._send_frame(0x8, b"")
        except OSError:
            pass
        try:
            sock.close()
        except OSError:
            pass

    def send_json(self, value: object) -> None:
        raw = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(raw) > MAX_MESSAGE_BYTES:
            raise ValueError("Outgoing RPC message exceeds bounded payload size.")
        self._send_frame(0x1, raw)

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        sock = self.socket
        if not sock:
            raise ConnectionError("WebSocket is not connected.")
        with self.send_lock:
            mask = os.urandom(4)
            length = len(payload)
            if length < 126:
                header = bytes((0x80 | opcode, 0x80 | length))
            elif length <= 0xFFFF:
                header = bytes((0x80 | opcode, 0x80 | 126)) + struct.pack("!H", length)
            else:
                header = bytes((0x80 | opcode, 0x80 | 127)) + struct.pack("!Q", length)
            masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
            sock.sendall(header + mask + masked)

    @staticmethod
    def _read_exact(sock: socket.socket, length: int) -> bytes:
        data = bytearray()
        while len(data) < length:
            chunk = sock.recv(length - len(data))
            if not chunk:
                raise ConnectionError("WebSocket connection closed.")
            data.extend(chunk)
        return bytes(data)

    def recv_json(self) -> dict:
        sock = self.socket
        if not sock:
            raise ConnectionError("WebSocket is not connected.")
        fragments = bytearray()
        message_opcode = None
        while True:
            first, second = self._read_exact(sock, 2)
            fin = bool(first & 0x80)
            opcode = first & 0x0F
            masked = bool(second & 0x80)
            length = second & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._read_exact(sock, 2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read_exact(sock, 8))[0]
            if length > MAX_MESSAGE_BYTES:
                raise ValueError("Incoming RPC message exceeds bounded payload size.")
            mask = self._read_exact(sock, 4) if masked else None
            payload = self._read_exact(sock, length)
            if mask:
                payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
            if opcode == 0x8:
                code = struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else 1005
                reason = payload[2:].decode("utf-8", "replace") if len(payload) > 2 else ""
                detail = f" ({code}{': ' + reason if reason else ''})"
                raise ConnectionError(f"WebSocket was closed by the server{detail}.")
            if opcode == 0x9:
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:
                continue
            if opcode in (0x1, 0x2):
                message_opcode = opcode
                fragments.extend(payload)
            elif opcode == 0x0 and message_opcode is not None:
                fragments.extend(payload)
            else:
                raise ValueError(f"Unsupported WebSocket opcode: {opcode}")
            if fin:
                if message_opcode != 0x1:
                    raise ValueError("DevSpace agent protocol requires JSON text frames.")
                return json.loads(bytes(fragments).decode("utf-8"))


def git(args: list[str], cwd: str, check: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=check)


def git_metadata(root: str) -> dict:
    def value(args: list[str]) -> str | None:
        result = git(args, root)
        text = result.stdout.strip()
        return text if result.returncode == 0 and text else None

    return {key: item for key, item in {
        "sha": value(["rev-parse", "HEAD"]),
        "branch": value(["branch", "--show-current"]),
        "originUrl": value(["remote", "get-url", "origin"]),
    }.items() if item is not None}


def project_context(root: str, guard: PathGuard | None = None) -> tuple[list[dict], list[dict]]:
    loaded = []
    available = []
    root_names = ("AGENTS.md", "CLAUDE.md")
    for name in root_names:
        path = os.path.join(root, name)
        if os.path.isfile(path):
            try:
                safe = guard.absolute(root, path) if guard else path
                with open(safe, "r", encoding="utf-8") as handle:
                    loaded.append({"path": path, "content": handle.read(512 * 1024)})
            except (OSError, UnicodeError, PermissionError):
                pass
    entries = 0
    for current, dirs, files in os.walk(root):
        dirs[:] = [name for name in dirs if name not in (".git", "node_modules", ".venv", "venv", "__pycache__")]
        entries += len(dirs) + len(files)
        if entries > MAX_CONTEXT_SCAN_ENTRIES or len(available) >= MAX_CONTEXT_FILES:
            break
        if current == root:
            continue
        for name in root_names:
            if name in files:
                available.append({"path": os.path.join(current, name)})
                if len(available) >= MAX_CONTEXT_FILES:
                    break
    return loaded, available


class TransferManager:
    def __init__(self, state_dir: Path, guard: PathGuard):
        self.root = state_dir / "transfers"
        self.root.mkdir(parents=True, exist_ok=True)
        self.guard = guard
        self.lock = threading.Lock()

    def prepare(self, params: dict) -> dict:
        transfer_id = str(params["transferId"])
        workspace_root = str(params["root"])
        target = self.guard.writable(workspace_root, str(params["path"]))
        transfer_dir = self.root / transfer_id
        shutil.rmtree(transfer_dir, ignore_errors=True)
        transfer_dir.mkdir(parents=True, exist_ok=True)
        chunks = list(params.get("chunks") or [])
        missing = []
        existing = open(target, "rb") if os.path.isfile(target) else None
        try:
            for item in chunks:
                index = int(item["index"])
                size = int(item["size"])
                expected = str(item["sha256"])
                reused = False
                if existing:
                    existing.seek(index * TRANSFER_CHUNK_BYTES)
                    data = existing.read(size)
                    if len(data) == size and sha256_bytes(data) == expected:
                        (transfer_dir / f"chunk-{index:08d}").write_bytes(data)
                        reused = True
                if not reused:
                    missing.append(index)
        finally:
            if existing:
                existing.close()
        metadata = {
            "target": target,
            "path": str(params["path"]),
            "root": workspace_root,
            "size": int(params["size"]),
            "sha256": str(params["sha256"]),
            "mode": params.get("mode"),
            "chunks": chunks,
        }
        atomic_json(transfer_dir / "metadata.json", metadata)
        return {"transferId": transfer_id, "missingChunks": missing, "reusedChunks": len(chunks) - len(missing)}

    def write_chunk(self, params: dict) -> dict:
        transfer_id = str(params["transferId"])
        index = int(params["index"])
        transfer_dir = self.root / transfer_id
        if not transfer_dir.is_dir():
            raise FileNotFoundError(f"Transfer not found: {transfer_id}")
        data = decode_bytes(params.get("content"))
        expected = str(params["sha256"])
        if sha256_bytes(data) != expected:
            raise ValueError(f"Transfer chunk hash mismatch: {index}")
        path = transfer_dir / f"chunk-{index:08d}"
        path.write_bytes(data)
        return {"transferId": transfer_id, "index": index, "bytes": len(data)}

    def commit(self, params: dict) -> dict:
        transfer_id = str(params["transferId"])
        transfer_dir = self.root / transfer_id
        metadata = read_json(transfer_dir / "metadata.json", None)
        if not isinstance(metadata, dict):
            raise FileNotFoundError(f"Transfer metadata not found: {transfer_id}")
        target = str(metadata["target"])
        os.makedirs(os.path.dirname(target), exist_ok=True)
        temporary = target + f".devspace-transfer-{os.getpid()}-{secrets.token_hex(4)}"
        digest = hashlib.sha256()
        written = 0
        with open(temporary, "wb") as output:
            for item in metadata["chunks"]:
                chunk = transfer_dir / f"chunk-{int(item['index']):08d}"
                data = chunk.read_bytes()
                if sha256_bytes(data) != str(item["sha256"]):
                    raise ValueError(f"Transfer chunk is missing or corrupt: {item['index']}")
                output.write(data)
                digest.update(data)
                written += len(data)
            output.flush()
            os.fsync(output.fileno())
        if written != int(metadata["size"]) or digest.hexdigest() != str(metadata["sha256"]):
            os.unlink(temporary)
            raise ValueError("Committed transfer size/hash mismatch.")
        if metadata.get("mode") is not None:
            os.chmod(temporary, int(metadata["mode"]) & 0o7777)
        os.replace(temporary, target)
        shutil.rmtree(transfer_dir, ignore_errors=True)
        return {"path": metadata["path"], "bytes": written, "sha256": digest.hexdigest(), "deltaTransfer": True}


class ProcessRegistry:
    def __init__(self, state_dir: Path):
        self.state_file = state_dir / "processes.json"
        self.logs_dir = state_dir / "process-logs"
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        self.records: dict[str, dict] = {}
        self.lock = threading.RLock()
        self._load()

    def _load(self) -> None:
        values = read_json(self.state_file, [])
        if not isinstance(values, list):
            return
        for value in values:
            if not isinstance(value, dict) or not value.get("processHandle"):
                continue
            pid = value.get("pid")
            running = bool(pid and self._pid_alive(int(pid)))
            value["running"] = running
            value["status"] = "running" if running else value.get("status", "exited")
            value["reattachable"] = False
            value["proc"] = None
            value["stdin"] = None
            value["masterFd"] = None
            value["cursor"] = 0
            self.records[str(value["processHandle"])] = value

    @staticmethod
    def _pid_alive(pid: int) -> bool:
        try:
            os.kill(pid, 0)
            return True
        except OSError as error:
            return error.errno == errno.EPERM

    def _persist(self) -> None:
        serializable = []
        for record in sorted(self.records.values(), key=lambda item: item.get("startedAt", ""), reverse=True)[:500]:
            serializable.append({key: value for key, value in record.items() if key not in ("proc", "stdin", "masterFd", "reader")})
        atomic_json(self.state_file, serializable)

    def _prune_records(self) -> None:
        for record in self.records.values():
            self._refresh(record)
        completed = sorted(
            (record for record in self.records.values() if not record.get("running")),
            key=lambda item: item.get("startedAt", ""),
        )
        while len(self.records) >= MAX_PROCESS_RECORDS and completed:
            victim = completed.pop(0)
            self.records.pop(str(victim["processHandle"]), None)
        live = sum(1 for record in self.records.values() if record.get("running"))
        if live >= MAX_LIVE_PROCESSES:
            raise RuntimeError(f"Remote process limit reached ({MAX_LIVE_PROCESSES} live processes).")

    def _reader(self, record: dict, source) -> None:
        log_path = Path(record["logPath"])
        with open(log_path, "ab", buffering=0) as log:
            try:
                while True:
                    if isinstance(source, int):
                        data = os.read(source, 65536)
                    else:
                        data = source.read(65536)
                    if not data:
                        break
                    log.write(data)
            except OSError:
                pass
        self._refresh(record)

    def _refresh(self, record: dict) -> None:
        proc = record.get("proc")
        if proc is not None:
            code = proc.poll()
            if code is None:
                record["running"] = True
                record["status"] = "running"
            else:
                record["running"] = False
                record["status"] = "exited"
                record["exitCode"] = int(code)
                record["completedAt"] = record.get("completedAt") or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        elif record.get("pid"):
            record["running"] = self._pid_alive(int(record["pid"]))
            if not record["running"] and record.get("status") == "running":
                record["status"] = "exited-unknown"

    def _output(self, record: dict, max_bytes: int = 512 * 1024) -> tuple[str, bool]:
        log_path = Path(record["logPath"])
        if not log_path.exists():
            return "", False
        size = log_path.stat().st_size
        cursor = min(int(record.get("cursor", 0)), size)
        with open(log_path, "rb") as handle:
            handle.seek(cursor)
            data = handle.read(max_bytes)
            record["cursor"] = cursor + len(data)
        return data.decode("utf-8", "replace"), record["cursor"] < size

    def snapshot(self, record: dict, output: str = "", output_truncated: bool = False) -> dict:
        self._refresh(record)
        elapsed_ms = max(0, int((time.time() - float(record.get("startedEpoch", time.time()))) * 1000))
        value = {
            "processHandle": record["processHandle"],
            "sessionId": record.get("sessionId"),
            "pid": record.get("pid"),
            "running": bool(record.get("running")),
            "status": record.get("status"),
            "wallTimeMs": elapsed_ms,
            "reattachable": bool(record.get("reattachable")),
            "output": output,
            "outputTruncated": bool(output_truncated),
        }
        if record.get("exitCode") is not None:
            value["exitCode"] = int(record["exitCode"])
        if record.get("signal") is not None:
            value["signal"] = str(record["signal"])
        return value

    @staticmethod
    def _output_budget(params: dict) -> int:
        tokens = max(1, min(int(params.get("maxOutputTokens") or 10_000), 100_000))
        return min(2 * 1024 * 1024, max(4096, tokens * 4))

    def _find(self, params: dict) -> dict:
        handle = str(params.get("processHandle") or "").strip()
        if handle:
            record = self.records.get(handle)
            if record:
                return record
        session_id = params.get("sessionId")
        if session_id is not None:
            matches = [record for record in self.records.values() if int(record.get("sessionId") or -1) == int(session_id)]
            if len(matches) == 1:
                return matches[0]
            if len(matches) > 1:
                raise KeyError(f"Remote process sessionId is ambiguous: {session_id}")
        raise KeyError(f"Unknown remote process handle/session: {handle or session_id}")

    def start(self, params: dict, guard: PathGuard) -> dict:
        root = guard.workspace_root(str(params["root"]))
        cwd = guard.absolute(root, str(params.get("cwd") or root))
        if not os.path.isdir(cwd):
            raise NotADirectoryError(cwd)
        cmd = params.get("command")
        argv = params.get("argv")
        if bool(cmd) == bool(argv):
            raise ValueError("Provide exactly one of command or argv.")
        handle = str(params.get("processHandle") or f"remote_{secrets.token_hex(8)}")
        if len(handle) > 128:
            raise ValueError("processHandle is too long.")
        with self.lock:
            self._prune_records()
            existing = self.records.get(handle)
            if existing:
                self._refresh(existing)
                if existing.get("running"):
                    raise ValueError(f"Process handle is already running: {handle}")
            env = os.environ.copy()
            for key, value in (params.get("env") or {}).items():
                if value is None:
                    env.pop(str(key), None)
                else:
                    env[str(key)] = str(value)
            tty = bool(params.get("tty"))
            persistent = bool(params.get("persistent"))
            command_line = ["/bin/bash", "-lc", str(cmd)] if cmd else [str(value) for value in argv]
            log_path = self.logs_dir / (hashlib.sha256(handle.encode()).hexdigest() + ".log")
            log_path.write_bytes(b"")
            master_fd = None
            slave_fd = None
            popen_kwargs = {
                "cwd": cwd,
                "env": env,
                "start_new_session": True,
                "close_fds": True,
            }
            preexec = guard.command_preexec_fn()
            if preexec is not None:
                popen_kwargs["preexec_fn"] = preexec
            if tty:
                master_fd, slave_fd = pty.openpty()
                rows = int(params.get("rows") or 24)
                columns = int(params.get("columns") or 80)
                import fcntl
                import termios
                fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
                popen_kwargs.update(stdin=slave_fd, stdout=slave_fd, stderr=slave_fd)
            elif persistent:
                # Persistent non-TTY jobs must survive an agent restart. Give
                # the child its own append-only log descriptor instead of a
                # stdout pipe owned by this Python process; the kernel keeps
                # that descriptor valid after the agent exits/restarts.
                durable_log = open(log_path, "ab", buffering=0)
                popen_kwargs.update(stdin=subprocess.PIPE, stdout=durable_log, stderr=subprocess.STDOUT)
            else:
                popen_kwargs.update(stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            proc = subprocess.Popen(command_line, **popen_kwargs)
            if persistent and not tty:
                durable_log.close()
            if slave_fd is not None:
                os.close(slave_fd)
            record = {
                "processHandle": handle,
                "sessionId": int(time.time() * 1000) % 2_000_000_000,
                "workspaceId": params.get("workspaceId"),
                "root": root,
                "cwd": cwd,
                "pid": proc.pid,
                "command": str(cmd) if cmd else None,
                "argv": argv,
                "tty": tty,
                "persistent": persistent,
                "status": "running",
                "running": True,
                "exitCode": None,
                "signal": None,
                "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "startedEpoch": time.time(),
                "logPath": str(log_path),
                "cursor": 0,
                "reattachable": True,
                "proc": proc,
                "stdin": proc.stdin,
                "masterFd": master_fd,
            }
            source = master_fd if tty else proc.stdout
            reader = None if persistent and not tty else threading.Thread(target=self._reader, args=(record, source), daemon=True, name=f"devspace-proc-{handle[:20]}")
            record["reader"] = reader
            self.records[handle] = record
            self._persist()
            if reader is not None:
                reader.start()
        yield_ms = max(0, min(int(params.get("yieldTimeMs") or 10_000), 30_000))
        deadline = time.monotonic() + yield_ms / 1000.0
        while time.monotonic() < deadline:
            self._refresh(record)
            if not record.get("running"):
                break
            time.sleep(0.03)
        output, truncated = self._output(record, self._output_budget(params))
        self._persist()
        return self.snapshot(record, output, truncated)

    def write(self, params: dict) -> dict:
        with self.lock:
            record = self._find(params)
            handle = str(record["processHandle"])
            self._refresh(record)
            chars = params.get("chars")
            if chars and not record.get("running"):
                raise RuntimeError(f"Remote process is not running: {handle}")
            if chars:
                data = str(chars).encode("utf-8")
                if record.get("masterFd") is not None:
                    os.write(int(record["masterFd"]), data)
                elif record.get("stdin") is not None:
                    record["stdin"].write(data)
                    record["stdin"].flush()
                else:
                    raise RuntimeError("Remote process stdin is not reattachable after agent restart.")
            if params.get("columns") or params.get("rows"):
                if record.get("masterFd") is not None:
                    import fcntl
                    import termios
                    rows = int(params.get("rows") or 24)
                    columns = int(params.get("columns") or 80)
                    fcntl.ioctl(int(record["masterFd"]), termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        yield_ms = max(0, min(int(params.get("yieldTimeMs") or 10_000), 30_000))
        deadline = time.monotonic() + yield_ms / 1000.0
        while time.monotonic() < deadline:
            self._refresh(record)
            if not record.get("running"):
                break
            if Path(record["logPath"]).stat().st_size > int(record.get("cursor", 0)):
                break
            time.sleep(0.03)
        output, truncated = self._output(record, self._output_budget(params))
        self._persist()
        return self.snapshot(record, output, truncated)

    def list(self, params: dict) -> list[dict]:
        workspace_id = params.get("workspaceId")
        include_completed = bool(params.get("includeCompleted"))
        limit = max(1, min(int(params.get("limit") or 100), 1000))
        result = []
        with self.lock:
            for record in self.records.values():
                self._refresh(record)
                if workspace_id and record.get("workspaceId") != workspace_id:
                    continue
                if not include_completed and not record.get("running"):
                    continue
                result.append(self.snapshot(record))
        return sorted(result, key=lambda item: item.get("wallTimeMs", 0))[:limit]

    def attach(self, params: dict) -> dict:
        return self.write({**params, "chars": None})

    def kill(self, params: dict) -> dict:
        record = self._find(params)
        handle = str(record["processHandle"])
        self._refresh(record)
        if record.get("running") and record.get("pid"):
            signal_name = str(params.get("signal") or "SIGTERM")
            sig = getattr(signal, signal_name, signal.SIGTERM)
            try:
                os.killpg(int(record["pid"]), sig)
            except ProcessLookupError:
                pass
            record["signal"] = signal_name
            time.sleep(0.05)
            self._refresh(record)
        self._persist()
        output, truncated = self._output(record, self._output_budget(params))
        return self.snapshot(record, output, truncated)


class WatchManager:
    def __init__(self, guard: PathGuard, event_sender):
        self.guard = guard
        self.event_sender = event_sender
        self.watches: dict[str, dict] = {}
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._loop, daemon=True, name="devspace-file-watch")
        self.thread.start()

    @staticmethod
    def _snapshot(path: str, recursive: bool) -> dict[str, tuple]:
        result = {}
        try:
            if os.path.isfile(path) or os.path.islink(path):
                st = os.lstat(path)
                result[path] = (st.st_mtime_ns, st.st_size, st.st_mode)
                return result
            if not os.path.isdir(path):
                return result
            if not recursive:
                for name in os.listdir(path):
                    child = os.path.join(path, name)
                    try:
                        st = os.lstat(child)
                        result[child] = (st.st_mtime_ns, st.st_size, st.st_mode)
                    except OSError:
                        pass
                return result
            entries = 0
            for current, dirs, files in os.walk(path):
                dirs[:] = [name for name in dirs if name not in (".git", "node_modules")]
                for name in [*dirs, *files]:
                    entries += 1
                    if entries > 50_000:
                        return result
                    child = os.path.join(current, name)
                    try:
                        st = os.lstat(child)
                        result[child] = (st.st_mtime_ns, st.st_size, st.st_mode)
                    except OSError:
                        pass
        except OSError:
            pass
        return result

    def start(self, params: dict) -> dict:
        root = self.guard.workspace_root(str(params["root"]))
        path = self.guard.absolute(root, str(params.get("path") or "."))
        watch_id = str(params.get("watchId") or f"rw_{secrets.token_hex(8)}")
        with self.lock:
            active_count = sum(1 for value in self.watches.values() if value.get("status") == "active")
            if active_count >= MAX_WATCHES:
                raise RuntimeError(f"Remote file-watch limit reached ({MAX_WATCHES}).")
        item = {
            "watchId": watch_id,
            "workspaceId": params.get("workspaceId"),
            "path": path,
            "recursive": params.get("recursive") is not False,
            "status": "active",
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "events": [],
        }
        item["snapshot"] = self._snapshot(path, item["recursive"])
        with self.lock:
            self.watches[watch_id] = item
        return {key: value for key, value in item.items() if key not in ("snapshot", "events")}

    def poll(self, params: dict) -> dict:
        watch_id = str(params["watchId"])
        after = int(params.get("afterSequence") or 0)
        limit = max(1, min(int(params.get("limit") or 100), 1000))
        with self.lock:
            item = self.watches.get(watch_id)
            if not item:
                raise KeyError(f"Remote watch not found: {watch_id}")
            events = [event for event in item["events"] if int(event["sequence"]) > after][:limit]
        next_sequence = events[-1]["sequence"] if events else after
        return {"events": events, "nextSequence": next_sequence}

    def stop(self, params: dict) -> dict:
        watch_id = str(params["watchId"])
        with self.lock:
            item = self.watches.get(watch_id)
            if not item:
                raise KeyError(f"Remote watch not found: {watch_id}")
            item["status"] = "stopped"
            return {key: value for key, value in item.items() if key not in ("snapshot", "events")}

    def list(self, params: dict) -> list[dict]:
        workspace_id = params.get("workspaceId")
        include_stopped = bool(params.get("includeStopped"))
        with self.lock:
            values = []
            for item in self.watches.values():
                if workspace_id and item.get("workspaceId") != workspace_id:
                    continue
                if not include_stopped and item.get("status") != "active":
                    continue
                values.append({key: value for key, value in item.items() if key not in ("snapshot", "events")})
            return values

    def _loop(self) -> None:
        sequence = 0
        while not self.stop_event.wait(1.0):
            with self.lock:
                active = [item for item in self.watches.values() if item.get("status") == "active"]
            for item in active:
                current = self._snapshot(item["path"], item["recursive"])
                previous = item.get("snapshot", {})
                changed = sorted(set(current) | set(previous))
                for path in changed:
                    if current.get(path) == previous.get(path):
                        continue
                    sequence += 1
                    kind = "changed" if path in current and path in previous else "created" if path in current else "deleted"
                    event = {
                        "sequence": sequence,
                        "kind": "fs.changed",
                        "subject": item["watchId"],
                        "workspaceId": item.get("workspaceId"),
                        "payload": {"watchId": item["watchId"], "path": path, "change": kind},
                        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    }
                    with self.lock:
                        item["events"].append(event)
                        item["events"] = item["events"][-1000:]
                    self.event_sender(event)
                item["snapshot"] = current

    def close(self) -> None:
        self.stop_event.set()
        self.thread.join(timeout=2)


class AgentRuntime:
    def __init__(self, config_path: Path, config: dict):
        self.config_path = config_path
        self.config = config
        self.state_dir = Path(config.get("stateDir") or DEFAULT_STATE_DIR)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.guard = PathGuard(
            list(config.get("writableRoots") or config.get("allowedRoots") or []),
            str(config.get("accessMode") or "scoped"),
        )
        self.processes = ProcessRegistry(self.state_dir)
        self.transfers = TransferManager(self.state_dir, self.guard)
        self.ws: WebSocketClient | None = None
        self.watches = WatchManager(self.guard, self.send_event)
        self.restart_requested = False
        self.request_slots = threading.BoundedSemaphore(16)
        self.request_threads: set[threading.Thread] = set()
        self.request_threads_lock = threading.Lock()

    def send_event(self, event: dict) -> None:
        if not self.ws:
            return
        try:
            self.ws.send_json({"type": "event", **{key: value for key, value in event.items() if key != "sequence"}})
        except Exception:
            pass

    def hello(self, enrollment_token: str | None = None) -> dict:
        value = {
            "type": "hello",
            "protocol": PROTOCOL_VERSION,
            "agentVersion": AGENT_VERSION,
            "hostname": socket.gethostname(),
            "platform": f"linux-{os.uname().machine}",
            "capabilities": {
                "filesystem": True,
                "processes": True,
                "pty": True,
                "fileWatch": True,
                "git": shutil.which("git") is not None,
                "gpu": shutil.which("nvidia-smi") is not None,
                "chunkedTransfer": True,
                "deltaTransfer": True,
                "compression": "gzip",
                "autoUpdate": True,
                "persistentProcesses": True,
            },
            "metadata": {"python": sys.version.split()[0], "uid": os.getuid(), "user": os.environ.get("USER")},
        }
        if enrollment_token:
            value["enrollmentToken"] = enrollment_token
        else:
            value["agentId"] = self.config.get("agentId")
            value["agentSecret"] = self.config.get("agentSecret")
        return value

    def connect(self, server: str, enrollment_token: str | None = None) -> dict:
        ws = WebSocketClient(server)
        ws.connect()
        self.ws = ws
        ws.send_json(self.hello(enrollment_token))
        ack = ws.recv_json()
        if ack.get("type") != "hello_ack":
            raise ConnectionError(f"Unexpected DevSpace hello response: {ack.get('type')}")
        if int(ack.get("protocol", 0)) != PROTOCOL_VERSION:
            raise ConnectionError("DevSpace remote-agent protocol mismatch.")
        if ack.get("agentSecret"):
            self.config["agentId"] = ack["agentId"]
            self.config["agentSecret"] = ack["agentSecret"]
            self.config["accessMode"] = ack.get("accessMode") or self.config.get("accessMode") or "scoped"
            self.config["writableRoots"] = ack.get("writableRoots") if ack.get("writableRoots") is not None else (ack.get("allowedRoots") or self.config.get("writableRoots") or self.config.get("allowedRoots") or [])
            self.config["allowedRoots"] = list(self.config["writableRoots"])
            if ack.get("installRoot"):
                self.config["installRoot"] = ack["installRoot"]
            self.guard.configure(list(self.config["writableRoots"]), str(self.config["accessMode"]))
            atomic_json(self.config_path, self.config)
            try:
                ws.send_json({"type": "enrollment_confirm", "agentId": ack["agentId"]})
            except (ConnectionError, OSError, ssl.SSLError):
                # The durable Agent credentials are already fsynced locally. The
                # control plane retains a short recovery window and will prune it.
                pass
        return ack

    def serve(self) -> None:
        servers = list(self.config.get("servers") or ([self.config.get("server")] if self.config.get("server") else []))
        if not servers:
            raise ValueError("Agent config has no DevSpace server URL.")
        delay = 1.0
        while True:
            for server in servers:
                try:
                    self.connect(str(server))
                    delay = 1.0
                    self.request_loop()
                except KeyboardInterrupt:
                    raise
                except Exception as error:
                    print(f"devspace-agent connection failed for {server}: {error}", file=sys.stderr, flush=True)
                finally:
                    if self.ws:
                        self.ws.close()
                        self.ws = None
                if self.restart_requested:
                    self._restart_self()
            time.sleep(delay)
            delay = min(delay * 2.0, 30.0)

    def request_loop(self) -> None:
        assert self.ws is not None
        while True:
            message = self.ws.recv_json()
            if message.get("type") != "request":
                continue
            if not self.request_slots.acquire(timeout=30):
                self.ws.send_json({"type": "response", "id": str(message.get("id")), "ok": False, "error": "Remote Agent concurrent RPC limit is busy."})
                continue
            thread = threading.Thread(target=self._handle_request, args=(message,), daemon=True, name="devspace-rpc")
            with self.request_threads_lock:
                self.request_threads.add(thread)
            thread.start()

    def _handle_request(self, message: dict) -> None:
        request_id = str(message.get("id"))
        method = str(message.get("method"))
        params = message.get("params") or {}
        try:
            result = self.dispatch(method, params)
            if self.ws:
                self.ws.send_json({"type": "response", "id": request_id, "ok": True, "result": result})
        except Exception as error:
            if self.ws:
                try:
                    self.ws.send_json({"type": "response", "id": request_id, "ok": False, "error": f"{type(error).__name__}: {error}"})
                except Exception:
                    pass
        finally:
            self.request_slots.release()
            current = threading.current_thread()
            with self.request_threads_lock:
                self.request_threads.discard(current)
        if self.restart_requested:
            threading.Timer(0.5, self._restart_self).start()

    def dispatch(self, method: str, params: dict):
        handlers = {
            "workspace.inspect": self.workspace_inspect,
            "workspace.createWorktree": self.workspace_create_worktree,
            "fs.stat": self.fs_stat,
            "fs.capture": self.fs_capture,
            "fs.restore": self.fs_restore,
            "fs.read": self.fs_read,
            "fs.readChunk": self.fs_read_chunk,
            "fs.write": self.fs_write,
            "fs.edit": self.fs_edit,
            "fs.remove": self.fs_remove,
            "fs.rename": self.fs_rename,
            "fs.mkdir": self.fs_mkdir,
            "fs.list": self.fs_list,
            "fs.prepareWrite": self.transfers.prepare,
            "fs.writeChunk": self.transfers.write_chunk,
            "fs.commitWrite": self.transfers.commit,
            "search.grep": self.search_grep,
            "search.glob": self.search_glob,
            "shell.run": self.shell_run,
            "process.start": lambda value: self.processes.start(value, self.guard),
            "process.write": self.processes.write,
            "process.list": self.processes.list,
            "process.attach": self.processes.attach,
            "process.kill": self.processes.kill,
            "watch.start": self.watches.start,
            "watch.poll": self.watches.poll,
            "watch.stop": self.watches.stop,
            "watch.list": self.watches.list,
            "system.status": self.system_status,
            "agent.selfUpdate": self.agent_self_update,
        }
        handler = handlers.get(method)
        if not handler:
            raise KeyError(f"Unsupported remote RPC method: {method}")
        return handler(params)

    def workspace_inspect(self, params: dict) -> dict:
        root = self.guard.workspace_root(str(params["path"]))
        loaded, available = project_context(root, self.guard)
        return {"root": root, "title": os.path.basename(root) or root, "git": git_metadata(root), "agentsFiles": loaded, "availableAgentsFiles": available}

    def workspace_create_worktree(self, params: dict) -> dict:
        source = self.guard.workspace_root(str(params["path"]))
        if not shutil.which("git"):
            raise RuntimeError("git is required for remote worktree mode.")
        top = git(["rev-parse", "--show-toplevel"], source, check=True).stdout.strip()
        top = self.guard.workspace_root(top)
        allowed = self.guard.owning_allowed_root(top)
        worktree_root = os.path.join(allowed, ".devspace-worktrees")
        os.makedirs(worktree_root, exist_ok=True)
        target = os.path.join(worktree_root, f"{os.path.basename(top)}-{secrets.token_hex(6)}")
        base_ref = str(params.get("baseRef") or "HEAD")
        dirty = bool(git(["status", "--porcelain"], top).stdout.strip())
        base_sha = git(["rev-parse", base_ref], top, check=True).stdout.strip()
        result = git(["worktree", "add", "--detach", target, base_sha], top)
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or "git worktree add failed")
        loaded, available = project_context(target, self.guard)
        return {
            "root": target,
            "title": os.path.basename(top),
            "git": git_metadata(target),
            "sourceRoot": top,
            "worktree": {"path": target, "baseRef": base_ref, "baseSha": base_sha, "dirtySource": dirty, "detached": True, "managed": True},
            "agentsFiles": loaded,
            "availableAgentsFiles": available,
        }

    def _target(self, params: dict) -> tuple[str, str]:
        root = self.guard.workspace_root(str(params["root"]))
        return root, self.guard.absolute(root, str(params.get("path") or "."))

    def fs_stat(self, params: dict) -> dict:
        _root, target = self._target(params)
        try:
            info = os.lstat(target)
        except FileNotFoundError:
            return {"exists": False, "type": "missing", "size": 0}
        kind = "symlink" if statmod.S_ISLNK(info.st_mode) else "file" if statmod.S_ISREG(info.st_mode) else "directory" if statmod.S_ISDIR(info.st_mode) else "special"
        return {"exists": True, "type": kind, "size": info.st_size, "mtimeMs": info.st_mtime_ns / 1_000_000.0, "mode": info.st_mode & 0o7777}

    def fs_capture(self, params: dict) -> dict:
        _root, target = self._target(params)
        try:
            info = os.lstat(target)
        except FileNotFoundError:
            return {"descriptor": {"exists": False, "type": "missing", "stored": True}}
        if statmod.S_ISLNK(info.st_mode):
            link = os.readlink(target)
            return {"descriptor": {"exists": True, "type": "symlink", "linkTarget": link, "stored": True, "size": len(link.encode()), "mtimeMs": info.st_mtime_ns / 1_000_000.0}}
        if not statmod.S_ISREG(info.st_mode):
            return {"descriptor": {"exists": True, "type": "directory" if statmod.S_ISDIR(info.st_mode) else "special", "stored": False, "size": info.st_size, "mtimeMs": info.st_mtime_ns / 1_000_000.0, "reason": "unsupported-file-type"}}
        with open(target, "rb") as handle:
            first = handle.read(min(info.st_size, SAMPLE_BYTES))
            if info.st_size > SAMPLE_BYTES:
                handle.seek(max(0, info.st_size - SAMPLE_BYTES))
                last = handle.read(SAMPLE_BYTES)
            else:
                last = b""
        sampled = hashlib.sha256(str(info.st_size).encode() + first + last).hexdigest()
        descriptor = {"exists": True, "type": "file", "stored": False, "size": info.st_size, "mtimeMs": info.st_mtime_ns / 1_000_000.0, "sampledHash": sampled, "mode": info.st_mode & 0o7777}
        if info.st_size > MAX_CAPTURE_BYTES:
            descriptor["reason"] = f"file-exceeds-{MAX_CAPTURE_BYTES}-bytes"
            return {"descriptor": descriptor}
        content = Path(target).read_bytes()
        descriptor.update({"sha256": sha256_bytes(content), "text": b"\0" not in content[:65536]})
        return {"descriptor": descriptor, "content": encode_bytes(content)}

    def fs_restore(self, params: dict) -> dict:
        root = self.guard.workspace_root(str(params["root"]))
        target = self.guard.writable(root, str(params.get("path") or "."))
        descriptor = params.get("descriptor") or {}
        if not descriptor.get("exists"):
            if os.path.isdir(target) and not os.path.islink(target):
                shutil.rmtree(target, ignore_errors=True)
            else:
                try:
                    os.unlink(target)
                except FileNotFoundError:
                    pass
            return {"restored": True, "path": params.get("path")}
        os.makedirs(os.path.dirname(target), exist_ok=True)
        if descriptor.get("type") == "symlink":
            link_target = str(descriptor.get("linkTarget") or "")
            resolved_link_target = link_target if os.path.isabs(link_target) else os.path.join(os.path.dirname(target), link_target)
            self.guard.absolute(root, resolved_link_target)
            try:
                if os.path.isdir(target) and not os.path.islink(target):
                    shutil.rmtree(target)
                else:
                    os.unlink(target)
            except FileNotFoundError:
                pass
            os.symlink(link_target, target)
            return {"restored": True, "path": params.get("path")}
        if descriptor.get("type") != "file":
            raise ValueError("Only missing paths, files, and symlinks are restorable.")
        content = decode_bytes(params.get("content"))
        temporary = target + f".devspace-restore-{os.getpid()}-{secrets.token_hex(4)}"
        Path(temporary).write_bytes(content)
        if descriptor.get("mode") is not None:
            os.chmod(temporary, int(descriptor["mode"]) & 0o7777)
        os.replace(temporary, target)
        return {"restored": True, "path": params.get("path"), "bytes": len(content)}

    def fs_read(self, params: dict) -> dict:
        _root, target = self._target(params)
        size = os.path.getsize(target)
        with open(target, "rb") as handle:
            sample = handle.read(65536)
        if b"\0" in sample:
            return {"kind": "binary", "size": size, "truncated": True}
        offset = max(1, int(params.get("offset") or 1))
        requested_limit = params.get("limit")
        line_limit = min(max(1, int(requested_limit or 2000)), MAX_READ_TEXT_LINES)
        selected: list[str] = []
        selected_bytes = 0
        total_lines = 0
        truncated = False
        try:
            with open(target, "r", encoding="utf-8", errors="strict") as handle:
                for number, line in enumerate(handle, 1):
                    total_lines = number
                    if number < offset:
                        continue
                    encoded_length = len(line.encode("utf-8"))
                    if len(selected) >= line_limit or selected_bytes + encoded_length > MAX_READ_TEXT_BYTES:
                        truncated = True
                        break
                    selected.append(line)
                    selected_bytes += encoded_length
        except UnicodeDecodeError:
            return {"kind": "binary", "size": size, "truncated": True}
        return {"kind": "text", "text": "".join(selected), "size": size, "offset": offset, "totalLines": None if truncated else total_lines, "truncated": truncated}

    def fs_read_chunk(self, params: dict) -> dict:
        _root, target = self._target(params)
        offset = max(0, int(params.get("offset") or 0))
        length = max(1, min(int(params.get("length") or TRANSFER_CHUNK_BYTES), TRANSFER_CHUNK_BYTES))
        with open(target, "rb") as handle:
            handle.seek(offset)
            data = handle.read(length)
        return {"offset": offset, "bytes": len(data), "content": encode_bytes(data), "sha256": sha256_bytes(data)}

    def fs_write(self, params: dict) -> dict:
        root = self.guard.workspace_root(str(params["root"]))
        target = self.guard.writable(root, str(params.get("path") or "."))
        content = decode_bytes(params.get("content"))
        expected = params.get("sha256")
        if expected and sha256_bytes(content) != expected:
            raise ValueError("Remote write content hash mismatch.")
        os.makedirs(os.path.dirname(target), exist_ok=True)
        temporary = target + f".devspace-write-{os.getpid()}-{secrets.token_hex(4)}"
        Path(temporary).write_bytes(content)
        if params.get("mode") is not None:
            os.chmod(temporary, int(params["mode"]) & 0o7777)
        os.replace(temporary, target)
        return {"path": params.get("path"), "bytes": len(content), "sha256": sha256_bytes(content), "deltaTransfer": False}

    def fs_edit(self, params: dict) -> dict:
        root = self.guard.workspace_root(str(params["root"]))
        target = self.guard.writable(root, str(params.get("path") or "."))
        original = Path(target).read_text(encoding="utf-8")
        updated = original
        for edit in params.get("edits") or []:
            old = str(edit.get("oldText") or "")
            new = str(edit.get("newText") or "")
            count = updated.count(old)
            if count != 1:
                raise ValueError(f"oldText must match exactly once; matched {count} time(s).")
            updated = updated.replace(old, new, 1)
        temporary = target + f".devspace-edit-{os.getpid()}-{secrets.token_hex(4)}"
        Path(temporary).write_text(updated, encoding="utf-8")
        os.replace(temporary, target)
        return {"path": params.get("path"), "before": original, "after": updated, "edits": len(params.get("edits") or [])}

    def fs_remove(self, params: dict) -> dict:
        root = self.guard.workspace_root(str(params["root"]))
        target = self.guard.writable(root, str(params.get("path") or "."))
        if os.path.isdir(target) and not os.path.islink(target):
            shutil.rmtree(target)
        else:
            try:
                os.unlink(target)
            except FileNotFoundError:
                pass
        return {"removed": True, "path": params.get("path")}

    def fs_rename(self, params: dict) -> dict:
        root = self.guard.workspace_root(str(params["root"]))
        source = self.guard.writable(root, str(params["path"]))
        destination = self.guard.writable(root, str(params["destination"]))
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        os.replace(source, destination)
        return {"path": params.get("destination"), "previousPath": params.get("path")}

    def fs_mkdir(self, params: dict) -> dict:
        root = self.guard.workspace_root(str(params["root"]))
        target = self.guard.writable(root, str(params.get("path") or "."))
        os.makedirs(target, exist_ok=True)
        return {"created": True, "path": params.get("path")}

    def fs_list(self, params: dict) -> dict:
        _root, target = self._target(params)
        entries = []
        names = sorted(os.listdir(target), key=str.lower)
        for name in names[:MAX_LIST_ENTRIES]:
            child = os.path.join(target, name)
            try:
                info = os.lstat(child)
            except OSError:
                continue
            kind = "symlink" if statmod.S_ISLNK(info.st_mode) else "directory" if statmod.S_ISDIR(info.st_mode) else "file" if statmod.S_ISREG(info.st_mode) else "special"
            entries.append({"name": name, "type": kind, "size": info.st_size, "mtimeMs": info.st_mtime_ns / 1_000_000.0})
        return {"path": params.get("path") or ".", "entries": entries, "truncated": len(names) > MAX_LIST_ENTRIES}

    def search_grep(self, params: dict) -> dict:
        root = self.guard.workspace_root(str(params["root"]))
        scope = self.guard.absolute(root, str(params.get("path") or "."))
        pattern = re.compile(str(params["pattern"]))
        include = params.get("include")
        results = []
        inspected = 0

        def candidates():
            if os.path.isfile(scope):
                yield scope
                return
            if not os.path.isdir(scope):
                return
            for current, dirs, files in os.walk(scope):
                dirs[:] = [name for name in dirs if name not in (".git", "node_modules")]
                for name in files:
                    if include and not fnmatch.fnmatch(name, str(include)):
                        continue
                    yield os.path.join(current, name)

        for file in candidates():
            inspected += 1
            if inspected > MAX_GREP_CANDIDATES:
                return {"matches": results, "truncated": True, "candidateLimitReached": True}
            try:
                safe = self.guard.absolute(root, file)
                with open(safe, "r", encoding="utf-8") as handle:
                    for number, line in enumerate(handle, 1):
                        if pattern.search(line):
                            results.append({"path": os.path.relpath(safe, root).replace(os.sep, "/"), "line": number, "text": line.rstrip("\n\r")[:4000]})
                            if len(results) >= MAX_SEARCH_RESULTS:
                                return {"matches": results, "truncated": True}
            except (OSError, UnicodeError, PermissionError):
                continue
        return {"matches": results, "truncated": False}

    def search_glob(self, params: dict) -> dict:
        root = self.guard.workspace_root(str(params["root"]))
        scope = self.guard.absolute(root, str(params.get("path") or "."))
        pattern = str(params["pattern"])
        matches = []
        for value in glob.iglob(os.path.join(scope, pattern), recursive=True):
            try:
                safe = self.guard.absolute(root, value)
            except PermissionError:
                continue
            matches.append(os.path.relpath(safe, root).replace(os.sep, "/"))
            if len(matches) >= MAX_SEARCH_RESULTS:
                return {"matches": sorted(set(matches)), "truncated": True}
        return {"matches": sorted(set(matches)), "truncated": False}

    def shell_run(self, params: dict) -> dict:
        root = self.guard.workspace_root(str(params["root"]))
        cwd = self.guard.absolute(root, str(params.get("cwd") or root))
        timeout = max(1, min(float(params.get("timeout") or 30), 300))
        result = subprocess.run(["/bin/bash", "-lc", str(params["command"])], cwd=cwd, env=os.environ.copy(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, preexec_fn=self.guard.command_preexec_fn())
        return {"output": result.stdout.decode("utf-8", "replace"), "exitCode": result.returncode}

    def system_status(self, _params: dict) -> dict:
        memory = {}
        try:
            for line in Path("/proc/meminfo").read_text().splitlines():
                key, value = line.split(":", 1)
                if key in ("MemTotal", "MemAvailable", "SwapTotal", "SwapFree"):
                    memory[key] = value.strip()
        except OSError:
            pass
        gpus = []
        if shutil.which("nvidia-smi"):
            result = subprocess.run(["nvidia-smi", "--query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu", "--format=csv,noheader,nounits"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
            if result.returncode == 0:
                for line in result.stdout.splitlines():
                    fields = [value.strip() for value in line.split(",")]
                    if len(fields) >= 6:
                        gpus.append({"index": fields[0], "name": fields[1], "memoryTotalMiB": fields[2], "memoryUsedMiB": fields[3], "utilizationPercent": fields[4], "temperatureC": fields[5]})
        return {"hostname": socket.gethostname(), "loadAverage": list(os.getloadavg()), "cpuCount": os.cpu_count(), "memory": memory, "gpus": gpus, "agentVersion": AGENT_VERSION}

    def agent_self_update(self, params: dict) -> dict:
        url = str(params["url"])
        expected = str(params["sha256"])
        with urllib.request.urlopen(url, timeout=60) as response:
            content = response.read(4 * 1024 * 1024)
        if sha256_bytes(content) != expected:
            raise ValueError("Agent update SHA-256 mismatch.")
        target = Path(__file__).resolve()
        temporary = target.with_name(target.name + f".update-{os.getpid()}")
        temporary.write_bytes(content)
        os.chmod(temporary, 0o755)
        os.replace(temporary, target)
        self.restart_requested = True
        return {"updated": True, "version": params.get("version"), "sha256": expected, "restartScheduled": True}

    @staticmethod
    def _restart_self() -> None:
        os.execv(sys.executable, [sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]])

    def close(self) -> None:
        self.watches.close()
        if self.ws:
            self.ws.close()


def enrollment_config(args) -> tuple[Path, dict]:
    config_path = Path(args.config)
    roots = [normalize_root(value) for value in (args.writable_root or [])]
    access_mode = "full-access" if args.access_mode == "full-access" else "scoped"
    if access_mode != "full-access" and not roots:
        raise ValueError("Scoped Remote Agent enrollment requires at least one --writable-root.")
    config = {
        "server": args.server.rstrip("/"),
        "servers": [args.server.rstrip("/")],
        "name": args.name,
        "accessMode": access_mode,
        "writableRoots": roots,
        "allowedRoots": roots,
        "installRoot": args.install_root,
        "stateDir": args.state_dir,
    }
    return config_path, config


def enroll(args) -> int:
    config_path, config = enrollment_config(args)
    runtime = AgentRuntime(config_path, config)
    try:
        last_error = None
        for attempt in range(1, ENROLL_ATTEMPTS + 1):
            try:
                ack = runtime.connect(config["server"], args.token)
                print(json.dumps({"enrolled": True, "agentId": ack.get("agentId"), "name": ack.get("name"), "accessMode": ack.get("accessMode"), "installRoot": ack.get("installRoot"), "writableRoots": ack.get("writableRoots") or ack.get("allowedRoots") or [], "recovered": bool(ack.get("enrollmentRecovered"))}, ensure_ascii=False))
                return 0
            except (ConnectionError, OSError, ssl.SSLError) as error:
                last_error = error
                if runtime.ws:
                    try:
                        runtime.ws.close()
                    except Exception:
                        pass
                    runtime.ws = None
                if attempt >= ENROLL_ATTEMPTS:
                    break
                print(f"DevSpace enrollment attempt {attempt}/{ENROLL_ATTEMPTS} failed: {error}; retrying...", file=sys.stderr, flush=True)
                time.sleep(0.75 * attempt)
        assert last_error is not None
        raise last_error
    finally:
        runtime.close()


def self_test() -> int:
    with tempfile.TemporaryDirectory(prefix="devspace-agent-test-") as raw:
        root = Path(raw)
        config_path = root / "config.json"
        state_dir = root / "state"
        config = {"server": "http://127.0.0.1:1", "accessMode": "scoped", "writableRoots": [str(root)], "allowedRoots": [str(root)], "installRoot": str(root), "stateDir": str(state_dir)}
        runtime = AgentRuntime(config_path, config)
        try:
            project = root / "project"
            project.mkdir()
            (project / "alpha.txt").write_text("alpha\nbeta\n", encoding="utf-8")
            inspected = runtime.workspace_inspect({"path": str(project)})
            assert inspected["root"] == str(project.resolve())
            read = runtime.fs_read({"root": str(project), "path": "alpha.txt", "offset": 2, "limit": 1})
            assert read["text"] == "beta\n"
            capture = runtime.fs_capture({"root": str(project), "path": "alpha.txt"})
            assert capture["descriptor"]["sha256"] == sha256_bytes(b"alpha\nbeta\n")
            runtime.fs_edit({"root": str(project), "path": "alpha.txt", "edits": [{"oldText": "beta", "newText": "gamma"}]})
            assert (project / "alpha.txt").read_text() == "alpha\ngamma\n"
            big = (b"0123456789abcdef" * 100_000)[:1_300_000]
            chunks = []
            for offset in range(0, len(big), TRANSFER_CHUNK_BYTES):
                chunk = big[offset:offset + TRANSFER_CHUNK_BYTES]
                chunks.append({"index": len(chunks), "sha256": sha256_bytes(chunk), "size": len(chunk)})
            prepared = runtime.transfers.prepare({"transferId": "selftest", "root": str(project), "path": "big.bin", "size": len(big), "sha256": sha256_bytes(big), "chunks": chunks})
            assert prepared["missingChunks"] == list(range(len(chunks)))
            for item in chunks:
                start = item["index"] * TRANSFER_CHUNK_BYTES
                runtime.transfers.write_chunk({"transferId": "selftest", "index": item["index"], "sha256": item["sha256"], "content": encode_bytes(big[start:start + item["size"]])})
            runtime.transfers.commit({"transferId": "selftest"})
            assert (project / "big.bin").read_bytes() == big
            process = runtime.processes.start({"root": str(project), "workspaceId": "ws_test", "argv": [sys.executable, "-c", "print('remote-process-ok')"], "yieldTimeMs": 3000}, runtime.guard)
            assert process["exitCode"] == 0 and "remote-process-ok" in process["output"]
            status = runtime.system_status({})
            assert status["agentVersion"] == AGENT_VERSION
            print(json.dumps({"passed": True, "filesystem": True, "deltaTransfer": True, "processes": True, "pathGuard": True, "status": True}))
            return 0
        finally:
            runtime.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="DevSpace Linux Remote Workspace Agent")
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    subparsers = parser.add_subparsers(dest="command")
    enroll_parser = subparsers.add_parser("enroll", help="Enroll this Linux host with a Windows DevSpace control plane")
    enroll_parser.add_argument("--server", required=True)
    enroll_parser.add_argument("--token", required=True)
    enroll_parser.add_argument("--name", required=True)
    enroll_parser.add_argument("--writable-root", "--allowed-root", dest="writable_root", action="append")
    enroll_parser.add_argument("--access-mode", choices=("scoped", "full-access"), default="scoped")
    enroll_parser.add_argument("--install-root")
    enroll_parser.add_argument("--state-dir", default=DEFAULT_STATE_DIR)
    enroll_parser.add_argument("--config", default=DEFAULT_CONFIG)
    subparsers.add_parser("run", help="Run the persistent outbound agent")
    subparsers.add_parser("self-test", help="Run dependency-free local agent regression tests")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if args.command == "self-test":
        return self_test()
    if args.command == "enroll":
        return enroll(args)
    config_path = Path(args.config)
    config = read_json(config_path, None)
    if not isinstance(config, dict):
        parser.error(f"Agent config not found or invalid: {config_path}")
    runtime = AgentRuntime(config_path, config)
    try:
        runtime.serve()
    except KeyboardInterrupt:
        return 130
    finally:
        runtime.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
