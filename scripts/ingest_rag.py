"""Ingest a local repo into an Azure AI Search index for Argus RAG.

Usage:
  REPO_DIR=/path/to/repository \
  AZURE_ENDPOINT=https://<search-service>.search.windows.net \
  AZURE_INDEX=agent-test \
  AZURE_ADMIN_KEY=... \
  python scripts/ingest_rag.py

Reads files from REPO_DIR, chunks them, embeds via Argus Gateway
(the configured provider's `/v1/embeddings` endpoint), and uploads to Azure AI Search.
"""

import json
import os
import sys
import time
from pathlib import Path
from typing import List, Dict
from urllib.parse import quote

import requests

# --- Config -----------------------------------------------------------------
REPO_DIR = Path(os.environ.get("REPO_DIR", "."))
AZURE_ENDPOINT = os.environ.get("AZURE_ENDPOINT", "")
AZURE_INDEX = os.environ.get("AZURE_INDEX", "agent-test")
AZURE_ADMIN_KEY = os.environ.get("AZURE_ADMIN_KEY", "")
EMBED_URL = os.environ.get("EMBED_URL", "http://localhost:3000")
EMBED_KEY = os.environ.get("EMBED_KEY", "")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "text-embedding-3-large")
CHUNK_SIZE = int(os.environ.get("CHUNK_SIZE", "1500"))
CHUNK_OVERLAP = int(os.environ.get("CHUNK_OVERLAP", "200"))
EMBED_BATCH = int(os.environ.get("EMBED_BATCH", "16"))

for name, value in (("AZURE_ENDPOINT", AZURE_ENDPOINT), ("AZURE_ADMIN_KEY", AZURE_ADMIN_KEY), ("EMBED_KEY", EMBED_KEY)):
    if not value:
        print(f"ERROR: set {name} env var", file=sys.stderr)
        sys.exit(1)
if not REPO_DIR.exists():
    print(f"ERROR: REPO_DIR {REPO_DIR} does not exist", file=sys.stderr)
    sys.exit(1)

# --- File filters -----------------------------------------------------------
SKIP_DIRS = {
    "node_modules", "__pycache__", ".venv", "venv", ".git",
    "dist", "build", ".next", ".vite", ".pytest_cache",
    ".mypy_cache", ".ruff_cache", "htmlcov", "coverage",
    ".idea", ".vscode", "playwright-report", "test-results",
    ".cache",
}
SKIP_FILES = {".DS_Store", "uv.lock", "bun.lock", "package-lock.json", "yarn.lock"}
SKIP_EXTENSIONS = {
    ".pyc", ".log", ".png", ".jpg", ".jpeg", ".gif", ".ico",
    ".svg", ".woff", ".woff2", ".ttf", ".eot", ".otf",
    ".min.js", ".min.css", ".map",
}
INCLUDE_EXTENSIONS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".json", ".md", ".mdx", ".txt", ".yaml", ".yml",
    ".toml", ".ini", ".cfg", ".sh", ".sql",
    ".css", ".scss", ".html", ".env.example",
}
INCLUDE_NAMES = {
    "Dockerfile", "Jenkinsfile", "Dockerfile.playwright",
    "nginx.conf", "biome.json", ".gitignore", ".env.example",
    "Makefile", "LICENSE",
}
MAX_FILE_BYTES = 200_000


def should_include(p: Path) -> bool:
    if any(part in SKIP_DIRS for part in p.parts):
        return False
    if p.name in SKIP_FILES:
        return False
    if p.suffix.lower() in SKIP_EXTENSIONS:
        return False
    if p.name in INCLUDE_NAMES:
        return True
    if p.suffix.lower() in INCLUDE_EXTENSIONS:
        return True
    return False


def chunk_text(text: str, size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> List[str]:
    if len(text) <= size:
        return [text]
    chunks: List[str] = []
    start = 0
    while start < len(text):
        end = start + size
        chunks.append(text[start:end])
        if end >= len(text):
            break
        start = end - overlap
    return chunks


def safe_id(rel: str, idx: int) -> str:
    """Azure AI Search keys: letters, digits, underscore, dash, equal sign."""
    cleaned = []
    for c in rel:
        if c.isalnum() or c in ("_", "-"):
            cleaned.append(c)
        else:
            cleaned.append("_")
    safe = "".join(cleaned).lstrip("_") or "file"
    return f"f_{safe}_{idx}"


def embed_batch(texts: List[str]) -> List[List[float]]:
    resp = requests.post(
        f"{EMBED_URL}/v1/embeddings",
        headers={"Authorization": f"Bearer {EMBED_KEY}", "Content-Type": "application/json"},
        json={"model": EMBED_MODEL, "input": texts},
        timeout=120,
    )
    resp.raise_for_status()
    return [d["embedding"] for d in resp.json()["data"]]


def upload_batch(docs: List[Dict]) -> None:
    body = {"value": [{"@search.action": "mergeOrUpload", **d} for d in docs]}
    resp = requests.post(
        f"{AZURE_ENDPOINT}/indexes/{quote(AZURE_INDEX)}/docs/index?api-version=2023-11-01",
        headers={"Content-Type": "application/json", "api-key": AZURE_ADMIN_KEY},
        json=body,
        timeout=60,
    )
    if resp.status_code >= 400:
        print(f"  upload error {resp.status_code}: {resp.text[:300]}", file=sys.stderr)
    resp.raise_for_status()


def main() -> None:
    files = []
    for path in REPO_DIR.rglob("*"):
        if not path.is_file() or not should_include(path):
            continue
        try:
            if path.stat().st_size > MAX_FILE_BYTES:
                continue
        except OSError:
            continue
        rel = str(path.relative_to(REPO_DIR)).replace("\\", "/")
        files.append((path, rel))

    print(f"Files to ingest: {len(files)}")

    docs: List[Dict] = []
    for path, rel in files:
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError) as e:
            print(f"  skip {rel}: {e}")
            continue
        if not text.strip():
            continue
        for i, chunk in enumerate(chunk_text(text)):
            docs.append({
                "id": safe_id(rel, i),
                "content": chunk,
                "title": path.name,
                "path": rel,
                "chunk_index": i,
            })

    print(f"Chunks total: {len(docs)}")
    print(f"Embedding batch={EMBED_BATCH} via {EMBED_URL} model={EMBED_MODEL}")

    uploaded = 0
    for i in range(0, len(docs), EMBED_BATCH):
        batch = docs[i:i + EMBED_BATCH]
        texts = [d["content"] for d in batch]
        try:
            embeds = embed_batch(texts)
        except Exception as e:
            print(f"  embed batch {i} failed: {e}", file=sys.stderr)
            continue
        for d, vec in zip(batch, embeds):
            d["contentVector"] = vec
        try:
            upload_batch(batch)
        except Exception as e:
            print(f"  upload batch {i} failed: {e}", file=sys.stderr)
            continue
        uploaded += len(batch)
        print(f"  {uploaded}/{len(docs)} uploaded")
        time.sleep(0.1)

    print(f"\nDone. Uploaded {uploaded} chunks to {AZURE_INDEX}.")


if __name__ == "__main__":
    main()
