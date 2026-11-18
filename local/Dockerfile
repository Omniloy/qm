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
  && tesseract --list-langs \
  && ffmpeg -hide_banner -version | head -n 1

ENV PIP_NO_CACHE_DIR=1
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
ENV HF_HUB_CACHE=/opt/hf-cache

RUN pip install \
      beautifulsoup4==4.15.0 \
      faster-whisper==1.2.1 \
      httpx==0.28.1 \
      lxml==6.1.3 \
      numpy==2.4.6 \
      openpyxl==3.1.5 \
      pdfplumber==0.11.10 \
      pillow==13.0.0 \
      playwright==1.65.2 \
      psutil==7.2.2 \
      pymupdf==2.1 \
      pymupdf4llm==2.1 \
      pypdf==7.1.0 \
      python-docx==1.2.0 \
      python-pptx==1.0.2 \
      pyyaml==6.0.3 \
      reportlab==5.0.1 \
      requests==2.34.2 \
      tabulate==0.10.0 \
      xlsxwriter==3.3.1

RUN playwright install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/* \
  && python -c "from faster_whisper import download_model; download_model('small')" \
  && rm -rf /root/.cache

COPY aws/microvm-agent/agent.mjs /opt/microvm-agent/agent.mjs

ENV HOME=/root
WORKDIR /root
EXPOSE 8080
CMD ["node", "/opt/microvm-agent/agent.mjs"]
