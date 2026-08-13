#!/usr/bin/env python3
"""Semantic search over the AI-coding sessions starforge has scanned.

Called by starforge-cli as a subprocess — not meant to be run directly,
but every command works standalone too:

    python3 src/search.py index           # embed sessions → ~/.starforge/search-index/
    python3 src/search.py query "auth"    # retrieve + rerank
    python3 src/search.py query "SQL injection" --top 20
    python3 src/search.py status          # show what is indexed

TWO MODELS, ONE REASON EACH

  cisco-ai/SecureBERT2.0-biencoder     fast candidate retrieval (ANN search)
  cisco-ai/SecureBERT2.0-cross_encoder precise reranking of the top-k candidates

The biencoder turns every session into a fixed-length vector stored in a FAISS
flat index. A query embeds once, searches in milliseconds. The cross-encoder
then re-reads the top-k (query, passage) pairs and rescores them with full
attention — slower but orders of magnitude more accurate on security-domain
content, which is what SecureBERT was trained for.

Both models are pre-downloaded by `starforge-cli search --setup` (which runs
`python3 src/search.py setup`) into ~/.starforge/.venv-search/.

DATA SOURCES

Sessions come from the same sources starforge scans:
  ~/.claude/projects/       Claude Code transcripts
  ~/.codex/sessions/        Codex sessions
  ~/.gemini/, ~/.continue/  other CLIs starforge knows about

One document per session:
  - project label (redacted path last segment)
  - CLI + model
  - date
  - first 1024 chars of first human turn
  - tool names used

WHERE THE INDEX LIVES

  ~/.starforge/search-index/
      index.faiss   FAISS flat L2 index (one vector per session)
      docs.json     metadata: session_id, project, start, model, cli, snippet
"""

import argparse
import json
import os
import pathlib
import re
import sys

HOME        = pathlib.Path.home()
STARFORGE   = HOME / ".starforge"
INDEX_DIR   = STARFORGE / "search-index"
VENV        = STARFORGE / ".venv-search"
VENV_PY     = VENV / "bin" / "python"

BIENCODER    = "cisco-ai/SecureBERT2.0-biencoder"
CROSSENCODER = "cisco-ai/SecureBERT2.0-cross_encoder"

TOP_CANDIDATES = 50
TOP_RESULTS    = 10

# ── Setup guard ───────────────────────────────────────────────────────────────

def _require_venv():
    if not VENV_PY.is_file():
        print("  search environment is not set up yet.")
        print()
        print("  Run:  starforge-cli search --setup")
        print("  That creates ~/.starforge/.venv-search and downloads")
        print("  both SecureBERT models (~600 MB) into ~/.starforge/.venv-search/.")
        sys.exit(1)

# ── Model loading ─────────────────────────────────────────────────────────────

def _load_models():
    site = list(VENV.glob("lib/python*/site-packages"))
    if not site:
        _require_venv()
    sys.path.insert(0, str(site[0]))

    os.environ.setdefault(
        "HF_HOME", str(STARFORGE / ".venv-search" / "models"))
    os.environ["HF_HUB_OFFLINE"] = "1"   # never hit the network at inference

    try:
        from sentence_transformers import SentenceTransformer, CrossEncoder
    except ImportError:
        print("  sentence-transformers not importable from the venv.")
        print("  Re-run:  starforge-cli search --setup")
        sys.exit(1)

    try:
        bi    = SentenceTransformer(BIENCODER)
        cross = CrossEncoder(CROSSENCODER)
    except Exception as e:
        print(f"  Could not load models: {e}")
        print("  Re-run:  starforge-cli search --setup")
        sys.exit(1)

    return bi, cross

# ── Session discovery — same sources starforge scans ─────────────────────────

def _first_human_turn(transcript_path, max_chars=1024):
    p = pathlib.Path(transcript_path)
    if not p.is_file():
        return ""
    try:
        with p.open(encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                role = row.get("type") or row.get("role") or ""
                if role in ("human", "user"):
                    content = row.get("content") or row.get("message") or ""
                    if isinstance(content, list):
                        parts = [c.get("text", "") for c in content
                                 if isinstance(c, dict) and c.get("type") == "text"]
                        content = " ".join(parts)
                    if isinstance(content, str) and content.strip():
                        return content[:max_chars]
    except Exception:
        pass
    return ""

def _tool_names(transcript_path):
    p = pathlib.Path(transcript_path)
    if not p.is_file():
        return []
    names = set()
    try:
        with p.open(encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if row.get("type") == "tool_use":
                    name = row.get("name")
                    if name:
                        names.add(name)
    except Exception:
        pass
    return sorted(names)

def _discover_sources(roots):
    """Yield (cli, path) for every transcript file in the given home roots."""
    for root in roots:
        root = pathlib.Path(root)
        # Claude Code
        claude_base = root / ".claude" / "projects"
        if claude_base.is_dir():
            for f in sorted(claude_base.rglob("*.jsonl")):
                yield "claude", f
        # Codex
        codex_base = root / ".codex" / "sessions"
        if codex_base.is_dir():
            for f in sorted(codex_base.rglob("*.json")):
                yield "codex", f
        # Gemini tmp
        gemini_base = root / ".gemini" / "tmp"
        if gemini_base.is_dir():
            for f in sorted(gemini_base.rglob("session-*.jsonl")) :
                yield "gemini", f
            for f in sorted(gemini_base.rglob("session-*.json")):
                yield "gemini", f

def _project_label(path):
    """Best-effort project label from a transcript path."""
    parts = pathlib.Path(path).parts
    # For claude: .claude/projects/<encoded-dir>/session.jsonl
    # Return the last two segments of the encoded dir (already redacted)
    for i, p in enumerate(parts):
        if p == "projects" and i + 1 < len(parts):
            label = parts[i + 1]
            # Decode %-encoded slashes back to path separators
            label = re.sub(r'-[A-Fa-f0-9]{2}', lambda m: chr(int(m.group(0)[1:], 16))
                           if int(m.group(0)[1:], 16) < 128 else m.group(0), label)
            # Take last two segments
            segs = [s for s in re.split(r'[\\/]', label) if s]
            return "/".join(segs[-2:]) if len(segs) >= 2 else segs[-1] if segs else label
    return pathlib.Path(path).parent.name

def _make_document(cli, path, snippet, tools):
    parts = [f"project: {_project_label(path)}",
             f"cli: {cli}",
             f"file: {pathlib.Path(path).name}"]
    if snippet:
        parts.append(snippet)
    if tools:
        parts.append("tools: " + ", ".join(tools[:20]))
    return "\n".join(parts)

# ── index command ─────────────────────────────────────────────────────────────

def cmd_index(args):
    _require_venv()
    bi, _ = _load_models()

    try:
        import faiss
        import numpy as np
    except ImportError:
        print("  faiss not available.")
        print("  Run:  starforge-cli search --setup")
        sys.exit(1)

    roots = args.roots if args.roots else [str(HOME)]
    sources = list(_discover_sources(roots))
    if not sources:
        print("  no session files found — run starforge-cli first to scan")
        sys.exit(0)

    print(f"  indexing {len(sources)} session file(s)...", end="", flush=True)

    docs, meta = [], []
    for cli, path in sources:
        snippet = _first_human_turn(str(path))
        tools   = _tool_names(str(path))
        docs.append(_make_document(cli, path, snippet, tools))
        meta.append({
            "cli":     cli,
            "path":    str(path),
            "project": _project_label(path),
            "snippet": snippet[:200],
            "tools":   tools[:10],
        })

    vecs = bi.encode(docs, show_progress_bar=False, convert_to_numpy=True)
    vecs = vecs.astype(__import__("numpy").float32)
    norms = __import__("numpy").linalg.norm(vecs, axis=1, keepdims=True)
    norms[norms == 0] = 1
    vecs /= norms

    dim = vecs.shape[1]
    index = faiss.IndexFlatIP(dim)
    index.add(vecs)

    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    faiss.write_index(index, str(INDEX_DIR / "index.faiss"))
    (INDEX_DIR / "docs.json").write_text(
        json.dumps(meta, indent=1), encoding="utf-8")

    print(f"  done  ({index.ntotal} sessions, {dim}-dim → {INDEX_DIR})")

# ── query command ─────────────────────────────────────────────────────────────

def cmd_query(args):
    _require_venv()

    idx_path = INDEX_DIR / "index.faiss"
    doc_path = INDEX_DIR / "docs.json"
    if not idx_path.is_file():
        print("  no index found. Run:  starforge-cli search --index")
        sys.exit(1)

    bi, cross = _load_models()

    try:
        import faiss
        import numpy as np
    except ImportError:
        print("  faiss not available. Run:  starforge-cli search --setup")
        sys.exit(1)

    index = faiss.read_index(str(idx_path))
    all_meta = json.loads(doc_path.read_text(encoding="utf-8"))

    query = args.query
    print(f"\n  query: {query!r}\n")

    qvec = bi.encode([query], convert_to_numpy=True).astype(np.float32)
    qvec /= max(np.linalg.norm(qvec), 1e-9)

    k = min(TOP_CANDIDATES, index.ntotal)
    scores, ids = index.search(qvec, k)

    candidates = [(float(scores[0][i]), all_meta[ids[0][i]])
                  for i in range(k) if ids[0][i] >= 0]

    if not candidates:
        print("  no results")
        return

    pairs = [(query, c[1].get("snippet", "")) for c in candidates]
    ce_scores = cross.predict(pairs)

    reranked = sorted(zip(ce_scores, candidates), key=lambda x: -x[0])
    top_n = reranked[:args.top]

    for rank, (ce_score, (bi_score, doc)) in enumerate(top_n, 1):
        proj  = doc.get("project", "?") or "?"
        cli   = doc.get("cli", "?")
        tools = ", ".join(doc.get("tools", [])[:5]) or "—"
        snip  = doc.get("snippet", "")
        snip_line = (snip[:120] + "…") if len(snip) > 120 else snip
        snip_line = snip_line.replace("\n", " ")
        path  = doc.get("path", "")
        fname = pathlib.Path(path).name if path else "?"
        print(f"  [{rank:2}]  {ce_score:+.3f}  {proj}  {cli}  {fname}")
        if tools != "—":
            print(f"         tools: {tools}")
        if snip_line:
            print(f"         {snip_line}")
        print()

# ── status command ────────────────────────────────────────────────────────────

def cmd_status(args):
    venv_ok  = VENV_PY.is_file()
    idx_ok   = (INDEX_DIR / "index.faiss").is_file()
    doc_path = INDEX_DIR / "docs.json"
    n_idx    = 0
    if doc_path.is_file():
        try:
            n_idx = len(json.loads(doc_path.read_text(encoding="utf-8")))
        except Exception:
            pass
    print(f"  venv:   {'yes — ' + str(VENV) if venv_ok else 'NOT SET UP'}")
    print(f"  index:  {'yes — ' + str(INDEX_DIR) + ' (' + str(n_idx) + ' sessions)' if idx_ok else 'NOT BUILT'}")
    if not venv_ok:
        print("\n  Run:  starforge-cli search --setup")
    elif not idx_ok:
        print("\n  Run:  starforge-cli search --index")

# ── setup command ─────────────────────────────────────────────────────────────

def cmd_setup(args):
    import subprocess
    venv_ok = VENV_PY.is_file()
    if not venv_ok:
        print(f"  creating venv at {VENV} ...")
        result = subprocess.run(
            [sys.executable, "-m", "venv", str(VENV)],
            capture_output=True, text=True)
        if result.returncode != 0:
            print(f"  venv creation failed: {result.stderr}")
            sys.exit(1)
        print("  done")

    pip = VENV / "bin" / "pip"
    print("  installing sentence-transformers + faiss-cpu ...")
    result = subprocess.run(
        [str(pip), "install", "--quiet",
         "sentence-transformers", "faiss-cpu"],
        capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  install failed: {result.stderr[-500:]}")
        sys.exit(1)
    print("  done")

    # Pre-download models into the venv's own model cache (no HF_HOME needed)
    model_cache = VENV / "models"
    model_cache.mkdir(exist_ok=True)
    os.environ["HF_HOME"] = str(model_cache)
    os.environ.pop("HF_HUB_OFFLINE", None)

    site = list(VENV.glob("lib/python*/site-packages"))
    if site:
        sys.path.insert(0, str(site[0]))

    print(f"  downloading {BIENCODER} (~300 MB) ...")
    try:
        from sentence_transformers import SentenceTransformer, CrossEncoder
        SentenceTransformer(BIENCODER)
        print("  done")
        print(f"  downloading {CROSSENCODER} (~300 MB) ...")
        CrossEncoder(CROSSENCODER)
        print("  done")
    except Exception as e:
        print(f"  download failed: {e}")
        print("  check your internet connection and try again")
        sys.exit(1)

    print(f"\n  setup complete. Run:  starforge-cli search --index")

# ── main ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Semantic search over starforge sessions")
    ap.add_argument("--roots", nargs="*", help="extra home roots to scan")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("setup",  help="create venv and download SecureBERT models")
    sub.add_parser("index",  help="embed all sessions into the FAISS index")
    sub.add_parser("status", help="show index state")

    qp = sub.add_parser("query", help="semantic search")
    qp.add_argument("query", help="free-text search query")
    qp.add_argument("--top", type=int, default=TOP_RESULTS)

    args = ap.parse_args()
    {"setup": cmd_setup, "index": cmd_index,
     "status": cmd_status, "query": cmd_query}[args.cmd](args)

if __name__ == "__main__":
    main()
