#!/usr/bin/env python3
"""Resident Kokoro-82M server — loads the model once and serves synthesis
requests over a local Unix socket until idle for ATLAS_VOICE_KOKORO_IDLE_MS.

Never run this by hand: `kokoro_client.py` spawns it on the first English
utterance after a cold start (or after a prior idle exit) and talks to it for
every call after that — see this addon's README, "Kokoro daemon". A fresh
`ATLAS_VOICE_TTS_CMD` subprocess still runs per call (that contract, and the
German/piper path, are unchanged); this process just outlives that subprocess
and keeps the ~1s ONNX graph load off every call after the first.

Mirrors addons/semantic-search's ATLAS_EMBED_IDLE_MS idiom — spin up on
demand, stay warm, evict yourself when nobody's asking — the difference here
is a process boundary instead of a worker thread: a Python model can't live
inside the Node.js API process the way semantic-search's encoder does.

Protocol, deliberately minimal (no HTTP parsing, stdlib only):
  request:  4-byte big-endian length, then that many UTF-8 text bytes
  response: 1 status byte (0 ok, 1 error), 4-byte big-endian length, then
            that many bytes (WAV audio, or a UTF-8 error message)
One request per connection, handled serially — the model is one copy, exactly
like every other engine in this addon runs one utterance at a time.
"""
import fcntl
import os
import signal
import socket
import struct
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tts_kokoro  # noqa: E402

MAX_TEXT_BYTES = 20000  # a sane bound; a spoken reply is a sentence or two
ACCEPT_POLL_S = 1.0  # how often the idle-timeout is checked while otherwise blocked


def idle_ms():
    return int(os.environ.get("ATLAS_VOICE_KOKORO_IDLE_MS", 600000))  # 10 min


def sock_path():
    return os.environ.get("ATLAS_VOICE_KOKORO_SOCK") or os.path.join(tts_kokoro.state_dir(), "kokoro.sock")


def _log(msg):
    # Best-effort only — this process's stdio is redirected to /dev/null by
    # the client that spawns it, so this is for anyone tailing it by hand.
    try:
        print(f"[kokoro-daemon] {msg}", file=sys.stderr, flush=True)
    except OSError:
        pass


def _acquire_lock(lock_path):
    """Exclusive, non-blocking. Held for the life of this process (returning
    the open fd keeps it alive) — a second daemon racing to start finds it
    held and exits immediately rather than fighting over the socket file."""
    f = open(lock_path, "w")
    try:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.close()
        return None
    return f


def _recv_exact(conn, n):
    buf = b""
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def _reply_error(conn, message):
    body = str(message).encode("utf-8", "replace")[:2000]
    conn.sendall(b"\x01" + struct.pack(">I", len(body)) + body)


def _handle_one(conn):
    conn.settimeout(30)
    header = _recv_exact(conn, 4)
    if header is None:
        return
    (length,) = struct.unpack(">I", header)
    if length > MAX_TEXT_BYTES:
        _reply_error(conn, f"text exceeds {MAX_TEXT_BYTES} bytes")
        return
    raw = _recv_exact(conn, length)
    if raw is None:
        return
    try:
        audio = tts_kokoro.synth(raw.decode("utf-8"))
        conn.sendall(b"\x00" + struct.pack(">I", len(audio)) + audio)
    except Exception as e:  # noqa: BLE001 - report to the client, don't crash the daemon
        _reply_error(conn, e)


def serve():
    path = sock_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)

    lock = _acquire_lock(path + ".lock")
    if lock is None:
        _log("another daemon already holds the lock — exiting")
        return 0

    if os.path.exists(path):
        os.remove(path)  # the lock guarantees any leftover file is stale
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(path)
    os.chmod(path, 0o600)
    srv.listen(8)
    srv.settimeout(ACCEPT_POLL_S)

    stop = [False]
    signal.signal(signal.SIGTERM, lambda *_: stop.__setitem__(0, True))

    timeout_s = idle_ms() / 1000.0 if idle_ms() > 0 else None
    last_activity = time.monotonic()
    _log(f"listening on {path} (idle timeout {idle_ms()}ms)")

    try:
        while not stop[0]:
            try:
                conn, _ = srv.accept()
            except socket.timeout:
                if timeout_s is not None and (time.monotonic() - last_activity) > timeout_s:
                    _log(f"idle for {idle_ms()}ms — exiting")
                    break
                continue
            try:
                _handle_one(conn)
            finally:
                conn.close()
            last_activity = time.monotonic()
    finally:
        srv.close()
        try:
            os.remove(path)
        except OSError:
            pass
        lock.close()
        try:
            os.remove(path + ".lock")
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(serve())
