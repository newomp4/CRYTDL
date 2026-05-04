// CRYTDL frontend — vanilla JS, no framework, no build step.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

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
  infoToken: 0,        // monotonic counter so old fetches don't overwrite newer
  lastUrl: "",
  history: [],
  jobs: [],
  openMenuFor: null,   // history id with open menu
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
    { value: "96",  label: "96 kbps" },
  ],
};

// ---------------------------------------------------------------------------
// Theme — respects system preference, persists user override
// ---------------------------------------------------------------------------

function initTheme() {
  const saved = localStorage.getItem("crytdl-theme");
  if (saved) {
    document.documentElement.dataset.theme = saved;
  } else if (window.matchMedia?.("(prefers-color-scheme: light)").matches) {
    document.documentElement.dataset.theme = "light";
  }
  $("#themeToggle").addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme;
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("crytdl-theme", next);
  });
}

// ---------------------------------------------------------------------------
// URL detection (mirrors spotify.py / yt-dlp domain coverage)
// ---------------------------------------------------------------------------

function isLikelyYouTube(s) {
  return /(?:youtube\.com|youtu\.be|youtube-nocookie\.com)/i.test(s);
}
function isLikelySpotify(s) {
  return /(?:open\.spotify\.com\/(?:intl-[a-z]+\/)?(?:track|album|playlist|episode)\/|spotify:(?:track|album|playlist|episode):)/i.test(s);
}
function detectSource(s) {
  if (isLikelySpotify(s)) return "spotify";
  if (isLikelyYouTube(s)) return "youtube";
  return null;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

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

function fmtBytes(b) {
  if (!b) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
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

function spanText(text) {
  const s = document.createElement("span");
  s.textContent = text;
  return s;
}

// ---------------------------------------------------------------------------
// Quality dropdown + format
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
  state.quality = state.format === "mp4" ? "best" : "192";
  sel.value = state.quality;
}

function setFormat(fmt) {
  if (state.format === fmt) return;
  state.format = fmt;
  $$(".seg-btn").forEach((b) => {
    const active = b.dataset.format === fmt;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-selected", active ? "true" : "false");
  });
  renderQuality();
}

// ---------------------------------------------------------------------------
// URL preview
// ---------------------------------------------------------------------------

function setSourceIcon(source) {
  $("#urlPrefix").dataset.source = source || "";
}

function showSkeleton() {
  $("#previewZone").innerHTML = `
    <div class="skel">
      <div class="skel-thumb"></div>
      <div class="skel-meta">
        <div class="skel-line"></div>
        <div class="skel-line short"></div>
      </div>
    </div>`;
}

function clearPreview() {
  $("#previewZone").innerHTML = "";
}

function renderPreview(info, source) {
  if (!info || info.error) {
    clearPreview();
    return;
  }
  const subBits = [info.uploader, info.album, fmtDuration(info.duration)].filter(Boolean);
  const sourceIcon = source === "spotify"
    ? `<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm4.5 14.4a.6.6 0 0 1-.86.2c-2.36-1.44-5.32-1.76-8.82-.96a.62.62 0 1 1-.28-1.22c3.82-.86 7.1-.5 9.74 1.12a.62.62 0 0 1 .22.86z"/></svg>`
    : `<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M21.6 7.2a2.5 2.5 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4A2.5 2.5 0 0 0 2.4 7.2C2 8.8 2 12 2 12s0 3.2.4 4.8a2.5 2.5 0 0 0 1.8 1.8C5.8 19 12 19 12 19s6.2 0 7.8-.4a2.5 2.5 0 0 0 1.8-1.8C22 15.2 22 12 22 12s0-3.2-.4-4.8zM10 15V9l5 3-5 3z"/></svg>`;

  $("#previewZone").innerHTML = `
    <div class="preview">
      <div class="preview-thumb-wrap">
        <img class="preview-thumb" src="${escapeAttr(info.thumbnail || "")}" alt="" />
        <span class="preview-source">${sourceIcon}</span>
      </div>
      <div class="preview-meta">
        <div class="preview-title">${escapeHtml(info.title || "")}</div>
        <div class="preview-sub">${escapeHtml(subBits.join(" · "))}</div>
      </div>
    </div>`;
}

function applySourceConstraints(source) {
  setSourceIcon(source);
  const notice = $("#spotifyNotice");
  if (source === "spotify") {
    notice.hidden = false;
    setFormat("mp3");
    $$(".seg-btn").forEach((b) => (b.disabled = b.dataset.format !== "mp3"));
  } else {
    notice.hidden = true;
    $$(".seg-btn").forEach((b) => (b.disabled = false));
  }
}

async function fetchInfo(url, token) {
  try {
    const r = await fetch("/api/info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (token !== state.infoToken) return null; // user typed something newer
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function debouncePreview() {
  clearTimeout(state.infoDebounce);
  const url = $("#urlInput").value.trim();
  $("#clearBtn").hidden = !url;
  state.lastUrl = url;
  const source = detectSource(url);
  applySourceConstraints(source);
  if (!source) {
    clearPreview();
    return;
  }
  showSkeleton();
  const token = ++state.infoToken;
  state.infoDebounce = setTimeout(async () => {
    const info = await fetchInfo(url, token);
    if (token !== state.infoToken) return;
    if (info && !info.error) renderPreview(info, source);
    else clearPreview();
  }, 350);
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

async function startDownload() {
  const url = $("#urlInput").value.trim();
  if (!url) {
    toast("Paste a YouTube or Spotify link first.", { type: "error" });
    $("#urlInput").focus();
    return;
  }
  const source = detectSource(url);
  if (!source) {
    toast("That doesn't look like a YouTube or Spotify URL.", { type: "error" });
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
    toast("Download queued", { type: "success" });
    $("#urlInput").value = "";
    $("#clearBtn").hidden = true;
    clearPreview();
    setSourceIcon(null);
    applySourceConstraints(null);
  } catch (e) {
    toast(`Couldn't start: ${e.message}`, { type: "error" });
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Polling
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
    state.jobs = jobs;
    renderJobs(jobs);
    updatePageTitle(jobs);
    const stillActive = jobs.some((j) =>
      ["queued", "downloading", "processing", "searching", "tagging"].includes(j.status)
    );
    if (!stillActive && state.activeJobs.size === 0) stopPolling();
    const newlyDone = jobs.filter((j) => j.status === "completed" && state.activeJobs.has(j.id));
    if (newlyDone.length) {
      newlyDone.forEach((j) => {
        state.activeJobs.delete(j.id);
        toast(`Saved: ${j.title || j.filename}`, { type: "success" });
      });
      loadHistory();
    }
    const newlyError = jobs.filter((j) => j.status === "error" && state.activeJobs.has(j.id));
    newlyError.forEach((j) => {
      state.activeJobs.delete(j.id);
      toast(`Failed: ${j.error || "unknown error"}`, { type: "error" });
    });
  } catch {/* network blip — try again next tick */}
}

function updatePageTitle(jobs) {
  const active = jobs.filter((j) =>
    ["queued", "downloading", "processing", "searching", "tagging"].includes(j.status)
  );
  if (!active.length) {
    document.title = "CRYTDL";
    return;
  }
  const total = active.reduce((acc, j) => acc + (j.percent || 0), 0);
  const avg = Math.round(total / active.length);
  document.title = `${avg}% · CRYTDL`;
}

// ---------------------------------------------------------------------------
// Render: jobs (active downloads)
// ---------------------------------------------------------------------------

function renderJobs(jobs) {
  const card = $("#jobsCard");
  const list = $("#jobsList");
  const visible = jobs.filter((j) =>
    ["queued", "downloading", "processing", "searching", "tagging"].includes(j.status)
  );
  $("#jobsCount").textContent = visible.length ? `${visible.length} running` : "";
  if (!visible.length) {
    card.hidden = true;
    list.innerHTML = "";
    refreshEmptyState();
    return;
  }
  card.hidden = false;
  refreshEmptyState();

  // Update existing rows in place for smoother UI; add/remove as needed.
  const seen = new Set();
  for (const j of visible) {
    seen.add(j.id);
    let row = list.querySelector(`[data-job-id="${j.id}"]`);
    if (!row) {
      row = makeJobRow(j);
      list.appendChild(row);
    }
    updateJobRow(row, j);
  }
  $$(".job", list).forEach((el) => {
    if (!seen.has(el.dataset.jobId)) el.remove();
  });
}

function makeJobRow(j) {
  const li = document.createElement("li");
  li.className = "job";
  li.dataset.jobId = j.id;
  li.innerHTML = `
    <span class="job-icon"></span>
    <div class="job-body">
      <div class="job-title"></div>
      <div class="job-meta"></div>
    </div>
    <div class="row-actions"></div>
    <div class="progress"><div class="progress-bar"></div></div>
  `;
  return li;
}

function updateJobRow(row, j) {
  const icon = $(".job-icon", row);
  const title = $(".job-title", row);
  const meta = $(".job-meta", row);
  const bar = $(".progress-bar", row);

  title.textContent = j.title || j.url;

  // Icon based on status (with little animations)
  icon.className = "job-icon";
  if (j.status === "downloading") {
    icon.classList.add("is-pulse");
    icon.innerHTML = svg("download");
  } else if (j.status === "processing" || j.status === "tagging") {
    icon.classList.add("is-spin");
    icon.innerHTML = svg("cog");
  } else if (j.status === "searching") {
    icon.classList.add("is-pulse");
    icon.innerHTML = svg("search");
  } else {
    icon.innerHTML = svg("download");
  }

  // Meta line
  meta.innerHTML = "";
  const fmtPill = document.createElement("span");
  fmtPill.className = "pill";
  fmtPill.textContent = j.format;
  meta.appendChild(fmtPill);
  if (j.source && j.source !== "youtube") {
    const sp = document.createElement("span");
    sp.className = "pill";
    sp.textContent = j.source;
    meta.appendChild(sp);
  }
  if (j.status === "downloading") {
    meta.append(
      spanText(`${(j.percent || 0).toFixed(1)}%`),
      spanText(j.speed || ""),
      spanText(j.eta ? `ETA ${j.eta}` : "")
    );
  } else {
    meta.append(spanText(labelForStatus(j.status)));
  }

  // Progress bar
  if (j.status === "processing" || j.status === "tagging" || j.status === "searching" ||
      (j.status === "downloading" && !j.total_bytes)) {
    bar.classList.add("is-indeterminate");
    bar.style.width = "";
  } else if (j.status === "queued") {
    bar.classList.add("is-indeterminate");
    bar.style.width = "";
  } else {
    bar.classList.remove("is-indeterminate");
    bar.style.width = `${Math.max(2, j.percent || 0)}%`;
  }
}

function labelForStatus(s) {
  if (s === "queued") return "Queued";
  if (s === "searching") return "Searching YouTube…";
  if (s === "processing") return "Processing…";
  if (s === "tagging") return "Tagging…";
  if (s === "error") return "Error";
  return s;
}

// ---------------------------------------------------------------------------
// Render: history
// ---------------------------------------------------------------------------

async function loadHistory() {
  try {
    const r = await fetch("/api/history");
    const items = await r.json();
    state.history = items;
    renderHistory(items);
    refreshEmptyState();
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
  $("#historyCount").textContent = `${items.length} ${items.length === 1 ? "item" : "items"}`;
  card.hidden = false;
  list.innerHTML = "";
  for (const it of items) {
    const li = document.createElement("li");
    li.className = "history-item";
    li.dataset.entryId = it.id;

    const thumb = it.thumbnail
      ? `<img class="thumb" src="${escapeAttr(it.thumbnail)}" alt="" loading="lazy" />`
      : `<span class="thumb-fallback">${svg(it.format === "mp3" ? "music" : "video")}</span>`;

    li.innerHTML = `
      ${thumb}
      <div class="hi-body">
        <div class="hi-title"></div>
        <div class="hi-meta"></div>
      </div>
      <div class="row-actions">
        <button class="row-menu-btn" aria-haspopup="menu" aria-label="Actions">${svg("dots")}</button>
      </div>
    `;
    $(".hi-title", li).textContent = it.title || it.filename;
    const meta = $(".hi-meta", li);
    const fmtPill = document.createElement("span");
    fmtPill.className = "pill";
    fmtPill.textContent = it.format?.toUpperCase() || "";
    meta.appendChild(fmtPill);
    if (it.source && it.source !== "youtube") {
      const sp = document.createElement("span");
      sp.className = "pill";
      sp.textContent = it.source;
      meta.appendChild(sp);
    }
    meta.append(
      spanText(fmtBytes(it.size_bytes)),
      spanText(fmtAgo(it.completed_at))
    );

    const menuBtn = $(".row-menu-btn", li);
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleRowMenu(it, menuBtn);
    });

    list.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Row action menu
// ---------------------------------------------------------------------------

function closeAnyMenu() {
  $$(".row-menu").forEach((m) => m.remove());
  $$(".row-menu-btn.is-open").forEach((b) => b.classList.remove("is-open"));
  state.openMenuFor = null;
}

function toggleRowMenu(item, btn) {
  if (state.openMenuFor === item.id) {
    closeAnyMenu();
    return;
  }
  closeAnyMenu();
  state.openMenuFor = item.id;
  btn.classList.add("is-open");

  const tpl = $("#rowMenuTpl");
  const menu = tpl.content.firstElementChild.cloneNode(true);
  $$(".row-menu button", menu).forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      handleMenuAction(b.dataset.action, item);
      closeAnyMenu();
    });
  });
  btn.parentElement.appendChild(menu);
}

async function handleMenuAction(action, item) {
  if (action === "open") {
    const r = await fetch(`/api/history/${item.id}/open`, { method: "POST" });
    if (!r.ok) toast("Couldn't open file.", { type: "error" });
  } else if (action === "reveal") {
    const r = await fetch(`/api/history/${item.id}/reveal`, { method: "POST" });
    if (!r.ok) toast("Couldn't reveal file.", { type: "error" });
  } else if (action === "save") {
    window.location.href = `/api/history/${item.id}/file`;
  } else if (action === "copy") {
    try {
      await navigator.clipboard.writeText(item.url || "");
      toast("URL copied", { type: "success" });
    } catch {
      toast("Couldn't access clipboard", { type: "error" });
    }
  } else if (action === "replay") {
    $("#urlInput").value = item.url || "";
    debouncePreview();
    $("#urlInput").focus();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } else if (action === "delete") {
    if (!confirm(`Delete "${item.title || item.filename}"?`)) return;
    await fetch(`/api/history/${item.id}`, { method: "DELETE" });
    loadHistory();
    toast("Deleted", { type: "success" });
  }
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function refreshEmptyState() {
  const hasJobs = state.jobs?.some?.((j) =>
    ["queued", "downloading", "processing", "searching", "tagging"].includes(j.status)
  );
  const hasHistory = state.history?.length;
  $("#emptyState").classList.toggle("is-hidden", Boolean(hasJobs || hasHistory));
}

// ---------------------------------------------------------------------------
// Toasts (top-right, stackable, auto-dismiss)
// ---------------------------------------------------------------------------

function toast(message, opts = {}) {
  const stack = $("#toastStack");
  const el = document.createElement("div");
  el.className = `toast ${opts.type === "error" ? "is-error" : opts.type === "success" ? "is-success" : ""}`;
  const iconName = opts.type === "error" ? "alert" : opts.type === "success" ? "check" : "info";
  el.innerHTML = `<span class="toast-icon">${svg(iconName)}</span><span></span>`;
  $("span:last-child", el).textContent = message;
  stack.appendChild(el);
  setTimeout(() => {
    el.classList.add("is-leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }, opts.ms || 2800);
  el.addEventListener("click", () => el.remove());
}

// ---------------------------------------------------------------------------
// Drag & drop URL onto the window
// ---------------------------------------------------------------------------

function initDragDrop() {
  let depth = 0;
  const overlay = $("#dropOverlay");
  window.addEventListener("dragenter", (e) => {
    if (![...e.dataTransfer?.types || []].some((t) => t === "text/uri-list" || t === "text/plain" || t === "text/x-moz-url")) return;
    depth++;
    overlay.classList.add("is-active");
  });
  window.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.classList.remove("is-active");
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    overlay.classList.remove("is-active");
    const dt = e.dataTransfer;
    let url =
      dt.getData("text/uri-list") ||
      dt.getData("text/x-moz-url")?.split("\n")[0] ||
      dt.getData("text/plain") ||
      "";
    url = url.trim();
    if (!url) return;
    $("#urlInput").value = url;
    debouncePreview();
    $("#urlInput").focus();
  });
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

function initShortcuts() {
  document.addEventListener("keydown", (e) => {
    const meta = e.metaKey || e.ctrlKey;
    const inInput = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);

    // Cmd/Ctrl+K — focus URL bar from anywhere
    if (meta && e.key.toLowerCase() === "k") {
      e.preventDefault();
      $("#urlInput").focus();
      $("#urlInput").select();
      return;
    }

    // Esc — clear URL or close menu
    if (e.key === "Escape") {
      if (state.openMenuFor) { closeAnyMenu(); return; }
      if (document.activeElement === $("#urlInput")) {
        $("#urlInput").value = "";
        debouncePreview();
      }
      return;
    }

    // Cmd/Ctrl+V outside input — auto-paste & focus
    if (meta && e.key.toLowerCase() === "v" && !inInput && navigator.clipboard?.readText) {
      navigator.clipboard.readText().then((text) => {
        if (!text) return;
        $("#urlInput").value = text.trim();
        $("#urlInput").focus();
        debouncePreview();
      }).catch(() => {});
    }
  });

  // Click anywhere else closes open menus
  document.addEventListener("click", () => {
    if (state.openMenuFor) closeAnyMenu();
  });
}

// ---------------------------------------------------------------------------
// SVG icons
// ---------------------------------------------------------------------------

const ICONS = {
  download: `<svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M12 3v12'/><path d='M7 10l5 5 5-5'/><path d='M5 21h14'/></svg>`,
  check: `<svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><path d='M5 12l5 5 9-11'/></svg>`,
  alert: `<svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='10'/><path d='M12 8v5'/><circle cx='12' cy='16.5' r='1' fill='currentColor'/></svg>`,
  info: `<svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='10'/><path d='M12 16v-5'/><circle cx='12' cy='8' r='1' fill='currentColor'/></svg>`,
  cog: `<svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='3'/><path d='M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'/></svg>`,
  music: `<svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M9 18V5l12-2v13'/><circle cx='6' cy='18' r='3'/><circle cx='18' cy='16' r='3'/></svg>`,
  video: `<svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='5' width='18' height='14' rx='2'/><path d='M10 9l5 3-5 3z'/></svg>`,
  search: `<svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='11' cy='11' r='7'/><path d='M21 21l-4.35-4.35'/></svg>`,
  dots: `<svg viewBox='0 0 24 24' width='14' height='14' fill='currentColor'><circle cx='5' cy='12' r='1.6'/><circle cx='12' cy='12' r='1.6'/><circle cx='19' cy='12' r='1.6'/></svg>`,
};
function svg(name) { return ICONS[name] || ""; }

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function bindUI() {
  $$(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      setFormat(btn.dataset.format);
      $("#optSubsWrap").style.opacity = state.format === "mp4" ? "" : "0.4";
      $("#optSubs").disabled = state.format !== "mp4";
    });
  });

  $("#qualitySelect").addEventListener("change", (e) => (state.quality = e.target.value));
  $("#optThumbnail").addEventListener("change", (e) => (state.embedThumbnail = e.target.checked));
  $("#optMetadata").addEventListener("change", (e) => (state.embedMetadata = e.target.checked));
  $("#optSubs").addEventListener("change", (e) => (state.embedSubs = e.target.checked));

  $("#urlInput").addEventListener("input", debouncePreview);
  $("#urlInput").addEventListener("paste", () => setTimeout(debouncePreview, 0));
  $("#urlInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      startDownload();
    }
  });

  $("#clearBtn").addEventListener("click", () => {
    $("#urlInput").value = "";
    debouncePreview();
    $("#urlInput").focus();
  });

  $("#pasteBtn").addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      $("#urlInput").value = text.trim();
      debouncePreview();
      $("#urlInput").focus();
    } catch {
      toast("Couldn't read clipboard.", { type: "error" });
    }
  });

  $("#cmdkBtn").addEventListener("click", () => {
    $("#urlInput").focus();
    $("#urlInput").select();
  });

  $("#downloadBtn").addEventListener("click", startDownload);
}

async function init() {
  initTheme();
  bindUI();
  initDragDrop();
  initShortcuts();
  renderQuality();
  await loadHistory();
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
