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

async function run(viewport, label, mobile) {
  const ctx = await browser.newContext({ viewport, ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(BASE, { waitUntil: "load" });
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
