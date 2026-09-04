FROM python:3.11-slim

# Git is required because requirements.txt installs
# noobpwnftw/python-chess directly from GitHub.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

# Run as a non-root user rather than the image's default root — good
# practice for any container host. UID 1000 has no special meaning to
# Render (it just needs to own /app below); it's kept because it also
# happens to match Hugging Face Docker Spaces' convention, in case this
# same image is ever run there too.
RUN useradd -m -u 1000 user

WORKDIR /app

# Install Python dependencies first so Docker can cache this layer.
COPY --chown=user requirements.txt /app/requirements.txt

RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r /app/requirements.txt

# Copy the actual application.
COPY --chown=user . /app

USER user

ENV HOME=/home/user
ENV PATH=/home/user/.local/bin:$PATH
ENV PYTHONUNBUFFERED=1

# Purely informational -- config.py's PORT reads the platform's own PORT
# environment variable at runtime (falling back to 7860 only when it's
# unset) and that's the port actually bound, regardless of this EXPOSE
# value. Render assigns and injects PORT itself (see render.yaml /
# README.md "Deploying to Render"), so nothing needs to change here to
# match it; 7860 is kept as the documented default for a local
# `docker run` with no PORT set, and for Hugging Face Docker Spaces,
# which does expect 7860 specifically.
EXPOSE 7860

CMD ["python", "app.py"]
