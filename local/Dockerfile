ARG BASE=qm-sandbox-base:dev
FROM ${BASE}

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer libreoffice-calc libreoffice-impress \
      fonts-crosextra-carlito fonts-crosextra-caladea fonts-dejavu-core \
      tesseract-ocr tesseract-ocr-spa \
      poppler-utils ffmpeg libatomic1 \
  && rm -rf /var/lib/apt/lists/* \
  && soffice --version \
  && tesseract --list-langs 2>&1 | grep -qx spa \
  && pdftotext -v \
  && ffmpeg -hide_banner -version >/dev/null

ENV PIP_NO_CACHE_DIR=1
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
ENV HF_HUB_CACHE=/opt/hf-cache

COPY local/agent-constraints.txt /tmp/agent-constraints.txt
RUN pip install -c /tmp/agent-constraints.txt \
      beautifulsoup4 \
      faster-whisper \
      httpx \
      lxml \
      numpy \
      openpyxl \
      pdfplumber \
      pillow \
      playwright \
      psutil \
      pymupdf \
      pymupdf4llm \
      pypdf \
      python-docx \
      python-pptx \
      pyyaml \
      reportlab \
      requests \
      tabulate \
      xlsxwriter \
  && pip check \
  && rm /tmp/agent-constraints.txt

RUN playwright install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/* \
  && python -c "from playwright.sync_api import sync_playwright; p = sync_playwright().start(); p.chromium.launch().close(); p.stop()" \
  && python -c "from faster_whisper import download_model; download_model('small')" \
  && HF_HUB_OFFLINE=1 python -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')" \
  && rm -rf /root/.cache

COPY aws/microvm-agent/agent.mjs /opt/microvm-agent/agent.mjs

ENV HOME=/root
WORKDIR /root
EXPOSE 8080
CMD ["node", "/opt/microvm-agent/agent.mjs"]
