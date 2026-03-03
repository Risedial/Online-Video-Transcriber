/* ── State ────────────────────────────────────────────────────────────── */
let currentJobId = null;
let eventSource = null;
let urlItems = {};   // url -> { li, state }

/* ── DOM refs ─────────────────────────────────────────────────────────── */
const urlInput      = document.getElementById("url-input");
const urlCount      = document.getElementById("url-count");
const outputDir     = document.getElementById("output-dir");
const modelSelect   = document.getElementById("model-select");
const browseBtn     = document.getElementById("browse-btn");
const startBtn      = document.getElementById("start-btn");
const cancelBtn     = document.getElementById("cancel-btn");
const progressSec   = document.getElementById("progress-section");
const progressBadge = document.getElementById("progress-badge");
const urlList       = document.getElementById("url-list");
const summarySec    = document.getElementById("summary-section");
const summaryBox    = document.getElementById("summary-box");
const logBox        = document.getElementById("log-box");
const clearLogBtn   = document.getElementById("clear-log-btn");

/* ── Persistence ──────────────────────────────────────────────────────── */
const STORAGE_KEY_DIR   = "vt_output_dir";
const STORAGE_KEY_MODEL = "vt_model";

(function restorePrefs() {
  const saved = localStorage.getItem(STORAGE_KEY_DIR);
  if (saved) outputDir.value = saved;
  const savedModel = localStorage.getItem(STORAGE_KEY_MODEL);
  if (savedModel) modelSelect.value = savedModel;
})();

outputDir.addEventListener("input", () => {
  localStorage.setItem(STORAGE_KEY_DIR, outputDir.value.trim());
  validateForm();
});

modelSelect.addEventListener("change", () => {
  localStorage.setItem(STORAGE_KEY_MODEL, modelSelect.value);
});

/* ── URL parsing ──────────────────────────────────────────────────────── */
function parseUrls(raw) {
  const seen = new Set();
  const urls = [];
  for (const part of raw.split(/[,\n]+/)) {
    const u = part.trim();
    if (u && !seen.has(u)) {
      seen.add(u);
      urls.push(u);
    }
  }
  return urls;
}

urlInput.addEventListener("input", () => {
  const urls = parseUrls(urlInput.value);
  urlCount.textContent = urls.length > 0 ? `${urls.length} URL${urls.length > 1 ? "s" : ""}` : "";
  validateForm();
});

/* ── Form validation ──────────────────────────────────────────────────── */
function validateForm() {
  const hasUrls = parseUrls(urlInput.value).length > 0;
  const hasDir  = outputDir.value.trim().length > 0;
  startBtn.disabled = !(hasUrls && hasDir) || currentJobId !== null;
}

/* ── Browse ───────────────────────────────────────────────────────────── */
browseBtn.addEventListener("click", async () => {
  browseBtn.disabled = true;
  browseBtn.textContent = "...";
  try {
    const res = await fetch("/browse", { method: "POST" });
    const data = await res.json();
    if (data.path) {
      outputDir.value = data.path;
      localStorage.setItem(STORAGE_KEY_DIR, data.path);
      validateForm();
    }
  } catch (e) {
    appendLog("Could not open folder picker: " + e.message, "error");
  } finally {
    browseBtn.disabled = false;
    browseBtn.textContent = "Browse";
  }
});

/* ── Start ────────────────────────────────────────────────────────────── */
startBtn.addEventListener("click", async () => {
  const urls = parseUrls(urlInput.value);
  const dir  = outputDir.value.trim();
  if (!urls.length || !dir) return;

  // Reset UI
  urlList.innerHTML = "";
  urlItems = {};
  summarySec.classList.add("hidden");
  summaryBox.textContent = "";
  progressSec.classList.remove("hidden");
  progressBadge.textContent = `0 / ${urls.length}`;
  clearLog();

  // Build URL rows
  urls.forEach(url => {
    const li = buildUrlItem(url);
    urlList.appendChild(li.el);
    urlItems[url] = { el: li.el, state: "queued", done: false };
  });

  // Lock UI
  startBtn.disabled = true;
  cancelBtn.disabled = false;
  currentJobId = null;

  try {
    const res = await fetch("/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls, output_dir: dir, model: modelSelect.value }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    currentJobId = data.job_id;
    appendLog(`Job started (${data.url_count} URL${data.url_count > 1 ? "s" : ""})`);
    openStream(currentJobId, urls.length);
  } catch (e) {
    appendLog("Failed to start job: " + e.message, "error");
    resetControls();
  }
});

/* ── Cancel ───────────────────────────────────────────────────────────── */
cancelBtn.addEventListener("click", async () => {
  if (!currentJobId) return;
  cancelBtn.disabled = true;
  appendLog("Cancelling after current URL...", "warn");
  try {
    await fetch(`/cancel/${currentJobId}`, { method: "POST" });
  } catch (_) {}
});

/* ── SSE stream ───────────────────────────────────────────────────────── */
function openStream(jobId, total) {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/stream/${jobId}`);
  let doneCount = 0;

  eventSource.onmessage = (e) => {
    const ev = JSON.parse(e.data);

    if (ev.type === "ping") return;

    if (ev.type === "log") {
      appendLog(ev.message, ev.level || "info");
      return;
    }

    if (ev.type === "status") {
      updateUrlItem(ev.url, ev.state, ev);
      if (ev.state === "done" || ev.state === "error") {
        doneCount++;
        progressBadge.textContent = `${doneCount} / ${total}`;
      }
      return;
    }

    if (ev.type === "complete") {
      eventSource.close();
      eventSource = null;
      currentJobId = null;
      showSummary(ev.succeeded, ev.failed, ev.output_dir);
      resetControls();
      return;
    }
  };

  eventSource.onerror = () => {
    appendLog("Connection to server lost.", "error");
    eventSource.close();
    eventSource = null;
    resetControls();
  };
}

/* ── URL item builder ─────────────────────────────────────────────────── */
function buildUrlItem(url) {
  const li = document.createElement("li");
  li.className = "url-item state-queued";
  li.innerHTML = `
    <div class="icon">⬜</div>
    <div class="info">
      <div class="title">${escapeHtml(shortenUrl(url))}</div>
      <div class="sub">Queued</div>
    </div>`;
  return { el: li };
}

const STATE_ICON = {
  queued:       "⬜",
  fetching:     null,   // spinner
  downloading:  null,
  transcribing: null,
  done:         "✅",
  error:        "❌",
};

const STATE_LABEL = {
  queued:       "Queued",
  fetching:     "Fetching title...",
  downloading:  "Downloading audio...",
  transcribing: "Transcribing...",
  done:         "Done",
  error:        "Error",
};

function updateUrlItem(url, state, ev) {
  const item = urlItems[url];
  if (!item) return;
  const el = item.el;

  el.className = `url-item state-${state}`;

  const iconEl = el.querySelector(".icon");
  const titleEl = el.querySelector(".title");
  const subEl   = el.querySelector(".sub");

  const icon = STATE_ICON[state];
  if (icon) {
    iconEl.innerHTML = icon;
  } else {
    iconEl.innerHTML = `<div class="spinner"></div>`;
  }

  if (ev.title) titleEl.textContent = ev.title;

  let sub = STATE_LABEL[state] || state;
  if (state === "done" && ev.file) {
    sub = "→ " + ev.file.split(/[\\/]/).pop();
  }
  if (state === "error" && ev.message) {
    sub = ev.message.slice(0, 80);
  }
  subEl.textContent = sub;
}

/* ── Summary ──────────────────────────────────────────────────────────── */
function showSummary(succeeded, failed, outputDirPath) {
  summarySec.classList.remove("hidden");
  const total = succeeded + failed;
  let cls = "success";
  if (failed > 0 && succeeded > 0) cls = "partial";
  if (succeeded === 0) cls = "failed";

  summaryBox.className = `summary ${cls}`;
  summaryBox.innerHTML =
    `<strong>${succeeded} of ${total}</strong> URL${total > 1 ? "s" : ""} transcribed successfully.` +
    (failed > 0 ? ` <span style="color:var(--danger)">${failed} failed.</span>` : "") +
    (succeeded > 0 ? `<br>Files saved to: <code style="color:var(--accent);font-size:12px">${escapeHtml(outputDirPath)}</code>` : "");
}

/* ── Log helpers ──────────────────────────────────────────────────────── */
function appendLog(message, level = "info") {
  const placeholder = logBox.querySelector(".log-placeholder");
  if (placeholder) placeholder.remove();

  const div = document.createElement("div");
  div.className = `log-line ${level}`;
  div.textContent = message;
  logBox.appendChild(div);
  logBox.scrollTop = logBox.scrollHeight;
}

function clearLog() {
  logBox.innerHTML = `<p class="log-placeholder">Activity will appear here...</p>`;
}

clearLogBtn.addEventListener("click", clearLog);

/* ── Reset controls ───────────────────────────────────────────────────── */
function resetControls() {
  currentJobId = null;
  cancelBtn.disabled = true;
  validateForm();
}

/* ── Utils ────────────────────────────────────────────────────────────── */
function shortenUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname + u.pathname.slice(0, 40) + (u.search ? "?" + u.searchParams.get("v") : "");
  } catch (_) {
    return url.slice(0, 60);
  }
}

function escapeHtml(str) {
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

/* ── Init ─────────────────────────────────────────────────────────────── */
validateForm();
