FROM python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7

ENV HOME=/home/hound \
    HOUND_BROWSER_IDLE_TIMEOUT=300 \
    NO_COLOR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    XDG_CACHE_HOME=/home/hound/.hound/cache

# Hound, Playwright, Patchright, and every Python/OCR dependency are locked to
# exact artifacts. Regenerate the lock explicitly from requirements.in.
COPY build-requirements.lock /tmp/hound-build-requirements.lock
COPY requirements.lock /tmp/hound-requirements.lock

RUN pip install --require-hashes -r /tmp/hound-build-requirements.lock \
  && pip install --no-build-isolation --require-hashes -r /tmp/hound-requirements.lock \
  && playwright install --with-deps chromium \
  && patchright install chromium \
  && pip uninstall --yes setuptools wheel \
  && rm -f /tmp/hound-build-requirements.lock /tmp/hound-requirements.lock \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 hound \
  && mkdir -p /home/hound/.hound \
  && chown -R hound:hound /home/hound /ms-playwright

COPY --chmod=0755 --chown=hound:hound entrypoint.sh /usr/local/bin/hound-entrypoint

USER hound
WORKDIR /home/hound

VOLUME ["/home/hound/.hound"]
EXPOSE 8765

HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=5 \
  CMD python -c "import socket; socket.getaddrinfo('hound-firewall', 8765, type=socket.SOCK_STREAM); socket.create_connection(('127.0.0.1', 8765), 2).close()"

ENTRYPOINT ["hound-entrypoint"]
CMD ["hound", "--http", "--host", "0.0.0.0", "--port", "8765"]
