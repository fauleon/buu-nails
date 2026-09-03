FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY railway.toml ./

RUN useradd --create-home appuser && mkdir -p /app/uploads && chown -R appuser:appuser /app

# Railway mounts persistent volumes as root. Initialize only that mount, then
# drop privileges before the web application starts.
CMD ["sh", "-c", "if [ -d /data ]; then mkdir -p /data/uploads && chown -R appuser:appuser /data; fi; exec su -s /bin/sh appuser -c 'uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}'"]
