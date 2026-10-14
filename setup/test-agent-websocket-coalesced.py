"""Test the real Linux WebSocketClient implementation without importing Linux-only pty APIs.

Mocks only the remote WebSocket peer. Test fixtures live entirely in memory
and bind exclusively to 127.0.0.1; no remote server or saved credential used.
"""

from __future__ import annotations

import ast
import base64
import hashlib
import json
import os
import socket
import ssl
import struct
import threading
import urllib.parse
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "vendor/waishnav-devspace/dist/linux-agent/devspace-agent.py"
tree = ast.parse(SOURCE.read_text(encoding="utf8"), filename=str(SOURCE))
websocket_class = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "WebSocketClient")
namespace = {"MAX_MESSAGE_BYTES": 8 * 1024 * 1024,
             "base64": base64, "hashlib": hashlib, "json": json,
             "os": os, "socket": socket, "ssl": ssl,
             "struct": struct, "threading": threading,
             "urllib": urllib}
exec(compile(ast.Module(body=[websocket_class], type_ignores=[]), str(SOURCE), "exec"), namespace)
WebSocketClient = namespace["WebSocketClient"]


def web_socket_frame(value: dict) -> bytes:
    payload = json.dumps(value).encode("utf8")
    assert len(payload) < 126
    return bytes((0x81, len(payload))) + payload


def one_peer(case: str) -> None:
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    listener.settimeout(5)
    port = listener.getsockname()[1]
    errors = []
    expected = {"type": "hello_ack", "agentId": "unit-test"}

    def peer() -> None:
        try:
            conn, _ = listener.accept()
            with conn:
                conn.settimeout(3)
                request = bytearray()
                while b"\r\n\r\n" not in request:
                    request.extend(conn.recv(4096))
                key = next(line.split(":", 1)[1].strip() for line in request.decode().split("\r\n")
                           if line.lower().startswith("sec-websocket-key:"))
                accept = base64.b64encode(hashlib.sha1(
                    (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
                header = b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + b"\r\n\r\n"
                frame = web_socket_frame(expected)
                if case == "coalesced":
                    conn.sendall(header + frame)
                elif case == "partial":
                    conn.sendall(header + frame[:1])
                    conn.sendall(frame[1:])
                elif case == "normal":
                    conn.sendall(header)
                    conn.sendall(frame)
                elif case == "bad-accept":
                    conn.sendall(header.replace(accept, b"wrong"))
                else:
                    raise AssertionError(case)
        except Exception as error:
            errors.append(error)
        finally:
            listener.close()

    thread = threading.Thread(target=peer, daemon=True)
    thread.start()
    client = WebSocketClient(f"ws://127.0.0.1:{port}")
    try:
        if case == "bad-accept":
            try:
                client.connect(timeout=3)
            except ConnectionError as error:
                assert "invalid Sec-WebSocket-Accept" in str(error)
            else:
                raise AssertionError("An invalid challenge response must fail closed")
        else:
            client.connect(timeout=3)
            assert client.socket.gettimeout() == 75.0
            assert client.recv_json() == expected
    finally:
        client.close()
        thread.join(timeout=5)
    assert not thread.is_alive(), "loopback WebSocket peer did not exit"
    assert not errors, errors


for scenario in ("normal", "coalesced", "partial", "bad-accept"):
    one_peer(scenario)

print(json.dumps({"regularHandshake": True, "coalesced101AndFirstFrame": True,
                  "fragmentedFrameAfter101": True, "invalidAcceptRejected": True,
                  "idleReceiveTimeoutSeconds": 75}))
