"""
CRYTDL — a tiny, self-contained YouTube downloader.

Architecture
------------
- Flask serves a single-page UI (static/index.html) and a small JSON API.
- yt-dlp does the heavy lifting (URL parsing, format selection, downloading).
- ffmpeg (kept in ./bin) muxes video+audio for MP4 and converts to MP3.
- Each download runs in a worker thread; progress lives in an in-memory dict
  that the frontend polls. Files are written to ./downloads.

Everything that gets installed lives inside this folder (the .venv,
the ffmpeg binary, and the downloaded files), so deleting the folder
deletes all traces of the project.
"""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
import uuid
import webbrowser
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request, send_file, send_from_directory
import yt_dlp


ROOT = Path(__file__).resolve().parent
DOWNLOADS = ROOT / "downloads"
BIN = ROOT / "bin"
HISTORY_FILE = ROOT / "downloads" / ".history.json"

DOWNLOADS.mkdir(exist_ok=True)


def ffmpeg_path() -> str | None:
    """Prefer the locally bundled ffmpeg, fall back to one on PATH."""
    local = BIN / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    if local.exists():
        return str(local)
    found = shutil.which("ffmpeg")
    return found


app = Flask(__name__, static_folder="static", static_url_path="")


# ---------------------------------------------------------------------------
# Job tracking
# ---------------------------------------------------------------------------

# job_id -> dict with progress fields
jobs: dict[str, dict[str, Any]] = {}
jobs_lock = threading.Lock()


def update_job(job_id: str, **fields: Any) -> None:
    with jobs_lock:
        if job_id in jobs:
            jobs[job_id].update(fields)


def new_job(url: str, fmt: str) -> str:
    job_id = uuid.uuid4().hex[:12]
    with jobs_lock:
        jobs[job_id] = {
            "id": job_id,
            "url": url,
            "format": fmt,
            "status": "queued",
            "percent": 0.0,
            "speed": "",
            "eta": "",
            "downloaded_bytes": 0,
            "total_bytes": 0,
            "title": "",
            "thumbnail": "",
            "uploader": "",
            "filename": None,
            "error": None,
            "created_at": time.time(),
        }
    return job_id


# ---------------------------------------------------------------------------
# History (persisted across restarts)
# ---------------------------------------------------------------------------

def load_history() -> list[dict[str, Any]]:
    if not HISTORY_FILE.exists():
        return []
    try:
        return json.loads(HISTORY_FILE.read_text())
    except Exception:
        return []


def save_history(items: list[dict[str, Any]]) -> None:
    HISTORY_FILE.write_text(json.dumps(items, indent=2))


def append_history(entry: dict[str, Any]) -> None:
    items = load_history()
    items.insert(0, entry)
    items = items[:200]  # cap
    save_history(items)


# ---------------------------------------------------------------------------
# Download worker
# ---------------------------------------------------------------------------

def build_ydl_opts(job_id: str, settings: dict[str, Any]) -> dict[str, Any]:
    """Translate UI settings into a yt-dlp options dict."""
    fmt = settings.get("format", "mp4")
    quality = settings.get("quality", "best")
    embed_thumb = bool(settings.get("embed_thumbnail", False))
    embed_meta = bool(settings.get("embed_metadata", True))
    embed_subs = bool(settings.get("embed_subs", False))

    def hook(d: dict[str, Any]) -> None:
        status = d.get("status")
        if status == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            done = d.get("downloaded_bytes") or 0
            percent = (done / total * 100) if total else 0.0
            update_job(
                job_id,
                status="downloading",
                percent=round(percent, 1),
                speed=_human_speed(d.get("speed")),
                eta=_human_eta(d.get("eta")),
                downloaded_bytes=done,
                total_bytes=total,
            )
        elif status == "finished":
            # The download itself is done; postprocessing (mux/convert) follows.
            update_job(job_id, status="processing", percent=99.0)

    opts: dict[str, Any] = {
        "outtmpl": str(DOWNLOADS / "%(title).200B [%(id)s].%(ext)s"),
        "restrictfilenames": False,
        "windowsfilenames": True,  # safer cross-platform names
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [hook],
        "retries": 5,
        "fragment_retries": 5,
        "concurrent_fragment_downloads": 4,
    }

    ff = ffmpeg_path()
    if ff:
        opts["ffmpeg_location"] = ff

    postprocessors: list[dict[str, Any]] = []

    if fmt == "mp3":
        opts["format"] = "bestaudio/best"
        audio_q = str(quality) if str(quality).isdigit() else "192"
        postprocessors.append({
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": audio_q,
        })
        if embed_thumb:
            opts["writethumbnail"] = True
            postprocessors.append({"key": "FFmpegThumbnailsConvertor", "format": "jpg"})
            postprocessors.append({"key": "EmbedThumbnail"})
    else:  # mp4
        if quality == "best":
            opts["format"] = (
                "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"
            )
        else:
            h = int(quality)
            opts["format"] = (
                f"bestvideo[height<={h}][ext=mp4]+bestaudio[ext=m4a]/"
                f"best[height<={h}][ext=mp4]/best[height<={h}]/best"
            )
        opts["merge_output_format"] = "mp4"
        if embed_thumb:
            opts["writethumbnail"] = True
            postprocessors.append({"key": "EmbedThumbnail"})
        if embed_subs:
            opts["writesubtitles"] = True
            opts["writeautomaticsub"] = True
            opts["subtitleslangs"] = ["en.*"]
            postprocessors.append({
                "key": "FFmpegEmbedSubtitle",
                "already_have_subtitle": False,
            })

    if embed_meta:
        postprocessors.append({"key": "FFmpegMetadata", "add_metadata": True})

    if postprocessors:
        opts["postprocessors"] = postprocessors

    return opts


def _human_speed(b_per_s: float | None) -> str:
    if not b_per_s:
        return ""
    units = ["B/s", "KB/s", "MB/s", "GB/s"]
    v = float(b_per_s)
    i = 0
    while v >= 1024 and i < len(units) - 1:
        v /= 1024
        i += 1
    return f"{v:.1f} {units[i]}"


def _human_eta(secs: float | None) -> str:
    if not secs or secs < 0:
        return ""
    secs = int(secs)
    m, s = divmod(secs, 60)
    h, m = divmod(m, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def run_download(job_id: str, settings: dict[str, Any]) -> None:
    url = settings["url"]
    opts = build_ydl_opts(job_id, settings)

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)

            # Some URLs (channels, mixes) may return a playlist envelope despite
            # noplaylist=True. Normalize to a single info dict.
            if "entries" in info and info["entries"]:
                info = info["entries"][0]

            update_job(
                job_id,
                title=info.get("title", ""),
                uploader=info.get("uploader", ""),
                thumbnail=info.get("thumbnail", ""),
            )

            base = ydl.prepare_filename(info)
            target_ext = "mp3" if settings.get("format") == "mp3" else "mp4"
            final = Path(base).with_suffix("." + target_ext)
            if not final.exists():
                # Fallback: search the downloads dir for something matching.
                stem = Path(base).stem
                for p in DOWNLOADS.iterdir():
                    if p.stem == stem and p.suffix.lower().endswith(target_ext):
                        final = p
                        break

            update_job(
                job_id,
                status="completed",
                percent=100.0,
                filename=final.name,
            )

            append_history({
                "id": job_id,
                "title": info.get("title", ""),
                "uploader": info.get("uploader", ""),
                "thumbnail": info.get("thumbnail", ""),
                "filename": final.name,
                "format": settings.get("format"),
                "url": url,
                "size_bytes": final.stat().st_size if final.exists() else 0,
                "completed_at": time.time(),
            })

    except Exception as e:  # noqa: BLE001 — we want to surface anything to UI
        update_job(job_id, status="error", error=str(e))


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/api/info", methods=["POST"])
def api_info():
    data = request.get_json(force=True)
    url = (data.get("url") or "").strip()
    if not url:
        return jsonify({"error": "missing url"}), 400
    try:
        with yt_dlp.YoutubeDL({
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "noplaylist": True,
        }) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 400

    if "entries" in info and info["entries"]:
        info = info["entries"][0]

    return jsonify({
        "title": info.get("title"),
        "uploader": info.get("uploader"),
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "view_count": info.get("view_count"),
        "upload_date": info.get("upload_date"),
    })


@app.route("/api/download", methods=["POST"])
def api_download():
    data = request.get_json(force=True)
    url = (data.get("url") or "").strip()
    if not url:
        return jsonify({"error": "missing url"}), 400

    job_id = new_job(url, data.get("format", "mp4"))
    t = threading.Thread(target=run_download, args=(job_id, data), daemon=True)
    t.start()
    return jsonify({"job_id": job_id})


@app.route("/api/jobs")
def api_jobs():
    with jobs_lock:
        # Newest first
        items = sorted(jobs.values(), key=lambda j: j["created_at"], reverse=True)
    return jsonify(items)


@app.route("/api/jobs/<job_id>")
def api_job(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "not found"}), 404
    return jsonify(job)


@app.route("/api/file/<job_id>")
def api_file(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
    if not job or not job.get("filename"):
        return jsonify({"error": "not found"}), 404
    path = DOWNLOADS / job["filename"]
    if not path.exists():
        return jsonify({"error": "file missing"}), 404
    return send_file(path, as_attachment=True, download_name=path.name)


@app.route("/api/history")
def api_history():
    return jsonify(load_history())


@app.route("/api/history/<entry_id>", methods=["DELETE"])
def api_history_delete(entry_id: str):
    items = load_history()
    keep = []
    removed = None
    for it in items:
        if it["id"] == entry_id:
            removed = it
        else:
            keep.append(it)
    save_history(keep)
    if removed:
        try:
            (DOWNLOADS / removed["filename"]).unlink(missing_ok=True)
        except Exception:
            pass
    return jsonify({"ok": True})


@app.route("/api/health")
def api_health():
    return jsonify({
        "ok": True,
        "ffmpeg": ffmpeg_path() or None,
        "yt_dlp": yt_dlp.version.__version__,
    })


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def main() -> None:
    port = int(os.environ.get("CRYTDL_PORT", "5151"))
    host = os.environ.get("CRYTDL_HOST", "127.0.0.1")
    url = f"http://{host}:{port}"
    print(f"\n  CRYTDL → {url}\n")
    if os.environ.get("CRYTDL_NO_BROWSER") != "1":
        try:
            threading.Timer(0.8, lambda: webbrowser.open(url)).start()
        except Exception:
            pass
    app.run(host=host, port=port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
