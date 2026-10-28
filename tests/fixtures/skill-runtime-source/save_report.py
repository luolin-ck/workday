#!/usr/bin/env python3
"""Compute the final save path for a research-dossier HTML report.

Usage:
    python3 save_report.py "<Topic>" [--dir <output_dir>] [--ext html]

Behavior:
- Converts the topic to kebab-case (ASCII-safe, preserves CJK).
- Resolves the output directory (defaults to current working directory).
- If the target file already exists, appends an ISO date stamp; if that also
  exists, appends a numeric suffix until a free name is found.
- Prints the absolute path on stdout. Exits 0 on success, non-zero on error.

This script is stdlib-only and side-effect free (it does NOT create the file).
The caller (the research-dossier skill) is responsible for writing content.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import os
import re
import sys
import unicodedata
from pathlib import Path

_SAFE = re.compile(r"[^a-z0-9\u4e00-\u9fff\-]+")
_DASHES = re.compile(r"-{2,}")


def to_kebab(topic: str) -> str:
    """Convert an arbitrary topic string into a filesystem-safe kebab token.

    Lowercases ASCII, preserves CJK ideographs, collapses everything else
    into single hyphens. Strips leading/trailing hyphens.
    """
    text = unicodedata.normalize("NFKC", topic).strip().lower()
    text = re.sub(r"\s+", "-", text)
    text = _SAFE.sub("-", text)
    text = _DASHES.sub("-", text).strip("-")
    if not text:
        text = "research-report"
    return text[:120]


def resolve_path(topic: str, out_dir: Path, ext: str) -> Path:
    base = to_kebab(topic)
    candidate = out_dir / f"{base}.{ext}"
    if not candidate.exists():
        return candidate

    stamp = _dt.date.today().isoformat()
    candidate = out_dir / f"{base}-{stamp}.{ext}"
    if not candidate.exists():
        return candidate

    n = 2
    while True:
        candidate = out_dir / f"{base}-{stamp}-{n}.{ext}"
        if not candidate.exists():
            return candidate
        n += 1
        if n > 999:
            raise RuntimeError("Could not find a free filename after 999 attempts")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("topic", help="Research topic (any string)")
    parser.add_argument(
        "--dir",
        default=os.getcwd(),
        help="Output directory (default: current working directory)",
    )
    parser.add_argument(
        "--ext",
        default="html",
        choices=["html", "md"],
        help="File extension (default: html)",
    )
    args = parser.parse_args(argv)

    out_dir = Path(args.dir).resolve()
    if not out_dir.is_dir():
        print(f"error: directory does not exist: {out_dir}", file=sys.stderr)
        return 2

    final = resolve_path(args.topic, out_dir, args.ext)
    print(final)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
