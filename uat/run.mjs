// Headless UAT for the Problemstoffsammlung map. Runs against a URL (built site
// pre-deploy, or the live URL post-deploy) at desktop (1280) and iPhone (393×852).
// Exits non-zero on any failed check. Usage: node uat/run.mjs [url]
import { chromium } from "playwright";

const BASE = process.argv[2] || process.env.UAT_URL || "http://localhost:8731/index.html";
const results = [];
let failed = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  results.push({ name, ok, detail });
  if (!ok) failed++;
}

const DESKTOP = { width: 1280, height: 900 };
const IPHONE = { width: 393, height: 852, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

const browser = await chromium.launch();

// Resource-load failures from external hosts (OSM tiles, unpkg CDN) surface as console
// errors in headless Chromium and are content-independent flakiness — not app bugs. We drop
// those while still catching app-level console.error (e.g. CAL_ICON="undefined") and any
// uncaught JS exception (pageerror — the strict-mode ordering bugs).
const NETWORK_NOISE = /Failed to load resource|net::ERR|ERR_|status of 4\d\d|status of 5\d\d|tile\.openstreetmap\.org|unpkg\.com/i;
// Identifying UA: polite to the OSM tile policy and avoids default-UA 403s in CI.
const UA = "ProblemstoffsammlungUAT/1.0 (+https://github.com/MaxDaten/problemstoffsammlung-hamburg)";

// Retry navigation: post-deploy the Pages edge may briefly 404/serve stale, and unpkg can be
// slow. domcontentloaded (not "load") avoids blocking on async OSM tiles.
async function gotoWithRetry(page, url) {
  let last;
  for (let i = 0; i < 3; i++) {
    try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }); return; }
    catch (e) { last = e; await page.waitForTimeout(2000); }
  }
  throw last;
}

async function run(viewport, label, mobile) {
  const ctx = await browser.newContext({
    viewport,
    acceptDownloads: true,
    userAgent: UA,
    ...(mobile ? { isMobile: true, hasTouch: true } : {}),
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error" && !NETWORK_NOISE.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));

  await gotoWithRetry(page, BASE);
  await page.waitForSelector(".loc-card", { timeout: 20000 });

  // --- core / data ---
  check(`${label}: 158 location cards`, (await page.locator(".loc-card").count()) === 158);
  check(`${label}: markers rendered`, (await page.locator(".leaflet-marker-icon").count()) > 0);
  check(`${label}: no horizontal overflow`,
    !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  check(`${label}: no "undefined" leaking in sidebar`,
    !(await page.evaluate(() => /\bundefined\b/.test(document.getElementById("loclist").textContent))));

  // --- header not exploded (the iPhone bug: 1-char-per-line title) ---
  const h1 = await page.locator("h1").boundingBox();
  check(`${label}: header title not exploded`, h1 && h1.height < 80, `h1 height=${h1 && Math.round(h1.height)}`);

  // On mobile the controls + list live in a collapsed bottom sheet — open it before
  // interacting, and verify the legend pill no longer overlaps the sheet controls.
  if (mobile) {
    await page.click("#sidebarToggle");
    await page.waitForTimeout(350);
    check(`${label}: bottom sheet opens`,
      await page.evaluate(() => document.body.classList.contains("sheet-open")));
    check(`${label}: legend pill hidden while sheet open (no overlap)`,
      !(await page.locator(".legend-toggle").isVisible()));
  }

  // --- search autocomplete ---
  await page.fill("#search", "eppen");
  await page.waitForTimeout(350);
  check(`${label}: autocomplete shows suggestions`,
    (await page.locator("#searchSuggest:not([hidden]) li").count()) > 0);
  await page.fill("#search", "");

  // Helpers for the filtering checks below.
  const countBold = async () =>
    parseInt(((await page.locator("#count b").first().textContent()) || "").trim(), 10);
  const cardCount = () => page.locator(".loc-card").count();
  // Wait until the count badge and the rendered card list agree (render() is debounced).
  const waitFiltered = async () =>
    page.waitForFunction(() => {
      const b = document.querySelector("#count b");
      if (!b) return false;
      const n = parseInt(b.textContent.trim(), 10);
      return n === document.querySelectorAll(".loc-card").length;
    }, null, { timeout: 5000 });

  // --- count badge correctness (unfiltered baseline) ---
  await waitFiltered();
  check(`${label}: count badge matches card count (unfiltered)`,
    (await countBold()) === (await cardCount()), `badge=${await countBold()} cards=${await cardCount()}`);

  // --- district select filter ---
  const distOpt = await page.evaluate(() => {
    const sel = document.getElementById("district");
    for (const o of sel.options) {
      const m = o.textContent.match(/\((\d+)\)\s*$/);
      if (o.value && m) return { value: o.value, count: parseInt(m[1], 10) };
    }
    return null;
  });
  check(`${label}: district option with count found`, distOpt && distOpt.count > 0,
    distOpt ? `${distOpt.value}=${distOpt.count}` : "none");
  if (distOpt) {
    await page.selectOption("#district", distOpt.value);
    await waitFiltered();
    const cc = await cardCount();
    check(`${label}: district filter card count == option count`, cc === distOpt.count,
      `cards=${cc} opt=${distOpt.count}`);
    check(`${label}: district filter count badge == option count`,
      (await countBold()) === distOpt.count, `badge=${await countBold()} opt=${distOpt.count}`);
    const allMatch = await page.evaluate((d) =>
      Array.from(document.querySelectorAll(".loc-card .lc-district"))
        .every((e) => e.textContent.trim() === d), distOpt.value);
    check(`${label}: all visible cards match selected district`, allMatch, distOpt.value);
    // reset district filter
    await page.selectOption("#district", "");
    await waitFiltered();
  }

  // --- count singular i18n: filter to exactly one result via a single-location district ---
  {
    const soloDistrict = await page.evaluate(() => {
      const sel = document.getElementById("district");
      for (const o of sel.options) {
        const m = o.textContent.match(/\((\d+)\)\s*$/);
        if (o.value && m && parseInt(m[1], 10) === 1) return o.value;
      }
      return null;
    });
    check(`${label}: single-location district exists`, !!soloDistrict, soloDistrict || "none");
    if (soloDistrict) {
      // Page default language follows navigator.language (Playwright => en) — pin DE so the
      // singular word is deterministic ("Standort", which must NOT match plural "Standorte").
      await page.selectOption("#langSel", "de");
      await page.selectOption("#district", soloDistrict);
      await page.waitForFunction(
        () => document.querySelectorAll(".loc-card").length === 1, null, { timeout: 5000 });
      await waitFiltered();
      const txt = ((await page.locator("#count").first().textContent()) || "").trim();
      check(`${label}: count uses singular word (DE)`, /\bStandort\b/.test(txt), `count="${txt}"`);
      await page.selectOption("#district", "");
      await waitFiltered();
    }
  }

  // --- date-range quick chips + clamp-to-max ---
  // TODAY on the page is local-midnight; mirror its ISO so we assert against the same value.
  const todayISO = await page.evaluate(() => {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    const p2 = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
  });
  const toMax = await page.evaluate(() => document.getElementById("toDate").max || "");
  await page.click('.chip[data-range="1w"]');
  await waitFiltered();
  const chip1w = await page.evaluate(() => ({
    pressed: document.querySelector('.chip[data-range="1w"]').getAttribute("aria-pressed"),
    from: document.getElementById("fromDate").value,
    to: document.getElementById("toDate").value,
  }));
  check(`${label}: 1w chip aria-pressed`, chip1w.pressed === "true", chip1w.pressed);
  check(`${label}: 1w chip sets fromDate = today`, chip1w.from === todayISO,
    `from=${chip1w.from} today=${todayISO}`);
  check(`${label}: 1w chip toDate not past data max`, !toMax || chip1w.to <= toMax,
    `to=${chip1w.to} max=${toMax}`);
  await page.click('.chip[data-range="1m"]');
  await waitFiltered();
  const to1m = await page.evaluate(() => document.getElementById("toDate").value);
  check(`${label}: 1m chip toDate clamped to data max`, !toMax || to1m <= toMax,
    `to=${to1m} max=${toMax}`);
  // back to "Alle" so the rest of the run sees the full dataset.
  await page.click('.chip[data-range="all"]');
  await waitFiltered();

  // --- i18n: three languages switch (langSel lives in the header) ---
  for (const [lng, expect] of [["de", "Zurücksetzen"], ["en", "Reset"], ["de-ls", "Neu anfangen"]]) {
    await page.selectOption("#langSel", lng);
    const r = ((await page.locator("#reset").textContent()) || "").trim();
    check(`${label}: language ${lng}`, r === expect, `reset="${r}"`);
  }
  await page.selectOption("#langSel", "de");

  // --- theme toggle cycles (header, always visible) ---
  const before = await page.evaluate(() => document.getElementById("themeToggle").dataset.mode);
  await page.click("#themeToggle");
  const after = await page.evaluate(() => document.getElementById("themeToggle").dataset.mode);
  check(`${label}: theme toggle cycles`, before !== after, `${before}→${after}`);

  // --- popup last: it flies the map and (on mobile) closes the sheet ---
  if (mobile && !(await page.evaluate(() => document.body.classList.contains("sheet-open")))) {
    await page.click("#sidebarToggle"); await page.waitForTimeout(300);
  }
  await page.locator(".loc-card").first().click();
  await page.waitForSelector(".p-appt.next", { timeout: 10000 });
  check(`${label}: popup calendar icon present`, (await page.locator(".cal-one svg").count()) > 0);
  check(`${label}: no "undefined" in popup`,
    !(await page.evaluate(() => /undefined/.test((document.querySelector(".leaflet-popup-content") || {}).innerHTML || ""))));
  const nextDate = ((await page.locator(".p-appt.next .p-date").first().textContent()) || "").trim();
  check(`${label}: next date readable (full, not "…")`, /\d{4}/.test(nextDate) && !/…|\.\.\.$/.test(nextDate), `"${nextDate}"`);

  // --- add-to-calendar produces a valid .ics (catches CAL_ICON="undefined"-class + folding/TZ bugs) ---
  {
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 10000 }),
      page.locator(".p-appt.next .cal-one").first().click(),
    ]);
    const stream = await download.createReadStream();
    let ics = "";
    for await (const chunk of stream) ics += chunk.toString("utf8");
    const checks = [
      ["VCALENDAR header", /^BEGIN:VCALENDAR\r\n/.test(ics)],
      ["VCALENDAR footer", /END:VCALENDAR\s*$/.test(ics)],
      ["VTIMEZONE present", /BEGIN:VTIMEZONE\r\n/.test(ics) && /END:VTIMEZONE\r\n/.test(ics)],
      ["TZID Europe/Berlin", /TZID:Europe\/Berlin\r\n/.test(ics)],
      ["UID @problemstoffsammlung-hamburg", /^UID:.+@problemstoffsammlung-hamburg\r?$/m.test(ics)],
      ["DTSTART;TZID line", /^DTSTART;TZID=Europe\/Berlin:\d{8}T\d{6}\r?$/m.test(ics)],
      ["SUMMARY non-empty", /^SUMMARY:.*\S/m.test(ics)],
      ["no 'undefined'", !/undefined/.test(ics)],
    ];
    for (const [n, ok] of checks) check(`${label}: ics ${n}`, ok, ok ? "" : ics.slice(0, 200));
  }

  check(`${label}: no console errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}

try {
  await run(DESKTOP, "desktop-1280", false);
  await run(IPHONE, "iphone-393", true);
} finally {
  await browser.close();
}

for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  (" + r.detail + ")" : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
