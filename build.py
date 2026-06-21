#!/usr/bin/env python3
"""Build the deployable site into ./_site.

Injects the current data.json into the <script id="schedule-data"> block of
index.html so that data.json is the single source of truth — editing it and
pushing is enough to update the published map. Run locally or in CI.
"""
import json
import pathlib
import shutil
import sys

ROOT = pathlib.Path(__file__).parent
OUT = ROOT / "_site"
START = '<script id="schedule-data" type="application/json">'
END = "</script>"


def main():
    data = json.loads((ROOT / "data.json").read_text(encoding="utf-8"))
    n_loc = len(data["locations"])
    n_appt = sum(len(loc["appts"]) for loc in data["locations"])
    blob = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    if "</script>" in blob:
        sys.exit("ERROR: data contains '</script>' — would break the HTML")

    html = (ROOT / "index.html").read_text(encoding="utf-8")
    i = html.find(START)
    if i == -1:
        sys.exit(f"ERROR: marker {START!r} not found in index.html")
    body_start = i + len(START)
    j = html.find(END, body_start)
    if j == -1:
        sys.exit("ERROR: closing </script> for schedule-data not found")
    html = html[:body_start] + blob + html[j:]

    OUT.mkdir(exist_ok=True)
    (OUT / "index.html").write_text(html, encoding="utf-8")
    # 404 fallback + nojekyll keep Pages from touching anything
    (OUT / ".nojekyll").write_text("", encoding="utf-8")
    print(f"built _site/index.html with {n_loc} locations / {n_appt} appointments")


if __name__ == "__main__":
    main()
