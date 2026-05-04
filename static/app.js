// CRYTDL frontend logic.
// Vanilla JS — no framework, no build step. The whole app is < 300 lines.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  format: "mp4",
  quality: "best",
  embedThumbnail: false,
  embedMetadata: true,
  embedSubs: false,
  activeJobs: new Set(),
  pollTimer: null,
  infoDebounce: null,
};

const QUALITY_OPTIONS = {
  mp4: [
    { value: "best", label: "Best available" },
    { value: "2160", label: "2160p (4K)" },
    { value: "1440", label: "1440p (2K)" },
    { value: "1080", label: "1080p" },
    { value: "720", label: "720p" },
    { value: "480", label: "480p" },
    { value: "360", label: "360p" },
  ],
  mp3: [
    { value: "320", label: "320 kbps" },
    { value: "256", label: "256 kbps" },
    { value: "192", label: "192 kbps (default)" },
    { value: "128", label: "128 kbps" },
    { value: "96", label: "96 kbps" },
  ],
};

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function initTheme() {
  const saved = localStorage.getItem("crytdl-theme");
  if (saved) document.documentElement.dataset.theme = saved;
  $("#themeToggle").addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme;
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("crytdl-theme", next);
  });
}

// ---------------------------------------------------------------------------
// Quality dropdown
// ---------------------------------------------------------------------------

function renderQuality() {
  const sel = $("#qualitySelect");
  sel.innerHTML = "";
  for (const opt of QUALITY_OPTIONS[state.format]) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    sel.appendChild(o);
  }
  // Sensible default per format
  state.quality = state.format === "mp4" ? "best" : "192";
  sel.value = state.quality;
}

// ---------------------------------------------------------------------------
// URL info preview
// ---------------------------------------------------------------------------

function isLikelyYouTube(s) {
  return /(?:youtube\.com|youtu\.be|youtube-nocookie\.com)/i.test(s);
}

async function fetchInfo(url) {
  try {
    const r = await fetch("/api/info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function fmtDuration(secs) {
  if (!secs) return "";
  const s = Math.round(secs);
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, "0");
  if (m < 60) return `${m}:${ss}`;
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  return `${h}:${mm}:${ss}`;
}

function renderPreview(info) {
  const card = $("#preview");
  if (!info || info.error) {
    card.hidden = true;
    return;
  }
  $("#previewThumb").src = info.thumbnail || "";
  $("#previewTitle").textContent = info.title || "";
  const sub = [info.uploader, fmtDuration(info.duration)].filter(Boolean).join(" · ");
  $("#previewSub").textContent = sub;
  card.hidden = false;
}

function debouncePreview() {
  clearTimeout(state.infoDebounce);
  const url = $("#urlInput").value.trim();
  if (!isLikelyYouTube(url)) {
    $("#preview").hidden = true;
    return;
  }
  state.infoDebounce = setTimeout(async () => {
    const info = await fetchInfo(url);
    renderPreview(info);
  }, 400);
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

async function startDownload() {
  const url = $("#urlInput").value.trim();
  if (!url) {
    toast("Paste a YouTube URL first.", true);
    return;
  }
  if (!isLikelyYouTube(url)) {
    toast("That doesn't look like a YouTube URL.", true);
    return;
  }
  const btn = $("#downloadBtn");
  btn.disabled = true;
  try {
    const r = await fetch("/api/download", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url,
        format: state.format,
        quality: state.quality,
        embed_thumbnail: state.embedThumbnail,
        embed_metadata: state.embedMetadata,
        embed_subs: state.embedSubs,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "failed");
    state.activeJobs.add(data.job_id);
    ensurePolling();
    toast("Download queued.");
    $("#urlInput").value = "";
    $("#preview").hidden = true;
  } catch (e) {
    toast(`Couldn't start: ${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Polling — keeps the UI in sync with backend job state.
// ---------------------------------------------------------------------------

function ensurePolling() {
  if (state.pollTimer) return;
  pollOnce();
  state.pollTimer = setInterval(pollOnce, 600);
}

function stopPolling() {
  if (!state.pollTimer) return;
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function pollOnce() {
  try {
    const r = await fetch("/api/jobs");
    const jobs = await r.json();
    renderJobs(jobs);
    const stillActive = jobs.some((j) =>
      ["queued", "downloading", "processing"].includes(j.status)
    );
    if (!stillActive && state.activeJobs.size === 0) {
      stopPolling();
    }
    // After completion, refresh history
    const newlyDone = jobs.filter((j) => j.status === "completed" && state.activeJobs.has(j.id));
    if (newlyDone.length) {
      newlyDone.forEach((j) => state.activeJobs.delete(j.id));
      loadHistory();
    }
  } catch {
    // network blip — try again next tick
  }
}

// ---------------------------------------------------------------------------
// Render: jobs
// ---------------------------------------------------------------------------

function jobIcon(status) {
  if (status === "completed") return svg("check");
  if (status === "error") return svg("alert");
  if (status === "processing") return svg("cog");
  return svg("download");
}

function renderJobs(jobs) {
  const card = $("#jobsCard");
  const list = $("#jobsList");
  const visible = jobs.filter((j) =>
    ["queued", "downloading", "processing"].includes(j.status)
  );
  if (!visible.length) {
    card.hidden = true;
    list.innerHTML = "";
    return;
  }
  card.hidden = false;
  list.innerHTML = "";
  for (const j of visible) {
    const li = document.createElement("li");
    li.className = "job";

    const icon = document.createElement("span");
    icon.className = "job-icon";
    icon.innerHTML = jobIcon(j.status);

    const body = document.createElement("div");
    body.className = "job-body";
    const title = document.createElement("div");
    title.className = "job-title";
    title.textContent = j.title || j.url;
    const meta = document.createElement("div");
    meta.className = "job-meta";
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = j.format;
    meta.appendChild(pill);
    if (j.status === "downloading") {
      meta.append(
        spanText(`${j.percent.toFixed(1)}%`),
        spanText(j.speed || ""),
        spanText(j.eta ? `ETA ${j.eta}` : "")
      );
    } else {
      meta.append(spanText(labelForStatus(j.status)));
    }
    body.append(title, meta);

    const progress = document.createElement("div");
    progress.className = "progress";
    const bar = document.createElement("div");
    bar.className = "progress-bar";
    if (j.status === "processing" || (j.status === "downloading" && !j.total_bytes)) {
      bar.classList.add("is-indeterminate");
    } else {
      bar.style.width = `${Math.max(2, j.percent)}%`;
    }
    progress.appendChild(bar);

    li.append(icon, body, document.createElement("div"), progress);
    list.appendChild(li);
  }
}

function labelForStatus(s) {
  if (s === "queued") return "Queued";
  if (s === "processing") return "Processing…";
  if (s === "error") return "Error";
  return s;
}

// ---------------------------------------------------------------------------
// Render: history
// ---------------------------------------------------------------------------

function fmtBytes(b) {
  if (!b) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) {
    b /= 1024;
    i++;
  }
  return `${b.toFixed(b >= 10 ? 0 : 1)} ${u[i]}`;
}

function fmtAgo(ts) {
  if (!ts) return "";
  const s = Math.round(Date.now() / 1000 - ts);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

async function loadHistory() {
  try {
    const r = await fetch("/api/history");
    const items = await r.json();
    renderHistory(items);
  } catch {}
}

function renderHistory(items) {
  const card = $("#historyCard");
  const list = $("#historyList");
  if (!items.length) {
    card.hidden = true;
    list.innerHTML = "";
    return;
  }
  card.hidden = false;
  list.innerHTML = "";
  for (const it of items) {
    const li = document.createElement("li");
    li.className = "history-item";

    const icon = document.createElement("span");
    icon.className = "hi-icon";
    icon.innerHTML = svg(it.format === "mp3" ? "music" : "video");

    const body = document.createElement("div");
    body.className = "hi-body";
    const title = document.createElement("div");
    title.className = "hi-title";
    title.textContent = it.title || it.filename;
    const meta = document.createElement("div");
    meta.className = "hi-meta";
    meta.append(
      spanText(it.format?.toUpperCase() || ""),
      spanText(fmtBytes(it.size_bytes)),
      spanText(fmtAgo(it.completed_at))
    );
    body.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "hi-actions";
    const dl = document.createElement("a");
    dl.className = "btn-ghost";
    dl.textContent = "Save";
    dl.href = `/api/file/${it.id}`;
    dl.setAttribute("download", "");
    const del = document.createElement("button");
    del.className = "btn-ghost";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      if (!confirm(`Delete "${it.title || it.filename}"?`)) return;
      await fetch(`/api/history/${it.id}`, { method: "DELETE" });
      loadHistory();
    });
    actions.append(dl, del);

    li.append(icon, body, actions);
    list.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function spanText(text) {
  const s = document.createElement("span");
  s.textContent = text;
  return s;
}

function toast(message, isError = false) {
  let t = $(".toast");
  if (!t) {
    t = document.createElement("div");
    t.className = "toast";
    document.body.appendChild(t);
  }
  t.classList.toggle("is-error", isError);
  t.textContent = message;
  requestAnimationFrame(() => t.classList.add("is-visible"));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("is-visible"), 2400);
}

const ICONS = {
  download: `<svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M12 3v12'/><path d='M7 10l5 5 5-5'/><path d='M5 21h14'/></svg>`,
  check: `<svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><path d='M5 12l5 5 9-11'/></svg>`,
  alert: `<svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='10'/><path d='M12 8v5'/><circle cx='12' cy='16.5' r='1' fill='currentColor'/></svg>`,
  cog: `<svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='3'/><path d='M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'/></svg>`,
  music: `<svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M9 18V5l12-2v13'/><circle cx='6' cy='18' r='3'/><circle cx='18' cy='16' r='3'/></svg>`,
  video: `<svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='5' width='18' height='14' rx='2'/><path d='M10 9l5 3-5 3z'/></svg>`,
};

function svg(name) {
  return ICONS[name] || "";
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function bindUI() {
  // Format toggle
  $$(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".seg-btn").forEach((b) => {
        b.classList.remove("is-active");
        b.setAttribute("aria-selected", "false");
      });
      btn.classList.add("is-active");
      btn.setAttribute("aria-selected", "true");
      state.format = btn.dataset.format;
      renderQuality();
      // Subtitles only apply to MP4
      $("#optSubsWrap").style.opacity = state.format === "mp4" ? "" : "0.4";
      $("#optSubs").disabled = state.format !== "mp4";
    });
  });

  // Quality
  $("#qualitySelect").addEventListener("change", (e) => {
    state.quality = e.target.value;
  });

  // Advanced
  $("#optThumbnail").addEventListener("change", (e) => (state.embedThumbnail = e.target.checked));
  $("#optMetadata").addEventListener("change", (e) => (state.embedMetadata = e.target.checked));
  $("#optSubs").addEventListener("change", (e) => (state.embedSubs = e.target.checked));

  // URL input
  $("#urlInput").addEventListener("input", debouncePreview);
  $("#urlInput").addEventListener("paste", () => setTimeout(debouncePreview, 0));
  $("#urlInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      startDownload();
    }
  });

  // Paste button
  $("#pasteBtn").addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      $("#urlInput").value = text.trim();
      debouncePreview();
    } catch {
      toast("Couldn't read clipboard.", true);
    }
  });

  // Download
  $("#downloadBtn").addEventListener("click", startDownload);

  // Refresh history
  $("#refreshHistory").addEventListener("click", loadHistory);
}

async function init() {
  initTheme();
  bindUI();
  renderQuality();
  loadHistory();
  ensurePolling();

  // Health check
  try {
    const r = await fetch("/api/health");
    const d = await r.json();
    const ff = d.ffmpeg ? "ffmpeg ✓" : "ffmpeg missing";
    $("#footerStatus").textContent = `yt-dlp ${d.yt_dlp} · ${ff}`;
  } catch {
    $("#footerStatus").textContent = "offline";
  }
}

init();
