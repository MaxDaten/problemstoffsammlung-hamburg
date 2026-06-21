#!/usr/bin/env python3
"""Parse the Hamburg Problemstoffsammlung 2026 PDF into structured JSON.

Strategy: work at the word level using geometry, not reconstructed line text.
Two columns split by x; rows clustered by vertical center; within a row sorted
left-to-right. Then walk the token stream by type (district / address / date /
symbol) to assemble locations and their appointments.
"""
import datetime
import json
import re
import sys

import pdfplumber

YEAR = 2026
# Mo.=0 .. So.=6, matching datetime.date.weekday(). The source PDF occasionally
# misprints a weekday (e.g. Korachstr. 04.12.2026 is labelled "Mi." but is a
# Friday); we recompute it from the ISO date so the displayed weekday is correct.
WEEKDAY_ABBR = ["Mo.", "Di.", "Mi.", "Do.", "Fr.", "Sa.", "So."]
SYMBOLS = {
    "■": "09:00–10:30",
    "✚": "11:00–12:30",
    "●": "12:00–13:30",
    "▲": "13:30–15:00",
    "★": "14:30–16:00",
    "◆": "16:30–18:00",
}
SLOT_START = {  # for sorting / "next collection" logic
    "09:00–10:30": "09:00",
    "11:00–12:30": "11:00",
    "12:00–13:30": "12:00",
    "13:30–15:00": "13:30",
    "14:30–16:00": "14:30",
    "16:30–18:00": "16:30",
}
SYM_CHARS = set(SYMBOLS)
WEEKDAYS = {"Mo.", "Di.", "Mi.", "Do.", "Fr.", "Sa.", "So.",
            "Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"}
DATE_RE = re.compile(r"^(\d{2})\.(\d{2})\.?$")
GLUED_RE = re.compile(r"^(\d{2}\.\d{2}\.?)([■✚●▲★◆])(,?)$")  # date stuck to symbol
LEGEND_RE = re.compile(r"=|\d{1,2}[.:]\d\d\s*[–-]")  # legend time-range / "= 9.00"
COL_X = 197


def cluster_rows(words, gap=4.5):
    """Group words into rows by vertical center; new row when gap exceeds threshold."""
    ws = sorted(words, key=lambda w: (w["top"] + w["bottom"]) / 2)
    rows, cur, last = [], [], None
    for w in ws:
        c = (w["top"] + w["bottom"]) / 2
        if last is None or c - last <= gap:
            cur.append(w)
        else:
            rows.append(cur)
            cur = [w]
        last = c
    if cur:
        rows.append(cur)
    # order words within each row left-to-right
    for r in rows:
        r.sort(key=lambda w: w["x0"])
    return rows


def center(w):
    return (w["top"] + w["bottom"]) / 2


def match_symbol(datew, syms):
    """Find the symbol word belonging to a date: same row, just to its right."""
    best, bestdx = None, 1e9
    cy = center(datew)
    for s in syms:
        if s.get("_used"):
            continue
        if abs(center(s) - cy) > 5:
            continue
        dx = s["x0"] - datew["x1"]
        if -3 <= dx < 22 and dx < bestdx:
            best, bestdx = s, dx
    if best is not None:
        best["_used"] = True
    return best


def tokenize(pdf_path):
    """Return ordered list of (kind, text, word) tokens in reading order.

    Symbols are matched to dates geometrically (nearest glyph to the right on the
    same row), which survives row-clustering imperfections. Each emitted "date"
    token carries its resolved slot in word["_slot"].
    """
    pdf = pdfplumber.open(pdf_path)
    tokens = []
    for page in pdf.pages:
        ws = page.extract_words(use_text_flow=False, keep_blank_chars=False)
        # gather standalone symbol glyphs for geometric matching
        syms = [w for w in ws if w["text"].rstrip(",") in SYM_CHARS]
        for s in syms:
            s["_sym"] = s["text"].rstrip(",")
        for colmin, colmax in ((0, COL_X), (COL_X, 10_000)):
            col = [w for w in ws if colmin <= w["x0"] < colmax]
            for row in cluster_rows(col):
                for w in row:
                    t = w["text"]
                    if LEGEND_RE.search(t):           # legend time-ranges -> drop
                        continue
                    if t.isdigit() and w["top"] > 555:  # page number in margin
                        continue
                    if t == ".":                      # orphaned weekday period
                        continue
                    if t.rstrip(",") in SYM_CHARS:     # handled via geometry
                        continue
                    # a wrapped trailing symbol can glue to the next word
                    # ("▲Wagrierweg"); strip it — its date is slot-matched elsewhere.
                    if t and t[0] in SYM_CHARS:
                        t = t[1:]
                    # date glued to its symbol, e.g. "13.01.■," -> emit date+slot
                    m = GLUED_RE.match(t)
                    if m:
                        dw = dict(w)
                        dw["_slot"] = SYMBOLS.get(m.group(2))
                        tokens.append(("date", m.group(1).rstrip("."), dw))
                        continue
                    if t in WEEKDAYS:
                        tokens.append(("wday", t, w))
                    elif DATE_RE.match(t.rstrip(",")):
                        s = match_symbol(w, syms)
                        dw = dict(w)
                        dw["_slot"] = SYMBOLS.get(s["_sym"]) if s else None
                        tokens.append(("date", t.rstrip(","), dw))
                    else:
                        tokens.append(("text", t, w))
    return tokens


def is_district(text):
    """District headers are all-uppercase, no digits, no trailing colon."""
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return False
    if any(ch.isdigit() for ch in text):
        return False
    if text.endswith(":"):
        return False
    # 'ß' has no uppercase form in str.isupper() but appears in caps headers
    # (GROß BORSTEL, EIßENDORF), so accept it as uppercase.
    return all(c.isupper() or c == "ß" for c in letters) and len(text) >= 3


# Header/legend noise to ignore.
NOISE = {"TERMINE", "FÜR", "DIE", "STADTTEILE", "ABHOLZEITEN", "Uhr"}


def parse(pdf_path):
    tokens = tokenize(pdf_path)
    districts = []  # list of {name, locations:[{name, appts:[{date,slot,weekday}]}]}
    cur_district = None
    cur_location = None
    name_buf = []          # accumulating address fragments
    pending_wday = None

    def flush_name():
        nonlocal cur_location, name_buf
        if name_buf:
            name = " ".join(name_buf).strip()
            name = re.sub(r"\s+", " ", name)
            name = re.sub(r"-\s+", "-", name)  # rejoin line-break hyphenation
            name = name.rstrip(":").strip()
            if name and cur_district is not None:
                cur_location = {"name": name, "appts": []}
                cur_district["locations"].append(cur_location)
            name_buf = []

    i = 0
    n = len(tokens)
    while i < n:
        kind, text, w = tokens[i]

        # skip legend region: top of page 0 has the symbol legend (sym followed by '=')
        if kind == "sym":
            # could be legend ("■ = 9.00..."): peek next token
            nxt = tokens[i + 1][1] if i + 1 < n else ""
            if nxt.startswith("="):
                i += 1
                continue

        if kind == "text" and (text in NOISE or text.rstrip(",") in NOISE):
            i += 1
            continue
        # skip section markers like "A-E", "F-...", legend math tokens
        if kind == "text" and re.match(r"^[A-ZÄÖÜ]\s*[-–]\s*[A-ZÄÖÜ]$", text):
            i += 1
            continue

        if kind == "text" and is_district(text):
            # a district header may be multiple uppercase tokens on same logical name
            flush_name()
            parts = [text]
            j = i + 1
            while j < n and tokens[j][0] == "text" and is_district(tokens[j][1]):
                parts.append(tokens[j][1])
                j += 1
            cur_district = {"name": " ".join(parts), "locations": []}
            districts.append(cur_district)
            cur_location = None
            i = j
            continue

        if kind == "wday":
            pending_wday = text.rstrip(".") + "."
            # a weekday token closes any pending address name
            flush_name()
            i += 1
            continue

        if kind == "date":
            flush_name()
            dd, mm = DATE_RE.match(text).groups()
            iso = f"{YEAR}-{mm}-{dd}"
            slot = w.get("_slot")
            # Recompute the weekday from the calendar date rather than trusting
            # the PDF's printed abbreviation (which contains at least one typo).
            weekday = WEEKDAY_ABBR[datetime.date(YEAR, int(mm), int(dd)).weekday()]
            appt = {"date": iso, "day": f"{dd}.{mm}.", "weekday": weekday,
                    "slot": slot}
            if cur_location is not None:
                cur_location["appts"].append(appt)
            pending_wday = None
            i += 1
            continue

        if kind == "sym":
            # stray symbol (legend already handled) — skip
            i += 1
            continue

        # plain text -> part of an address name
        name_buf.append(text)
        i += 1

    flush_name()
    return districts


# Two appointments whose trailing time-symbol wraps onto an adjacent row, making
# them geometrically ambiguous. Values taken from the authoritative pdftotext
# -layout rendering. Keyed by (location-name substring, day). If a key ever stops
# matching, a warning prints so the table can be re-derived for a new PDF.
OVERRIDES = {
    ("Rahweg 62", "30.10."): "13:30–15:00",   # ▲
    ("Brauhausstieg", "11.11."): "14:30–16:00",  # ★
}


def apply_overrides(locations):
    for (frag, day), slot in OVERRIDES.items():
        hit = False
        for loc in locations:
            if frag in loc["name"]:
                for a in loc["appts"]:
                    if a["day"] == day and not a["slot"]:
                        a["slot"] = slot
                        hit = True
        if not hit:
            print(f"WARNING: override ({frag!r}, {day!r}) matched nothing — "
                  f"PDF may have changed", file=sys.stderr)


def main():
    districts = parse("schedule.pdf")
    # drop empty districts (header noise that slipped through)
    districts = [d for d in districts if d["locations"]]
    locations = []
    for d in districts:
        for loc in d["locations"]:
            loc["district"] = d["name"]
            locations.append(loc)
    apply_overrides(locations)
    nappt = sum(len(l["appts"]) for l in locations)
    noslot = sum(1 for l in locations for a in l["appts"] if not a["slot"])
    print(f"districts={len(districts)} locations={len(locations)} "
          f"appointments={nappt} missing_slot={noslot}", file=sys.stderr)
    json.dump({"year": YEAR, "symbols": SYMBOLS, "locations": locations},
              open("schedule.json", "w"), ensure_ascii=False, indent=2)
    # also print district + location summary for QA
    for d in districts:
        print(f"\n### {d['name']}", file=sys.stderr)
        for loc in d["locations"]:
            days = ", ".join(f"{a['day']}{'?' if not a['slot'] else ''}"
                             for a in loc["appts"])
            print(f"  - {loc['name']}: {days}", file=sys.stderr)


if __name__ == "__main__":
    main()
