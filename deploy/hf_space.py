"""Deploy the API (+ built frontend) to a Hugging Face Docker Space.

    pip install huggingface_hub
    set HF_TOKEN=...            (write token from https://huggingface.co/settings/tokens)
    python deploy/hf_space.py <username>/emberline

Stages a folder with the Space README (sdk: docker), Dockerfile at the root, code, processed data and
frontend/dist (so the Space serves the whole app at one URL), then uploads it. Never uploads .env or raw data.
"""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STAGE = ROOT / "deploy" / "_hf_stage"

README = """---
title: Emberline
emoji: 🔥
colorFrom: purple
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
---
Emberline — harmonized MODIS + VIIRS burning-activity calendar for Corrientes, Argentina (NASA Space Apps 2026).
Data: NASA FIRMS. API under /api, web app at /.
"""


def stage() -> None:
    if STAGE.exists():
        shutil.rmtree(STAGE)
    STAGE.mkdir(parents=True)
    (STAGE / "README.md").write_text(README, encoding="utf-8")
    shutil.copy(ROOT / "backend" / "Dockerfile", STAGE / "Dockerfile")
    ign = shutil.ignore_patterns("__pycache__", "*.pyc", "tests", ".pytest_cache")
    shutil.copytree(ROOT / "pipeline", STAGE / "pipeline", ignore=ign)
    shutil.copytree(ROOT / "backend", STAGE / "backend", ignore=ign)
    shutil.copytree(ROOT / "data" / "processed", STAGE / "data" / "processed")
    (STAGE / "data" / "boundaries").mkdir(parents=True)
    for f in ("corrientes_adm1.geojson", "corrientes_adm2.geojson"):
        shutil.copy(ROOT / "data" / "boundaries" / f, STAGE / "data" / "boundaries" / f)
    dist = ROOT / "frontend" / "dist"
    if dist.exists():
        shutil.copytree(dist, STAGE / "frontend" / "dist")
    assert not list(STAGE.rglob(".env")), "refusing to upload .env"


def main() -> None:
    repo = sys.argv[1]
    stage()
    from huggingface_hub import HfApi

    api = HfApi(token=os.environ["HF_TOKEN"])
    api.create_repo(repo, repo_type="space", space_sdk="docker", exist_ok=True)
    api.upload_folder(folder_path=str(STAGE), repo_id=repo, repo_type="space", commit_message="deploy emberline")
    print(f"https://huggingface.co/spaces/{repo}  →  app: https://{repo.replace('/', '-').lower()}.hf.space")


if __name__ == "__main__":
    main()
