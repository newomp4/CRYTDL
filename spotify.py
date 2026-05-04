"""Spotify support — metadata only.

Spotify streams are DRM-encrypted, so we can't download audio from Spotify
itself. Instead we:

  1. Read the Spotify URL and scrape the public open.spotify.com page
     for title, artist, album, year, and cover art (no API key needed —
     Spotify exposes this in og:* / music:* meta tags).
  2. Hand back enough info that the download pipeline can search YouTube
     for the same song and overwrite the resulting MP3's tags so it looks
     and sounds like the Spotify version.

Currently supports single tracks. Album/playlist URLs return a friendly
"not yet supported" message rather than failing silently.
"""

from __future__ import annotations

import re
import urllib.request
from typing import Any


SPOTIFY_RE = re.compile(
    r"(?:open\.spotify\.com/(?:intl-[a-z]+/)?(track|album|playlist|episode)/|"
    r"spotify:(track|album|playlist|episode):)([a-zA-Z0-9]+)",
    re.IGNORECASE,
)

# Spotify serves the lightweight SSR/SEO page (~10KB, has og:* tags) to
# known crawlers; full-browser UAs get the heavy SPA shell that hydrates
# in JS and contains *no* metadata.
UA = "facebookexternalhit/1.1"


def is_spotify_url(url: str) -> bool:
    return bool(SPOTIFY_RE.search(url or ""))


def parse_spotify_url(url: str) -> tuple[str, str] | None:
    m = SPOTIFY_RE.search(url)
    if not m:
        return None
    kind = (m.group(1) or m.group(2)).lower()
    sid = m.group(3)
    return kind, sid


def _meta(html: str, name: str) -> str | None:
    """Extract a single <meta property|name="..."> content value."""
    pattern = (
        rf'<meta\s+(?:property|name)=["\']{re.escape(name)}["\']\s+'
        rf'content=["\']([^"\']+)["\']'
    )
    m = re.search(pattern, html, re.IGNORECASE)
    return m.group(1) if m else None


def fetch_track(url: str) -> dict[str, Any]:
    """Scrape a Spotify track page. Raises on failure."""
    parsed = parse_spotify_url(url)
    if not parsed:
        raise ValueError("not a Spotify URL")
    kind, sid = parsed
    if kind != "track":
        raise ValueError(
            f"only Spotify tracks are supported right now (got {kind})"
        )

    canonical = f"https://open.spotify.com/track/{sid}"
    req = urllib.request.Request(canonical, headers={
        "User-Agent": UA,
        "Accept-Language": "en-US,en;q=0.9",
    })
    with urllib.request.urlopen(req, timeout=15) as r:
        html = r.read().decode("utf-8", errors="ignore")

    title = _meta(html, "og:title")
    desc = _meta(html, "og:description") or ""
    cover = _meta(html, "og:image")
    duration = _meta(html, "music:duration")
    release = _meta(html, "music:release_date")
    artist = _meta(html, "music:musician_description")

    if not title:
        raise ValueError("couldn't read Spotify metadata (page format changed?)")

    # description is "Artist · Album · Song · Year"
    parts = [p.strip() for p in re.split(r"·|•", desc) if p.strip()]
    if not artist and len(parts) >= 1:
        artist = parts[0]
    album = None
    if len(parts) >= 2 and not re.fullmatch(r"\d{4}", parts[1]):
        album = parts[1]
    year = None
    for p in parts:
        if re.fullmatch(r"\d{4}", p):
            year = p
            break
    if not year and release:
        year = release[:4]

    return {
        "id": sid,
        "url": canonical,
        "title": title,
        "artist": artist,
        "album": album,
        "year": year,
        "release_date": release,
        "duration": int(duration) if duration and duration.isdigit() else None,
        "cover_url": cover,
    }


def search_query(meta: dict[str, Any]) -> str:
    """Build a YouTube search query from Spotify track metadata."""
    bits = []
    if meta.get("artist"):
        bits.append(meta["artist"])
    if meta.get("title"):
        bits.append(meta["title"])
    return " ".join(bits) or meta.get("title", "")
