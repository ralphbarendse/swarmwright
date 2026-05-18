#!/bin/bash
set -e

echo "Running Alembic migrations..."
alembic upgrade head

echo "Installing packages from system.allowed_packages..."
python3 - <<'PYEOF'
import json, subprocess, sys, os

db_path = os.environ.get("DATABASE_URL", "sqlite:////data/swarm.db")
db_path = db_path.replace("sqlite:////", "/").replace("sqlite:///", "")

try:
    import sqlite3
    conn = sqlite3.connect(db_path)
    row = conn.execute(
        "SELECT value_encrypted FROM settings WHERE key='system.allowed_packages'"
    ).fetchone()
    conn.close()
    pkgs = json.loads(row[0]) if (row and row[0]) else []
    for pkg in pkgs:
        r = subprocess.run(
            [sys.executable, "-m", "pip", "install", "--quiet", pkg],
            capture_output=True, text=True,
        )
        status = "ok" if r.returncode == 0 else "FAILED"
        print(f"  [{status}] {pkg}", flush=True)
except Exception as e:
    print(f"  Package auto-install skipped: {e}", flush=True)
PYEOF

echo "Starting gunicorn..."
exec gunicorn \
    --bind 0.0.0.0:5001 \
    --workers 1 \
    --threads 4 \
    --timeout 120 \
    "app:create_app()"
