FROM python:3.12-slim

# System deps (needed for cryptography wheel and watchdog)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libffi-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy project and install (pyproject.toml drives deps)
COPY pyproject.toml .
COPY app/ app/
COPY migrations/ migrations/
COPY alembic.ini .

RUN pip install --no-cache-dir ".[dev]"

# Data volume — survives container rebuilds
VOLUME ["/data"]

EXPOSE 5001

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
