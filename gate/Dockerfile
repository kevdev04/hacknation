# The Gate API as a Cloudflare Container (see cloudflare/wrangler.jsonc).
# Build context is gate/, so this image carries the code and data/petase.pdb
# and nothing else — no .env, no state. Secrets arrive as env vars from the
# Worker; state/ starts empty on every cold start.
FROM python:3.14-slim

WORKDIR /app/gate
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py ./
COPY data ./data

EXPOSE 8000
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
