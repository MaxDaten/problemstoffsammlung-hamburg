# Problemstoffsammlung Hamburg — Project Guide

Interactive OpenStreetMap view of Hamburg's **Mobile Problemstoffsammlung 2026**
(mobile hazardous-waste collection) schedule, parsed from a hard-to-read two-column PDF.

- `parse.py` — PDF → `schedule.json` (geometry-based parsing; needs `pdfplumber` via
  `nix-shell -p "python3.withPackages(ps: [ps.pdfplumber])" --run "python3 parse.py"`).
- `geocode.py` — geocodes addresses via OSM Nominatim (serial, 1 req/s, cached) → `data.json`.
- `index.html` — self-contained site (Leaflet + markercluster, data embedded inline). DE / EN /
  Deutsch Leichte Sprache; date-range filter; add-to-calendar (.ics). Single source of truth
  for data is `data.json`; `build.py` injects it into `index.html` for deploy.
- CI: `.github/workflows/deploy.yml` auto-deploys to GitHub Pages on push.
  Live: https://maxdaten.github.io/problemstoffsammlung-hamburg/

## Conventions

- **Atomic commits.** One logical change per commit; the site stays working/releasable at
  every commit. Don't bundle unrelated changes. Write a clear message describing the why.
- `main` is always releasable; a push triggers the Pages deploy, so only push when the change
  is verified and approved.

## Design Context

Design direction is maintained in `.impeccable.md` (full detail). Summary:

### Users
Hamburg residents of all ages answering "when/where can I drop off hazardous waste near me?"
— often on a phone, mixed tech-comfort, incl. older and non-native-German users (DE / EN /
Leichte Sprache). Unofficial visualization of the Stadtreinigung Hamburg schedule.

### Brand Personality
**Trustworthy & civic** — calm, clear, dependable; reads like a well-made public notice.
Three words: **dependable, plain-spoken, Hanseatic**. Authority through clarity, not decoration.

### Aesthetic Direction
**Technical, neutral** civic look (not editorial) — restrained, utilitarian, high craft.
- Type: a single **neutral sans, Public Sans** across the whole UI; hierarchy from weight +
  size, **no serif display** (Spectral was tried and removed). Tabular numerals for data.
- Dates: **compact green "status pills"** (kept from the previous version) — green chip
  `Di. 23.06.2026` + muted grey time; grey pill for past/done. Not oversized display type.
- Theme: **auto (follow system)** + manual toggle, with a genuine purpose-built dark variant.
- Color: Stadtreinigung **red (~#e2001a)** as a rare accent over tinted **OKLCH** neutrals
  (60-30-10); no pure #000/#fff; status never color-only.
- Layout: left-aligned, real spatial rhythm (4pt scale, `gap`-based). Map is the stage; the
  sidebar is a clean divider-separated list. No card-on-card, no uniform card grids.
- Anti-references: editorial serif display / oversized decorative dates, admin/dashboard
  templates, cyan-on-dark / purple-gradient "AI" look, glassmorphism, gradient text,
  colored left-border accent stripes.

### Accessibility
**WCAG 2.1 AA** (aligns with German BITV). Marker status (soon / later / done) by **shape/icon
+ color**, not red↔green alone. Full keyboard operability with visible focus. Respect
`prefers-reduced-motion` and `prefers-color-scheme`. Keep small data text legible.

### Design Principles
1. **Find-my-date first** — legibility and task speed beat any flourish.
2. **Technical clarity over flourish** — neutral sans, hierarchy from weight/size/space; no serif display or ornament.
3. **Civic palette, used with restraint** — red as a rare accent over tinted OKLCH neutrals.
4. **Two honest themes** — light + a purpose-built dark, derived from system preference.
5. **Accessible & multilingual by construction** — AA, keyboard-first, reduced-motion aware,
   coherent across DE / EN / Leichte Sprache (the latter favors spelled-out, simple presentation).

## Learnings & gotchas

Hard-won during development — read the relevant bullet before touching that area.

### Strict-mode eager-init ordering (this bit us 3×)
The app is one IIFE with `"use strict"`, and popups are built **eagerly** at init
(`m.bindPopup(buildPopup(l))` inside the `locations.forEach` marker loop). In strict mode a
`var`/block binding is `undefined`, and a block-level `function` is unavailable, **until
execution reaches its definition** — so anything `buildPopup`/`pinIcon` consume must be defined
*before* the marker loop. Symptoms were `esc`, the `fmtLongF/fmtShortF` Intl formatters, and
`CAL_ICON` each rendering as missing/`undefined`. **Rule:** helpers used during marker/popup
building (`esc`, formatters, `CAL_ICON`, glyph helpers) go ABOVE the marker loop, and call
`buildFormatters()` before it.

### PDF parsing (parse.py)
- Parse by **geometry**, never `pdftotext` (it interleaves the two columns). Split columns at
  x≈197, cluster words into rows by vertical **center** (~4.5px gap), pair each date with the
  nearest symbol glyph to its right (symbols sit ~0.6px above the date baseline).
- `ß` is lowercase to `str.isupper()` → district detection must allow it (GROß BORSTEL, EIßENDORF).
- Weekday abbrevs sometimes tokenize as `Mo` + a separate `.` → drop standalone `.` tokens.
- **Weekday is recomputed from the ISO date** — the PDF misprints some (e.g. Korachstr 04.12.
  printed "Mi." but is a Friday). Validate date+symbol, not the printed weekday.
- Page numbers sit in the bottom margin (top>555); unfiltered they become fake locations that
  steal the following appointments. The legend block also leaks (filter tokens with `=` /
  time-ranges). Pages 2 & 4 sometimes glue date+symbol into one token ("13.01.■,").
- Two appointments have a symbol that wraps to the next row and can't be matched geometrically
  → a tiny `OVERRIDES` table (Rahweg 30.10→▲, Brauhausstieg 11.11→★) that self-warns if a key
  stops matching (so a new PDF surfaces stale overrides).
- Extraction was validated against the PDF (13-entry diagnostic sample + Stüffelring anchor): correct.

### Geocoding (geocode.py)
- Nominatim is **1 req/s, serial only** — never parallelize across agents (ban risk). Cached in
  `geocode_cache.json`.
- Clean the query: take the segment before the first "/", drop `ggü./Nr./Marktfläche`, reduce
  house ranges to the first number, append `<district>, Hamburg, Deutschland`.
- 5 locations resolve only to street level (no OSM house number); coordinates are correct — don't chase.

### Leaflet specifics
- `setPopupContent()` does NOT refire `popupopen` → after `setLang()` rebuilds an open popup,
  re-wire its calendar buttons manually (`wireCalButtons`).
- `render()` rebuilds the cluster (`clearLayers`+`addLayers`) to keep filters in sync, which
  also **closes any open popup** (a language/filter change closes it — acceptable).
- Marker status = colour **+ glyph**: soon=check, later=**dot** (NOT a dash — dash-in-circle
  reads as a no-entry road sign), done=cross. Clusters coloured by aggregate (soon>later>done).

### Theme
- Resolved **before first paint** by a tiny inline `<head>` script (reads localStorage
  `hh-theme`, else `prefers-color-scheme`) setting `data-theme` — avoids FOUC. CSS keys off
  `:root[data-theme="dark"]`; "auto" follows the OS live via a `matchMedia` change listener.

### Verifying with cmux browser
- It caches aggressively — append `?v=N` to force a fresh load after edits, or DOM checks read stale.
- `eval` results must be `JSON.stringify`'d; popups exist only after flyTo+`zoomToShowLayer`
  settle (~1.8s) — `wait --selector ".p-appt.next"` before reading. A screenshot can catch a
  pre-animation/closed-popup frame; re-capture if a check disagrees.

### Process
- Automated review/UAT agents + functional smoke can MISS **visual** regressions — the
  `CAL_ICON`→"undefined" bug passed the UAT gate because the buttons still *worked*. Always
  screenshot a popup after touching popup code.
- "simplify" passes can introduce ordering bugs (hoisted `calIcon()` → late `var CAL_ICON`).
- Deploy: push to `main` → Actions runs `build.py` (injects `data.json`) → Pages. The
  "Node 20 deprecated" Actions warning is cosmetic.
