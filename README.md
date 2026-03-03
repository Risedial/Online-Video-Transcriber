# Video Transcriber

A local web app that downloads audio from video URLs and transcribes them to Markdown files using OpenAI Whisper.

## What It Does

1. Paste one or more video URLs (YouTube, etc.)
2. Choose an output folder and Whisper model size
3. The app downloads the audio, transcribes it, and saves a `.md` file per video

Progress is shown in real time. Multiple URLs are processed in sequence.

## Requirements

| Requirement | Auto-installed? |
|---|---|
| Python 3.x | No — install from https://www.python.org/downloads/ |
| ffmpeg | No — install from https://ffmpeg.org/download.html and add to PATH |
| flask | Yes |
| yt-dlp | Yes |
| OpenAI Whisper | Yes (downloads ~1–2 GB of model files on first run) |

`start.bat` automatically installs `flask`, `yt-dlp`, and `openai-whisper` via pip if they are missing. **Python** and **ffmpeg** must be installed manually before running the app.

## Getting Started

### Windows (recommended)

Double-click `start.bat`

This will:
- Check that Python is installed
- Install Flask if needed
- Launch the server on `http://localhost:5050`
- Open your browser automatically

### Manual

```bash
pip install flask
python app.py
```

Then open `http://localhost:5050` in your browser.

## Usage

1. Paste video URLs into the text box (one per line, or comma-separated)
2. Click the folder icon to choose where transcripts will be saved
3. Select a Whisper model size:
   - `tiny` — fastest, lower accuracy
   - `base` — balanced (default)
   - `small` — slower, higher accuracy
4. Click **Start**

Each URL shows its status: queued, in progress, done, or failed. A summary appears when the batch completes.

## Output

Transcripts are saved as Markdown files in your chosen folder:

```markdown
# Video Title

Full transcription text...
```

Filenames are derived from the video title and are made safe for all platforms.

## Cancellation

Click **Cancel** at any time to stop processing. The current URL finishes before stopping.

## Notes

- Requires an internet connection to download videos
- Whisper runs locally — no API key needed
- Temporary audio files are cleaned up automatically
- The app remembers your last output folder and model choice
