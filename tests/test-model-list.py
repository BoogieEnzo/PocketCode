#!/usr/bin/env python3
"""
Test: spawn Claude Code TUI in a pty, send /model command, capture and parse output.
"""
import pty
import os
import select
import time
import re
import subprocess
import sys

TIMEOUT_STARTUP = 5   # seconds to wait for claude to initialize
TIMEOUT_RESPONSE = 3  # seconds to wait after sending /model


def read_available(fd, timeout=0.3):
    """Drain all currently available bytes from fd."""
    chunks = []
    while True:
        r, _, _ = select.select([fd], [], [], timeout)
        if r:
            try:
                data = os.read(fd, 4096)
                if not data:
                    break
                chunks.append(data)
            except OSError:
                break
        else:
            break
    return b''.join(chunks)


def strip_ansi(data: bytes) -> str:
    # Remove ANSI escape sequences (colors, cursor movement, etc.)
    ansi = re.compile(rb'\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07)')
    clean = ansi.sub(b'', data)
    clean = clean.replace(b'\r', b'')
    return clean.decode('utf-8', errors='replace')


def run(cmd: list[str], command_to_send: str):
    print(f"[*] Spawning: {' '.join(cmd)}", flush=True)
    master_fd, slave_fd = pty.openpty()

    proc = subprocess.Popen(
        cmd,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
    )
    os.close(slave_fd)

    all_raw = b''

    print(f"[*] Waiting {TIMEOUT_STARTUP}s for startup...", flush=True)
    time.sleep(TIMEOUT_STARTUP)
    chunk = read_available(master_fd)
    all_raw += chunk
    print(f"[startup output] {len(chunk)} bytes", flush=True)

    print(f"[*] Sending: {repr(command_to_send)}", flush=True)
    os.write(master_fd, (command_to_send + '\n').encode())

    time.sleep(TIMEOUT_RESPONSE)
    chunk = read_available(master_fd)
    all_raw += chunk
    print(f"[response output] {len(chunk)} bytes", flush=True)

    proc.terminate()
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        proc.kill()
    os.close(master_fd)

    return all_raw


def parse_models_from_text(text: str) -> list[str]:
    """
    Try to extract model names from stripped TUI output.
    Claude Code model names follow: claude-{family}-{version}
    Codex models follow: o3, o4-mini, gpt-* etc.
    """
    # Claude-style model names
    claude_models = re.findall(r'claude-[\w.-]+', text)
    # OpenAI-style model names
    openai_models = re.findall(r'\b(?:o\d[\w-]*|gpt-[\w.-]+)\b', text)

    seen = set()
    result = []
    for m in claude_models + openai_models:
        if m not in seen:
            seen.add(m)
            result.append(m)
    return result


if __name__ == '__main__':
    tool = sys.argv[1] if len(sys.argv) > 1 else 'claude'
    cmd = [tool]

    raw = run(cmd, '/model')
    text = strip_ansi(raw)

    print("\n=== RAW (hex preview, first 2000 bytes) ===")
    print(raw[:2000].hex())

    print("\n=== STRIPPED TEXT ===")
    print(text[:3000])

    models = parse_models_from_text(text)
    print("\n=== PARSED MODELS ===")
    for m in models:
        print(f"  {m}")

    if not models:
        print("  (none found — may need to adjust parsing or timing)")
