#!/usr/bin/env python3
"""Pack src/app.dc.html into the bundled public/index.html.

public/index.html is a self-unpacking bundle: a loader script, a manifest of
embedded assets (React, the DC runtime, fonts) and the app template as a JSON
string. This script replaces only the template, so the app can be edited as
plain HTML in src/app.dc.html.

Usage (from the project folder): python3 -I tools/build.py
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src", "app.dc.html")
OUT = os.path.join(ROOT, "public", "index.html")

lines = open(OUT, encoding="utf-8").read().split("\n")
i = next(n for n, l in enumerate(lines) if '<script type="__bundler/template">' in l)
template = open(SRC, encoding="utf-8").read()
lines[i + 1] = json.dumps(template, ensure_ascii=False).replace("</", "<\\u002F")
open(OUT, "w", encoding="utf-8").write("\n".join(lines))
print("built", os.path.relpath(OUT, ROOT), f"({len(template):,} chars of app template)")
