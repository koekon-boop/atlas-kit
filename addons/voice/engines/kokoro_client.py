#!/usr/bin/env python3
"""Thin client for the resident Kokoro daemon (kokoro_daemon.py) — text in,
WAV out, over the daemon's Unix socket. `tts_bilingual.py` calls `synth()`
here instead of `tts_kokoro.synth()` directly for the English leg, so a warm
daemon amortizes the ~1s ONNX graph load across calls instead of paying it on
every `ATLAS_VOICE_TTS_CMD` subprocess.

Auto-recovery, in order: connect to the running daemon; if that fails, start
one (a detached, `setsid`-style process that outlives this short-lived
client) and wait for its socket; if it still can't be reached, or the request
itself errors, degrade to a direct in-process `tts_kokoro.synth()` call — the
exact pre-daemon behavior — rather than fail the reply.

Set ATLAS_VOICE_KOKORO_DAEMON=0 to skip the daemon entirely and always
synthesize in-process (see this addon's README, "Kokoro daemon").
"""
import os
import socket
import struct
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tts_kokoro  # noqa: E402

DAEMON_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kokoro_daemon.py")

# Bounded well under ATLAS_VOICE_TTS_TIMEOUT_MS's 20s default: waiting for the
# socket to exist is fast (binding it needs no model load — see
# kokoro_daemon.py), while a request has to cover the daemon's own cold
# load+synth (~2-4s measured) on the very first call after it starts.
START_TIMEOUT_S = 5.0
REQUEST_TIMEOUT_S = 15.0
POLL_INTERVAL_S = 0.1


def daemon_enabled():
    return os.environ.get("ATLAS_VOICE_KOKORO_DAEMON", "1") != "0"


def sock_path():
    return os.environ.get("ATLAS_VOICE_KOKORO_SOCK") or os.path.join(tts_kokoro.state_dir(), "kokoro.sock")


def _recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def _request_once(path, text):
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(REQUEST_TIMEOUT_S)
    try:
        sock.connect(path)
        payload = text.encode("utf-8")
        sock.sendall(struct.pack(">I", len(payload)) + payload)
        header = _recv_exact(sock, 5)
        if header is None:
            raise OSError("kokoro daemon closed the connection")
        status, length = header[0], struct.unpack(">I", header[1:])[0]
        body = _recv_exact(sock, length) or b""
        if status != 0:
            raise RuntimeError(f"kokoro daemon: {body.decode('utf-8', 'replace')}")
        return body
    finally:
        sock.close()


def _daemon_reachable(path):
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(1.0)
        s.connect(path)
        s.close()
        return True
    except OSError:
        return False


def _spawn_daemon():
    # Detached: this client is itself a fresh subprocess per API call (see
    # engine.mjs), so the daemon has to survive after ITS parent exits —
    # start_new_session puts it in its own session, out of this process's group.
    subprocess.Popen(
        [sys.executable, DAEMON_SCRIPT],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def _wait_for_daemon(path, timeout_s):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if _daemon_reachable(path):
            return True
        time.sleep(POLL_INTERVAL_S)
    return False


def synth(text):
    """`text` -> WAV bytes, via the resident daemon (starting it if needed),
    or a direct in-process load if the daemon can't be reached at all."""
    if not daemon_enabled():
        return tts_kokoro.synth(text)

    path = sock_path()
    try:
        return _request_once(path, text)
    except OSError:
        pass  # not running yet, or it just died/idled out — start it below

    _spawn_daemon()
    if _wait_for_daemon(path, START_TIMEOUT_S):
        try:
            return _request_once(path, text)
        except OSError:
            pass

    # Never reached, or died again immediately — degrade rather than fail
    # the whole reply.
    return tts_kokoro.synth(text)
