#!/bin/bash
set -e

echo "Running Alembic migrations..."
alembic upgrade head

echo "Starting gunicorn..."
exec gunicorn \
    --bind 0.0.0.0:5001 \
    --workers 1 \
    --threads 4 \
    --timeout 120 \
    "app:create_app()"
