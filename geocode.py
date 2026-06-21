#!/usr/bin/env python3
"""Geocode each collection location to lat/lon via OSM Nominatim.

- Cleans the sheet's address quirks (ggü., Marktfläche, intersections) into a
  geocodable query.
- Respects Nominatim policy: <=1 req/s, identifying User-Agent, on-disk cache.
- Falls back to street-only, then to a hand-mapped district centroid, so every
  location ends up with coordinates (flagged by precision).
"""
import json
import re
import sys
import time
import urllib.parse
import urllib.request

UA = "hh-problemstoffsammlung-map/1.0 (https://github.com/; maxdaten@gmail.com)"
CACHE_FILE = "geocode_cache.json"
NOISE = [
    "Marktfläche", "Markt fläche", "Depotcontainer", "HVV-Haltestelle",
    "S-Bahn", "U-Bahn", "Sportplatz", "Bürgerhaus", "Baumarkt", "EKZ",
    "Einrichtungshaus", "Freibad", "Apostelkirche", "bei der Kirche",
    "Regattastrecke", "Haus", "Ecke",
]


def title_district(d):
    return " ".join(w.capitalize() for w in d.split())


def build_query(name):
    """Reduce a sheet location name to a street(+number) query string."""
    q = name
    # 'gegenüber' / 'ggü. Nr. 24' -> keep the number, drop the marker words
    q = re.sub(r"ggü\.?\s*(Nr\.?)?\s*", "", q)
    q = re.sub(r"\bNr\.?\s*", "", q)
    # intersections / landmark after a slash -> keep the first segment
    q = q.split("/")[0]
    for noise in NOISE:
        q = q.replace(noise, "")
    # collapse house-number ranges "156–158" / "127 b–e" -> first number
    q = re.sub(r"(\d+)\s*[a-z]?\s*[–-]\s*[a-z0-9]+", r"\1", q)
    q = re.sub(r"\s+", " ", q).strip(" ,.-–")
    return q


def nominatim(query):
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
        {"q": query, "format": "json", "limit": 1, "countrycodes": "de"})
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)
    if data:
        return float(data[0]["lat"]), float(data[0]["lon"]), data[0]["display_name"]
    return None


def main():
    sched = json.load(open("schedule.json"))
    try:
        cache = json.load(open(CACHE_FILE))
    except FileNotFoundError:
        cache = {}

    def lookup(query):
        if query in cache:
            return cache[query]
        try:
            res = nominatim(query)
        except Exception as e:  # network/HTTP -> record miss, keep going
            print(f"  ! error {query!r}: {e}", file=sys.stderr)
            res = None
        cache[query] = res
        json.dump(cache, open(CACHE_FILE, "w"), ensure_ascii=False, indent=1)
        time.sleep(1.1)  # politeness
        return res

    ok = miss = 0
    for loc in sched["locations"]:
        district = title_district(loc["district"])
        street = build_query(loc["name"])
        queries = [
            f"{street}, {district}, Hamburg, Deutschland",
            f"{street}, Hamburg, Deutschland",
            f"{district}, Hamburg, Deutschland",  # district centroid fallback
        ]
        result, used, precise = None, None, "exact"
        for idx, q in enumerate(queries):
            result = lookup(q)
            if result:
                used = q
                precise = "exact" if idx == 0 else (
                    "street" if idx == 1 else "district")
                break
        if result:
            loc["lat"], loc["lon"] = result[0], result[1]
            loc["geo_precision"] = precise
            loc["geo_query"] = used
            ok += 1
            tag = "" if precise == "exact" else f" [{precise}]"
            print(f"  ok  {loc['name']} -> {result[0]:.4f},{result[1]:.4f}{tag}",
                  file=sys.stderr)
        else:
            loc["lat"] = loc["lon"] = None
            loc["geo_precision"] = "failed"
            miss += 1
            print(f"  MISS {loc['name']} ({street})", file=sys.stderr)

    json.dump(sched, open("data.json", "w"), ensure_ascii=False, indent=2)
    print(f"\ngeocoded ok={ok} miss={miss} "
          f"(non-exact below)", file=sys.stderr)
    for loc in sched["locations"]:
        if loc.get("geo_precision") not in ("exact", None):
            print(f"  - [{loc['geo_precision']}] {loc['district']} / "
                  f"{loc['name']}", file=sys.stderr)


if __name__ == "__main__":
    main()
