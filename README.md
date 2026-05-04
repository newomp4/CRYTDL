# CRYTDL

A tiny, self-contained YouTube downloader with a clean monochrome UI.
Paste a link, pick MP4 or MP3, hit download.

Everything it needs (Python packages, ffmpeg, downloaded files) lives
inside this folder. Delete the folder and nothing remains.

---

## Quick start (macOS / Linux)

```bash
./setup.sh     # one time — creates ./.venv and downloads ffmpeg into ./bin
./start.sh     # launches the app and opens http://127.0.0.1:5151
```

That's it. The first run installs everything; subsequent runs just launch.

> **Windows:** run the equivalent commands manually:
> ```
> python -m venv .venv
> .venv\Scripts\pip install -r requirements.txt
> .venv\Scripts\python setup_ffmpeg.py
> .venv\Scripts\python app.py
> ```

---

## How it works (the simple version)

There are three moving parts:

| Piece | Job |
|---|---|
| **`yt-dlp`** | The Python library that talks to YouTube. It figures out the available video/audio streams, picks the right ones for your chosen quality, and downloads them. |
| **`ffmpeg`** | A tiny universal media tool. It glues the separate video + audio streams into a single MP4, or extracts and re-encodes the audio into MP3. |
| **`Flask`** | A minimal Python web server. It serves the UI (HTML/CSS/JS) and exposes a small JSON API the UI talks to. |

When you click **Download**, the browser POSTs your URL + settings to `/api/download`.
Flask spawns a worker thread, that thread runs yt-dlp, and yt-dlp calls ffmpeg
when it's time to mux video+audio or convert to MP3. While that runs, the UI
polls `/api/jobs` every ~600ms to update the progress bar live.

### Why MP4 needs ffmpeg

YouTube serves video and audio as **separate streams** at higher qualities
(this is how it can offer 1080p video with 256kbps audio without storing every
combination). yt-dlp downloads both streams, then ffmpeg combines them into one
playable MP4 file. That's also why the progress bar briefly says "processing"
at the end — that's the muxing step.

### Why MP3 needs ffmpeg

YouTube doesn't host MP3 files at all. It serves audio as Opus or AAC. To get
an MP3, ffmpeg has to **re-encode** the audio at the bitrate you asked for
(128/192/320 kbps, etc.).

---

## Self-contained by design

Everything this project creates stays inside this folder:

```
CRYTDL/
├── .venv/             ← Python virtual environment (created by setup.sh)
├── bin/ffmpeg         ← static ffmpeg binary (downloaded by setup_ffmpeg.py)
├── downloads/         ← downloaded videos + .history.json
├── static/            ← UI: index.html, style.css, app.js
├── app.py             ← Flask backend
├── setup_ffmpeg.py    ← one-shot ffmpeg installer
├── setup.sh           ← venv + deps + ffmpeg
├── start.sh           ← launcher
├── requirements.txt   ← Python deps (Flask, yt-dlp, mutagen)
└── README.md
```

- No system-wide Python packages installed (everything's in `.venv/`)
- No system-wide ffmpeg installed (it's a single static binary in `./bin/`)
- No registry entries, no Application Support files, nothing in your home dir

**To uninstall completely: just `rm -rf` the folder.**

---

## Settings

| Setting | What it does |
|---|---|
| **MP4 / MP3** | Pick video file or audio-only file. |
| **Quality** | MP4: max resolution to allow (best, 4K, 2K, 1080p, 720p, 480p, 360p). MP3: bitrate (96–320 kbps). |
| **Embed thumbnail** | Saves the video's cover image *into* the file so it shows up as artwork in players. |
| **Embed metadata** | Writes title, uploader, upload date, etc. into the file's tags. On by default. |
| **Embed subtitles** | (MP4 only) Pulls English subtitles if the video has them and bakes them into the file as a subtitle track. |

---

## Configuration

Environment variables (optional):

```bash
CRYTDL_PORT=5151           # change the port
CRYTDL_HOST=127.0.0.1      # change the bind address
CRYTDL_NO_BROWSER=1        # don't auto-open the browser on launch
```

Example: `CRYTDL_PORT=8080 ./start.sh`

---

## Updating

yt-dlp moves fast (YouTube changes its internals frequently). To update:

```bash
.venv/bin/pip install --upgrade yt-dlp
```

If a download starts failing with a "format not available" or extractor error,
that's almost always the fix.

---

## Tech notes

- **No build step.** The frontend is plain HTML/CSS/JS. Open `static/app.js`
  and edit — refresh the page, see the change. No webpack, no node_modules.
- **No database.** Job state lives in memory; download history is a JSON file
  in `downloads/.history.json`.
- **Threaded downloads.** Each download runs in its own Python thread, so you
  can queue several at once.
- **Theme.** Dark by default. Click the moon/sun in the top right to flip.
  Saved to `localStorage`.

---

## Disclaimer

For personal use with content you have the right to download (your own videos,
Creative Commons, public-domain material, etc.). Respect creators and YouTube's
terms.
