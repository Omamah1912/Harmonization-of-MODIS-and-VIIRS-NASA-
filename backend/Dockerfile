# Emberline API — Hugging Face Spaces (Docker SDK) / Render. Build from the repo root:
#   docker build -f backend/Dockerfile -t emberline-api .
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=7860
RUN useradd -m -u 1000 user
WORKDIR /home/user/app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY --chown=user pipeline/ pipeline/
COPY --chown=user backend/ backend/
COPY --chown=user data/processed/ data/processed/
COPY --chown=user data/boundaries/ data/boundaries/
COPY --chown=user frontend/ frontend/
USER user
EXPOSE 7860
CMD ["sh", "-c", "uvicorn backend.app.main:app --host 0.0.0.0 --port ${PORT}"]
