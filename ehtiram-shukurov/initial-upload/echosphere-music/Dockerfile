# Provider-independent container for the EchoSphere API + worker (composer engine).
# Chromium and its system libraries come from Playwright's official image; keep the
# tag in step with the playwright version pinned in requirements.txt.
FROM mcr.microsoft.com/playwright/python:v1.51.0-noble

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=pwuser:pwuser server ./server
COPY --chown=pwuser:pwuser web ./web
COPY --chown=pwuser:pwuser index.html video.html run_local.py ./

# /data holds uploads, results and the job database. Mount a volume there to
# keep it across restarts; otherwise it is lost when the container is replaced.
RUN mkdir /data && chown pwuser:pwuser /data
VOLUME /data

ENV ECHOSPHERE_DATA=/data \
    ECHOSPHERE_HOST=0.0.0.0 \
    ECHOSPHERE_PORT=8765 \
    ECHOSPHERE_BEHIND_PROXY=1 \
    ECHOSPHERE_NO_SANDBOX=1 \
    ECHOSPHERE_RETENTION_HOURS=24 \
    ECHOSPHERE_MAX_STORAGE_GB=5
# Required at run time (never bake them into the image):
#   ECHOSPHERE_API_KEY          at least 24 random characters
#   ECHOSPHERE_ALLOWED_HOSTS    comma-separated public hostname(s)

USER pwuser
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request,os;urllib.request.urlopen('http://127.0.0.1:'+os.environ['ECHOSPHERE_PORT']+'/health',timeout=4)" || exit 1
CMD ["python", "run_local.py"]
