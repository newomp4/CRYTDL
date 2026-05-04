"""Download a static ffmpeg binary into ./bin so the app is self-contained.

Picks the right build per platform. Used by setup.sh on first run; you can
also run it manually if the binary ever goes missing or you want to refresh.
"""

from __future__ import annotations

import os
import platform
import shutil
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BIN = ROOT / "bin"
BIN.mkdir(exist_ok=True)


def target() -> Path:
    return BIN / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")


def have_ffmpeg() -> bool:
    p = target()
    return p.exists() and p.stat().st_size > 1_000_000


def download(url: str, dest: Path) -> None:
    print(f"  ↓ {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)


def install_macos() -> None:
    url = "https://evermeet.cx/ffmpeg/getrelease/zip"
    archive = BIN / "_ffmpeg.zip"
    download(url, archive)
    with zipfile.ZipFile(archive) as z:
        z.extract("ffmpeg", BIN)
    archive.unlink()
    os.chmod(target(), 0o755)


def install_linux() -> None:
    machine = platform.machine().lower()
    if "aarch64" in machine or "arm64" in machine:
        url = "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz"
    else:
        url = "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
    archive = BIN / "_ffmpeg.tar.xz"
    download(url, archive)
    with tarfile.open(archive) as t:
        for member in t.getmembers():
            if member.name.endswith("/ffmpeg") and not member.isdir():
                member.name = "ffmpeg"
                t.extract(member, BIN)
                break
    archive.unlink()
    os.chmod(target(), 0o755)


def install_windows() -> None:
    url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
    archive = BIN / "_ffmpeg.zip"
    download(url, archive)
    with zipfile.ZipFile(archive) as z:
        for n in z.namelist():
            if n.endswith("/bin/ffmpeg.exe"):
                with z.open(n) as src, open(target(), "wb") as dst:
                    shutil.copyfileobj(src, dst)
                break
    archive.unlink()


def main() -> None:
    if have_ffmpeg():
        print(f"  ✓ ffmpeg already at {target()}")
        return
    sysname = platform.system()
    print(f"  → installing ffmpeg for {sysname} ({platform.machine()})")
    if sysname == "Darwin":
        install_macos()
    elif sysname == "Linux":
        install_linux()
    elif sysname == "Windows":
        install_windows()
    else:
        print(f"unsupported platform: {sysname}", file=sys.stderr)
        sys.exit(1)
    print(f"  ✓ installed at {target()}")


if __name__ == "__main__":
    main()
