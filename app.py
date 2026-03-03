import os
import re
import uuid
import queue
import threading
import subprocess
import json
import glob as glob_module
from datetime import datetime
from pathlib import Path
from flask import Flask, Response, request, jsonify, send_from_directory

app = Flask(__name__, static_folder="static")

BASE_DIR = Path(__file__).parent
TEMP_DIR = BASE_DIR / "temp"
TEMP_DIR.mkdir(exist_ok=True)

# job_id -> {"queue": Queue, "cancel": bool, "done": bool}
jobs = {}


# ── helpers ──────────────────────────────────────────────────────────────────

def sanitize_filename(title: str, max_len: int = 120) -> str:
    title = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", title)
    title = title.strip(". ")
    title = title[:max_len]
    return title or "untitled"


def unique_path(directory: Path, stem: str, suffix: str = ".md") -> Path:
    candidate = directory / f"{stem}{suffix}"
    if not candidate.exists():
        return candidate
    for i in range(2, 9999):
        candidate = directory / f"{stem}_{i}{suffix}"
        if not candidate.exists():
            return candidate
    return candidate


def cleanup_temp(stem: str):
    for ext in ["mp3", "m4a", "webm", "ogg", "opus", "wav",
                "txt", "json", "srt", "vtt", "tsv"]:
        for f in glob_module.glob(str(TEMP_DIR / f"{stem}*.{ext}")):
            try:
                os.remove(f)
            except OSError:
                pass


def log_event(q: queue.Queue, message: str, level: str = "info"):
    ts = datetime.now().strftime("%H:%M:%S")
    q.put({"type": "log", "level": level, "message": f"[{ts}] {message}"})


def status_event(q: queue.Queue, url: str, state: str, **kwargs):
    payload = {"type": "status", "url": url, "state": state, **kwargs}
    q.put(payload)


# ── processing ───────────────────────────────────────────────────────────────

def process_url(url: str, output_dir: Path, model: str, job: dict) -> bool:
    q = job["queue"]

    # 1. Get title
    log_event(q, f"Fetching title for: {url}")
    status_event(q, url, "fetching")
    try:
        result = subprocess.run(
            ["yt-dlp", "--get-title", "--no-playlist", url],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or "yt-dlp failed to get title")
        title = result.stdout.strip().splitlines()[0]
    except subprocess.TimeoutExpired:
        raise RuntimeError("Timed out fetching title")

    safe_stem = sanitize_filename(title)
    log_event(q, f"Title: {title}")

    # 2. Download audio only
    log_event(q, f"Downloading audio: {title}")
    status_event(q, url, "downloading", title=title)
    audio_template = str(TEMP_DIR / f"{safe_stem}.%(ext)s")
    try:
        result = subprocess.run(
            [
                "yt-dlp", "-x",
                "--audio-format", "mp3",
                "--audio-quality", "5",
                "--no-playlist",
                "-o", audio_template,
                url,
            ],
            capture_output=True, text=True, timeout=600
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or "yt-dlp download failed")
    except subprocess.TimeoutExpired:
        raise RuntimeError("Download timed out (10 min limit)")

    # Find downloaded audio file
    audio_file = None
    for ext in ["mp3", "m4a", "webm", "ogg", "opus", "wav"]:
        candidate = TEMP_DIR / f"{safe_stem}.{ext}"
        if candidate.exists():
            audio_file = candidate
            break
    if not audio_file:
        raise RuntimeError("Audio file not found after download")

    # 3. Transcribe
    log_event(q, f"Transcribing with Whisper ({model})...")
    status_event(q, url, "transcribing", title=title)
    try:
        result = subprocess.run(
            [
                "whisper", str(audio_file),
                "--model", model,
                "--output_format", "txt",
                "--output_dir", str(TEMP_DIR),
                "--fp16", "False",
            ],
            capture_output=True, text=True, timeout=3600
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or "Whisper transcription failed")
    except subprocess.TimeoutExpired:
        raise RuntimeError("Transcription timed out")

    # 4. Read transcript
    txt_file = TEMP_DIR / f"{safe_stem}.txt"
    if not txt_file.exists():
        # Whisper sometimes uses the full audio filename as stem
        candidates = list(TEMP_DIR.glob("*.txt"))
        txt_file = candidates[0] if candidates else None
    if not txt_file or not txt_file.exists():
        raise RuntimeError("Transcript .txt file not found after Whisper run")

    transcript = txt_file.read_text(encoding="utf-8").strip()

    # 5. Write markdown
    output_dir.mkdir(parents=True, exist_ok=True)
    md_path = unique_path(output_dir, safe_stem)
    md_content = f"# {title}\n\n{transcript}\n"
    md_path.write_text(md_content, encoding="utf-8")
    log_event(q, f"Saved: {md_path.name}")

    return str(md_path)


def run_job(job_id: str, urls: list, output_dir: str, model: str):
    job = jobs[job_id]
    q = job["queue"]
    out_dir = Path(output_dir)
    succeeded = 0
    failed = 0

    for url in urls:
        if job["cancel"]:
            log_event(q, "Job cancelled by user.", "warn")
            break

        try:
            md_path = process_url(url, out_dir, model, job)
            succeeded += 1
            status_event(q, url, "done", file=md_path)
            log_event(q, f"Done: {url}")
        except Exception as e:
            failed += 1
            err_msg = str(e)
            status_event(q, url, "error", message=err_msg)
            log_event(q, f"Error on {url}: {err_msg}", "error")
        finally:
            # Always clean temp regardless of success/failure
            safe_stem = sanitize_filename(
                url.split("watch?v=")[-1][:40] if "watch?v=" in url else url[-40:]
            )
            cleanup_temp(safe_stem)
            # Broad cleanup: remove all temp files after each URL
            for f in TEMP_DIR.iterdir():
                try:
                    if f.is_file():
                        f.unlink()
                except OSError:
                    pass

    q.put({"type": "complete", "succeeded": succeeded, "failed": failed,
           "output_dir": output_dir})
    job["done"] = True


# ── routes ───────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/browse", methods=["POST"])
def browse():
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        folder = filedialog.askdirectory(title="Select output folder")
        root.destroy()
        return jsonify({"path": folder or ""})
    except Exception as e:
        return jsonify({"path": "", "error": str(e)})


@app.route("/start", methods=["POST"])
def start_job():
    data = request.get_json()
    output_dir = data.get("output_dir", "").strip()
    model = data.get("model", "tiny").strip()

    if not output_dir:
        return jsonify({"error": "output_dir is required"}), 400

    # Parse URLs: frontend sends a list; fallback handles raw string too
    raw = data.get("urls", [])
    items = raw if isinstance(raw, list) else re.split(r"[,\n]+", raw)
    seen = set()
    urls = []
    for u in items:
        u = u.strip()
        if u and u not in seen:
            seen.add(u)
            urls.append(u)

    if not urls:
        return jsonify({"error": "No URLs provided"}), 400

    job_id = str(uuid.uuid4())[:8]
    jobs[job_id] = {"queue": queue.Queue(), "cancel": False, "done": False}

    t = threading.Thread(target=run_job, args=(job_id, urls, output_dir, model), daemon=True)
    t.start()

    return jsonify({"job_id": job_id, "url_count": len(urls)})


@app.route("/stream/<job_id>")
def stream(job_id):
    if job_id not in jobs:
        return Response("Job not found", status=404)

    def generate():
        job = jobs[job_id]
        q = job["queue"]
        while True:
            try:
                event = q.get(timeout=25)
                yield f"data: {json.dumps(event)}\n\n"
                if event.get("type") == "complete":
                    break
            except queue.Empty:
                # Heartbeat to keep connection alive
                yield "data: {\"type\":\"ping\"}\n\n"
                if job["done"]:
                    break

    return Response(generate(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.route("/cancel/<job_id>", methods=["POST"])
def cancel_job(job_id):
    if job_id in jobs:
        jobs[job_id]["cancel"] = True
        return jsonify({"status": "cancel requested"})
    return jsonify({"error": "job not found"}), 404


# ── startup ──────────────────────────────────────────────────────────────────

def find_free_port(start=5050, end=5060):
    import socket
    for port in range(start, end + 1):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("localhost", port)) != 0:
                return port
    return start


if __name__ == "__main__":
    port = find_free_port()
    print(f"Video Transcriber running at http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
