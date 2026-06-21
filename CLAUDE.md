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
**Editorial** evolution of the Stadtreinigung-red civic look.
- Type (replaces the system font): **Spectral** (editorial serif) for masthead/headings/large
  dates; **Public Sans** (government-grade sans) for UI/body/data. Strong scale contrast.
- Theme: **auto (follow system)** with a genuine, purpose-built dark variant.
- Color: Stadtreinigung **red (~#e2001a)** as a rare accent over tinted **OKLCH** neutrals
  (60-30-10); no pure #000/#fff; status never color-only.
- Layout: left-aligned, asymmetric, real spatial rhythm (4pt scale, `gap`-based). Map is the
  stage, the list is the editorial column. No card-on-card, no uniform card grids.
- Anti-references: admin/dashboard templates, cyan-on-dark / purple-gradient "AI" look,
  glassmorphism, gradient text, colored left-border accent stripes, system-font blandness.

### Accessibility
**WCAG 2.1 AA** (aligns with German BITV). Marker status (soon / later / done) by **shape/icon
+ color**, not red↔green alone. Full keyboard operability with visible focus. Respect
`prefers-reduced-motion` and `prefers-color-scheme`. Keep small data text legible.

### Design Principles
1. **Find-my-date first** — legibility and task speed beat any flourish.
2. **Editorial, not decorative** — character from type, hierarchy, and rhythm; never ornament.
3. **Civic palette, used with restraint** — red as a rare accent over tinted OKLCH neutrals.
4. **Two honest themes** — light + a purpose-built dark, derived from system preference.
5. **Accessible & multilingual by construction** — AA, keyboard-first, reduced-motion aware,
   coherent across DE / EN / Leichte Sprache (the latter favors spelled-out, simple presentation).
