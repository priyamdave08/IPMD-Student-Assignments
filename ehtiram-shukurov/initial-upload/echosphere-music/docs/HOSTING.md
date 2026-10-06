# Hosting the API

Status: **in use as a demo.** A server was set up on Oracle Cloud from `docs/DEPLOY_ORACLE.md` and runs the merged code; where it runs and how it is billed is in `docs/DEPLOYMENT_STATUS.md`. The pull requests are merged.

## Can it be hosted for $0?

Checked September 24, 2026 against each provider's own documentation or current summaries. Terms change often; re-check before relying on any of them.

The workflow needs a real container: Python, FFmpeg and headless Chromium (the composer renders music in a browser engine). Chromium typically needs several hundred MB or more (not measured here), so hosts limited to 512 MB and a fraction of a CPU are unlikely to run it reliably.

| Option | Ongoing free? | Needs a payment card? | Fits this app? | Notes |
|---|---|---|---|---|
| **Hugging Face Docker Space** | **No.** Creating a Docker Space requires a paid plan (PRO for personal accounts), even though CPU Basic (2 vCPU, 16 GB) has no hourly charge. | Paid plan | Technically yes | Disk is not persistent and free hardware sleeps when idle. Fails the $0 requirement. Static Spaces are free but cannot run Python. |
| **Google Cloud Run** | A monthly free allowance (about 2M requests, 180,000 vCPU-seconds, 360,000 GiB-seconds), billed only beyond it | **Yes**, a billing account is required | Yes, if memory is set to 2 GiB or more | Usage beyond the allowance is charged. Set a budget alert. Scales to zero, so the first request after idle is slow. Container disk is temporary. |
| **Oracle Cloud Always Free (Arm VM)** | Yes, within its limits | **Yes**, plus a phone number | Probably | Idle instances can be reclaimed. Reported Arm limits were reduced in 2026 (verify current shape limits). You administer the VM. Capacity is sometimes unavailable. |
| **Render free web service** | Yes, but tiny | Sources conflict | **Unlikely** | 512 MB RAM and 0.1 CPU; sleeps after 15 minutes idle. Almost certainly too small for Chromium. |
| **Koyeb free instance** | Yes, but tiny | Sometimes | **Unlikely** | 512 MB RAM, 0.1 vCPU. Almost certainly too small for Chromium. |
| **Fly.io** | **No.** New organizations get a short trial only. | Yes | n/a | Fails the $0 requirement. |
| **A team computer you already own** | Yes (your electricity) | No | Yes | Works today with this repository. Reaching it from outside your network needs a tunnel or port forwarding, which was not evaluated. |

**Conclusion:** no service I verified provides reliable, ongoing, no-card, no-payment hosting for this container. The genuinely $0 option is running it on a computer you already own. Cloud Run and Oracle can cost nothing while you stay inside their free allowances, but both require a payment card on file, and Cloud Run bills automatically past its allowance. Choose one deliberately; do not assume "free tier" means "cannot be charged".

## What was prepared (provider-independent)

- **Authentication.** Set `ECHOSPHERE_API_KEY` (24+ characters). Every `/v1/*` route and `/playground` is then protected; only sign-in, sign-out, status, the page shell and static files are open. Scripts send `Authorization: Bearer <key>` or `X-API-Key`. The browser page shows a sign-in prompt and exchanges the key for a signed, expiring, HttpOnly, `SameSite=Strict` session cookie; the key is never in page code or browser storage. Five failed sign-ins lock that address out for five minutes. The page shell and static files stay public because they hold no data. Unauthenticated `/health` returns only `{"status":"ok"}`.
- **Refusal to run open.** Setting `ECHOSPHERE_ALLOWED_HOSTS` to anything other than localhost, or binding `ECHOSPHERE_HOST` beyond loopback, without a strong key stops startup.
- **Existing limits found and kept:** MP4 only, 100 MB per upload, 10 to 60 seconds, 512 MB minimum free disk, 20 active jobs, one worker, one GPU-style job at a time.
- **New limits:** `ECHOSPHERE_MAX_STORAGE_GB` (default 10) rejects an upload that would exceed total stored bytes after expired items are cleared. `ECHOSPHERE_MAX_QUEUE` (default 20) is now configurable.
- **Automatic cleanup.** `ECHOSPHERE_RETENTION_HOURS` (default 0, meaning keep) removes a video, its analyses and soundtracks once no activity has happened for that long. The worker sweeps every ten minutes and at startup. A video with any queued or running job is never removed, recent job activity extends its life, and folders with no database record are cleared after an hour.
- **Container.** `Dockerfile` (Playwright's official Python image, FFmpeg, non-root user). It defaults to 24 hour retention and a 5 GB quota. Secrets are supplied at run time only.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `ECHOSPHERE_API_KEY` | none | Enables authentication. 24+ characters. Required off-localhost. |
| `ECHOSPHERE_ALLOWED_HOSTS` | localhost only | Comma-separated hostnames the server answers to. |
| `ECHOSPHERE_HOST` / `ECHOSPHERE_PORT` | `127.0.0.1` / `8765` | Bind address and port. |
| `ECHOSPHERE_BEHIND_PROXY` | off | `1` trusts the proxy's forwarded scheme and address headers. Only behind a proxy you control. |
| `ECHOSPHERE_SESSION_HOURS` | 12 | Browser sign-in lifetime. |
| `ECHOSPHERE_MAX_STORAGE_GB` | 10 | Total stored videos and results. `0` disables. |
| `ECHOSPHERE_RETENTION_HOURS` | 0 | Automatic expiry. `0` disables. |
| `ECHOSPHERE_MAX_QUEUE` | 20 | Queued plus running jobs. |
| `ECHOSPHERE_NO_SANDBOX` | off | `1` launches Chromium without its sandbox (set in the Dockerfile; only the app's own page is loaded and other network requests are blocked). |

## Container use

```
docker build -t echosphere .
docker run --rm -p 8765:8765 -v echosphere-data:/data \
  -e ECHOSPHERE_API_KEY=<40 random characters> \
  -e ECHOSPHERE_ALLOWED_HOSTS=<public hostname> echosphere
```

**The container was built and started on an Oracle Arm virtual machine** (September 24 to 25, 2026) using the compose files in `deploy/`. It has not been load-tested or run for a long period.

## Known limits of a first hosted release

- Still one shared key, not per-user accounts. Anyone with the key can see every stored video.
- Sign-in throttling is in memory and keyed by client address; behind a proxy that hides addresses it acts on the proxy.
- The page and API must share one origin (the session cookie is `SameSite=Strict`).
- Manual sphere selection remains required; the API takes focus coordinates. Automatic sphere detection is a separate phase.
- A disk that is not persistent loses videos on restart. That is acceptable for a demo, not for archives.
- Requests are limited by the host's upload size limits, which vary; the app allows 100 MB.
- Generation on a small shared CPU will be slower than on a laptop. This was not measured.
- Only the composer engine is prepared for hosting. Qwen and ACE-Step need a GPU and are out of scope here.

## Validation

Run on Windows 11, Python 3.12, September 24, 2026.

- 16 automated tests pass. The 8 new ones cover: every data route rejecting missing or wrong keys; Bearer, `X-API-Key` and session-cookie access; HttpOnly and `SameSite=Strict` cookie flags; sign-in lockout; expired and forged session tokens; refusal to start off-localhost without a strong key; host allow-listing; cleanup that removes expired items and orphans while keeping running and recently used work; quota rejection at upload; and the configurable queue limit.
- The real server was started with a random key and the demo video was processed through the API with that key, producing a 10 second WAV and MP4. Requests without or with a wrong key returned 401, and unauthenticated `/health` returned only its status.
- In a browser the page showed the sign-in prompt and rejected a wrong key with a visible message. Sign-in with the correct key was covered by the automated tests, not typed into the browser.

Not validated (updated September 25, 2026): behaviour under load or over a long run; upload limits imposed by a host; hosted generation speed and memory; multi-user use. The image and compose stack were built and started on an Oracle Arm VM.
