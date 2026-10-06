# EchoSphere local video workflow

This is a development version. The complete **color/motion measurements → existing instrument composer** route has been exercised using the supplied video. The Qwen and ACE-Step connections are implemented, but model inference, GPU memory, speed and listening quality still need validation on the target computer. Cloud hosting is deferred.

The original `index.html` is unchanged. The local server opens `video.html`; `/playground` opens the existing standalone composer. There is no required paid service or API key.

## Windows setup

Install Python **3.12**, Git, and [FFmpeg](https://ffmpeg.org/download.html). FFmpeg's `bin` directory must be on PATH, including both `ffmpeg.exe` and `ffprobe.exe`. Use a build with libx264, libvpx-vp9, libopus and AAC. Open a new PowerShell window after editing PATH.

```powershell
git clone --branch codex/video-soundtrack-local https://github.com/Ehtiram-Shukurov/echosphere-music.git
cd echosphere-music
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m playwright install chromium
.\.venv\Scripts\python.exe scripts/doctor.py
.\.venv\Scripts\python.exe run_local.py
```

Open **http://127.0.0.1:8765**. Keep that terminal open. Ctrl+C stops the API and worker. No activation script or PowerShell execution-policy change is needed. This setup has been run on Linux/Python 3.12 here; the Windows commands require their own target-machine check.

For an existing clone, fetch the feature branch and switch to it before creating the environment. Preserve any uncommitted work first.

Linux/macOS use `python3.12 -m venv .venv`, then `.venv/bin/python` in place of the Windows interpreter path. On minimal Linux installations, Playwright may also need its documented system browser dependencies.

## First run

1. Upload an MP4, 10–60 seconds, at most 100 MB. Its original audio is discarded from analysis and preview.
2. At 0:00, drag an ellipse **inside the sphere**, then save the focus point. The selection must exclude the robot's face.
3. Scrub through the clip. Save more focus points where the sphere moves or changes size. Coordinates interpolate between saved points; this is manual tracking, not automatic object tracking. The provided zooming clip needs several points.
4. Choose **Read the sphere**. Review the cropped evidence thumbnails. These are the actual images analyzed.
5. Accept the palette suggestion or select Warm, Calm, Sad or Anger. Mixed blue/violet cues should be resolved manually. Color analysis does not understand objects or infer facial emotions.
6. Choose **Create soundtrack**, then play the result. New variation retains previous takes. WAV/MP4 downloads use the saved take and never regenerate it.

The local server normalizes rotation, pixel aspect and frame rate to a maximum 1280-pixel, 24 fps silent preview. This normalized timeline is used for composition and export; it can differ from the original duration by a fraction of a frame. MP4 is preferred for playback; WebM is provided for browsers without H.264/AAC. Both encoded previews derive from the same final WAV, but AAC/Opus are lossy and not byte-identical to WAV.

All local videos and results stay under `data/` (excluded from Git). **Generation settings & saved videos** restores previous sessions. Delete a video's results there when finished. Output retention is manual; there is no automatic expiry.

## Add local Qwen vision

Use [Ollama](https://ollama.com/download) and download the local model:

```powershell
ollama pull qwen3-vl:4b
```

For a server launched from a terminal, disable Ollama cloud features in that server's environment before starting it:

```powershell
$env:OLLAMA_NO_CLOUD="1"
ollama serve
```

If the desktop Ollama service already owns port 11434, stop that instance first or configure its environment and restart it. Do not start two servers on the same port. See the [official FAQ](https://docs.ollama.com/faq).

The app sends up to eight **masked sphere crops**, in batches of four, to the local `/api/chat` endpoint. It asks for schema-validated observations and a mood. Each request uses `keep_alive: 0` to release the vision model afterward. It does not send the full robot frame or original audio. Model tags containing `cloud` are rejected.

Reload the EchoSphere page after starting the model service, then choose Qwen in Generation settings and analyze again. An unavailable or invalid model response fails visibly; it does not silently replace semantic interpretation with a color heuristic.

## Add local ACE-Step music

Use a **separate environment** for [ACE-Step 1.5](https://github.com/ace-step/ACE-Step-1.5). The app does not install PyTorch or download multi-gigabyte music weights automatically. Check `scripts/doctor.py` first and allow sufficient disk space for the model environment.

Follow the upstream installation instructions (`uv sync` in its repository). Start with the non-XL `acestep-v15-turbo` model. A conservative API setup for an 8 GB-class GPU is:

```powershell
# In the ACE-Step repository, after its own installation:
$env:ACESTEP_API_HOST="127.0.0.1"
$env:ACESTEP_API_PORT="8001"
$env:ACESTEP_CONFIG_PATH="acestep-v15-turbo"
$env:ACESTEP_INIT_LLM="false"
$env:ACESTEP_OFFLOAD_TO_CPU="true"
$env:ACESTEP_OFFLOAD_DIT_TO_CPU="true"
uv run acestep-api
```

This is a starting configuration, **not a verified benchmark for the laptop**. Consult the current [GPU guide](https://github.com/ace-step/ACE-Step-1.5/blob/main/docs/en/GPU_COMPATIBILITY.md). Pin the tested upstream commit and model revisions once the first successful generation is established. The first startup can download large files.

The adapter requests one WAV, `[Instrumental]` lyrics, a duration/BPM/key/meter and a fixed seed. Language-model planning and automatic caption/language completion are initially disabled to bound memory use. It submits `/release_task`, polls `/query_result`, and downloads the returned audio from the same local service. See the [official API contract](https://github.com/ace-step/ACE-Step-1.5/blob/main/docs/en/API.md).

Reload EchoSphere after the service is ready. Select ACE-Step explicitly, generate one 10-second sample, and listen for musical coherence, unwanted vocals, harshness and a natural ending. Matching file duration does not establish good music or event synchronization. Compare this sample with the composer before expanding the workflow.

The single worker schedules model requests sequentially. ACE-Step's CPU offload and Ollama's unload setting matter: a service can retain GPU memory even while idle. Do not run unrelated GPU generations concurrently during the initial feasibility test.

## Configuration

Set these environment variables **before** starting `run_local.py`:

| Variable | Default | Meaning |
|---|---|---|
| `ECHOSPHERE_DATA` | repository `data/` | Local SQLite database and file storage |
| `ECHOSPHERE_OLLAMA_URL` | `http://127.0.0.1:11434` | Local vision server |
| `ECHOSPHERE_VISION_MODEL` | `qwen3-vl:4b` | Installed local vision model name |
| `ECHOSPHERE_ACE_URL` | `http://127.0.0.1:8001` | Local music server |
| `ECHOSPHERE_ACE_MODEL` | provider default | Optional explicit DiT model |
| `ECHOSPHERE_ACE_KEY` | empty | Optional key for your own local ACE service |

By default the local release accepts loopback connections and same-origin mutations only, and it is **not safe to expose directly to the internet** without a key. For a hosted setup, set `ECHOSPHERE_API_KEY` and the allowed host names and put it behind HTTPS; see [HOSTING.md](HOSTING.md) and [DEPLOY_ORACLE.md](DEPLOY_ORACLE.md). The processing functions are separate from the API to keep that migration manageable.

## Jobs, interruption and cancellation

SQLite persists the queue and completed results. An OS file lock permits one worker per data directory. On restart, queued jobs continue and interrupted active jobs become failed with a retry message; expensive jobs are not automatically resubmitted. Submit a new job to retry them.

Cancellation is cooperative. FFmpeg and the composer are checked frequently. An in-flight Qwen HTTP request can take up to its timeout. ACE-Step has no cancellation endpoint in the contract used here, so its active request is polled until completion before cancellation is finalized. A timed-out or disconnected ACE task leaves a persistent marker that blocks subsequent GPU jobs until the provider reports it finished.

If the ACE server was restarted and no longer recognizes such a task: stop EchoSphere, verify the old ACE process has stopped, then remove the corresponding JSON marker from `data/provider-tasks/` and restart. Do not remove it while that generation may still be running. Provider markers persist even if a failed soundtrack is deleted.

## Checks

```powershell
.\.venv\Scripts\python.exe -m pip install pytest==9.1.1
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe scripts/check_browser.py "C:\path\EchoSphere Robot Design Demo-Ver 1.mp4"
```

The browser check starts/stops its own local services and writes ignored outputs under `test-results/`. Stop another app instance before using its port. Its default focus file describes the supplied demo **only**; pass `--focus your-focus.json` for a different clip. The check currently uses a Unix process group for complete cleanup; on Windows run it in a disposable development terminal and verify its child worker/server have exited if interrupted.

See [API.md](API.md) for a browser-independent client and [VALIDATION.md](VALIDATION.md) for exactly what has and has not been verified.
