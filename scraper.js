const { chromium } = require('playwright');
const { program } = require('commander');
const Cell = require('./Cell');
const { inverseSpan } = require('./Cell');
const fs = require('fs');

program
  .requiredOption('-q, --query <query>', 'Search query (e.g. "dentist")')
  .option('-o, --output <file>', 'Output file basename (extension stripped — writes BOTH .json and .csv)', 'leads')
  .option('-m, --max <number>', 'Max results to scrape', '20')
  .option('-r, --reagion <location>', 'Reagion to scrape', 'İstanbul')
  .parse();

const opts = program.opts();

const CAP = 120;      // Google's post-scroll result ceiling — VERIFY from your logs
const SAFETY = 0.9;   // AMR λ: treat "near the ceiling" as truncated, not complete
const MAX_ZOOM = 21;  // ~95m / one city block — depth guard, kills office-tower recursion

// accumulator: dedup leads across overlapping cells by name|address
const allLeads = new Map();
let rawCount = 0; // total rows scraped across all cells, before dedup — for visibility
const leadKey = (lead) => `${lead.Title}|${lead.Address}`;


async function safeAttr(locator, attr) { // getAtribut() in a safe environment
  try { return (await locator.count()) ? await locator.first().getAttribute(attr, { timeout: 3000 }) : null; }
  catch { return null; }
}
async function firstText(locator) { // first().textContent() in a safe environment
  try { return (await locator.count()) ? (await locator.first().textContent({ timeout: 3000 }))?.trim() ?? null : null; }
  catch { return null; }
}
async function safeTexts(locator) { // allTextContents() in a safe environment
  try { return await locator.allTextContents(); } catch { return []; }
}

async function scrape(cell) {
  if (Array.isArray(cell)) {
    for (const child of cell) await scrape(child);
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const searched = opts.query.replaceAll(' ', '+');
  await page.goto(toUrl(cell, searched), { waitUntil: 'domcontentloaded' });

  await page.waitForSelector('.Nv2PK'); // DON'T REMOVE
  const stableCount = await scrollToEnd(page);
  console.log(`[scrape] zoom=${cell.zoom} stable card count=${stableCount}`);

  const cards = await page.locator('.Nv2PK').all();
  const res = [];
  for (const card of cards) {
    const title = await safeAttr(card.locator('.hfpxzc'), 'aria-label');
    const ratingLabel = await safeAttr(card.locator('.ZkP5Je'), 'aria-label'); // "4,9 yıldızlı"
    const rating = ratingLabel ? parseFloat(ratingLabel.replace(',', '.')) : null;
    const phone = await firstText(card.locator('.UsdlK'));

    const lines = await safeTexts(card.locator('.W4Efsd'));
    // The clean "category · address" line is the SHORTEST line that has a middot
    // and is NOT the phone-bearing parent. Keying off the phone (not the dot type)
    // is robust: some cards put hours behind a middot too, and others have no hours.
    const catAddr = lines
      .filter(t => t.includes('.') && (!phone || !t.includes(phone)))
      .sort((a, b) => a.length - b.length)[0] ?? '';
    const parts = catAddr.split('.').map(s => s.trim()).filter(Boolean);
    const category = parts[0] ?? null;
    const address = parts.length > 1 ? parts[parts.length - 1] : null;

    res.push({ Title: title, Rating: rating, Category: category, Address: address, Phone: phone });
  }
  await browser.close();

  for (const lead of res) allLeads.set(leadKey(lead), lead); // title|address:res[i]
  rawCount += res.length; // I am glad that your parents did it raw twin

  if (!isEnough(stableCount, cell.zoom)) {
    await scrape(cell.subdivide());
  }
  return res;
}

async function scrollToEnd(page) {
  const feed = page.locator('div[role="feed"]');
  let prev = 0;
  let stagnant = 0;
  while (stagnant < 3) {
    const count = await page.locator('.Nv2PK').count();
    if (count > prev) {
      prev = count;
      stagnant = 0;
    } else {
      stagnant++;
    }
    // scroll the panel (not the window) to its bottom to lazy-load the next batch
    await feed.evaluate(el => el.scrollTo(0, el.scrollHeight)).catch(() => {});
    await page.waitForTimeout(1200);
  }
  return prev;
}

function toUrl(cell, query) {
  return `https://www.google.com/maps/search/${query}/@${cell.lat},${cell.lng},${cell.zoom}z`;
}

// Dude this is equated so badly, it has no guardrails this concept should further be researched
// Zoom guardrail can stay
function isEnough(count, zoom) {
  if (count < CAP * SAFETY) return true; // list ended naturally -> got them all
  if (zoom >= MAX_ZOOM)     return true; // depth guard -> don't recurse into a single point
  return false;                          // hit the ceiling -> subdivide into 4
}

async function reagionToBox(place) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(place)}&format=json&limit=1`;
  try {
    const responce = await fetch(url, {
      headers: { 'User-Agent': 'leadgen-scraper/0.1 (PXprox@hotmail.com)' },
    });
    if (!responce.ok) {
      throw new Error('Responce status: ' + responce.status);
    }
    return await responce.json();
  } catch (err) {
    console.log(err.message);
  }
}

function toCsv(rows, headers = ['Title', 'Rating', 'Category', 'Address', 'Phone']) {
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map(h => escape(row[h])).join(','));
  return lines.join('\n');
}

reagionToBox(opts.reagion).then(async (result) => {
  const boundingbox = result[0].boundingbox;
  const zoom = inverseSpan(boundingbox[0], boundingbox[1], boundingbox[2], boundingbox[3]);
  await scrape(new Cell({ lat: parseFloat(result[0].lat), lng: parseFloat(result[0].lon), zoom }));
  const leads = [...allLeads.values()];

  // Strip any extension the user passed so `-o leads.json` and `-o leads.csv` both work.
  // Always write BOTH formats — customer picks what they want, you only run the scrape once.
  const base = opts.output.replace(/\.(json|csv)$/i, '');
  fs.writeFileSync(`${base}.json`, JSON.stringify(leads, null, 2));
  fs.writeFileSync(`${base}.csv`, toCsv(leads));
  console.log(`[done] ${leads.length} unique leads (${rawCount} scraped, ${rawCount - leads.length} duplicates removed) -> ${base}.{json,csv}`);
});