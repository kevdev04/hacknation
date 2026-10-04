#!/usr/bin/env bash
# Start the Gate API and the VR dev server together, and (if a Quest is
# attached over USB) forward port 5173 so the headset can open
# http://localhost:5173 — which counts as a secure context for WebXR.
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -d gate/.venv ]; then
  echo "setting up gate/.venv"
  python3 -m venv gate/.venv
  gate/.venv/bin/pip install -q fastapi 'uvicorn[standard]' httpx
fi
[ -d vr/node_modules ] || (cd vr && npm install)

cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# The agent lab bridge runs separately (hack-databricks repo, port 8010 so it
# does not collide with the gate). Point the gate at it with BRIDGE_URL; if it
# is not running the gate falls back to the mock queue on its own.
export BRIDGE_URL="${BRIDGE_URL:-http://127.0.0.1:8010}"

gate/.venv/bin/python -m uvicorn main:app --app-dir gate --host 0.0.0.0 --port 8000 &

until curl -sf http://127.0.0.1:8000/health >/dev/null 2>&1; do sleep 0.3; done
echo "gate api  → http://127.0.0.1:8000  (docs at /docs)"
if curl -sf "$BRIDGE_URL/health" >/dev/null 2>&1; then
  echo "agent lab → $BRIDGE_URL  (connected)"
else
  echo "agent lab → $BRIDGE_URL  (not running; gate uses the mock queue)"
fi

if command -v adb >/dev/null && [ -n "$(adb devices | sed -n '2p')" ]; then
  adb reverse tcp:5173 tcp:5173 && echo "quest      → open http://localhost:5173 in the headset browser"
else
  echo "no adb device; for the headset use a tunnel or HTTPS=1 npm run dev"
fi

(cd vr && npm run dev) &
wait
