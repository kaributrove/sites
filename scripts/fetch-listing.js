#!/usr/bin/env node
/**
 * fetch-listing.js
 *
 * Fetches a single Airbnb listing page, extracts all data sources,
 * normalizes to our schema, and writes data/listings/[id].json.
 *
 * Data sources used (in priority):
 *   1. <script id="data-deferred-state-0">  → pdpPresentation (primary)
 *   2. <script type="application/ld+json">  → VacationRental schema (fallback)
 *   3. <meta property="og:title">           → spec parsing fallback
 *
 * Usage:
 *   node scripts/fetch-listing.js <airbnb-url-or-id> [--refresh] [--verbose]
 *   node scripts/fetch-listing.js --test
 *
 * From other scripts:
 *   import { fetchListing } from './fetch-listing.js';
 */

import * as fs   from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { load as cheerioLoad } from 'cheerio';
import { normalizeListing } from './normalize-listing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.join(__dirname, '..', 'data', 'listings');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AIRBNB_BASE = 'https://www.airbnb.com/rooms/';

const TEST_IDS = [
  '1618073186043694871',  // Stays by Jo — 2BR Nairobi (Westlands, known good)
];

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0.0.0 Safari/537.36',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language':    'en-US,en;q=0.9',
  'Accept-Encoding':    'gzip, deflate, br',
  'Cache-Control':      'no-cache',
  'Sec-Fetch-Dest':     'document',
  'Sec-Fetch-Mode':     'navigate',
  'Sec-Fetch-Site':     'none',
  'Upgrade-Insecure-Requests': '1',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractListingId(input) {
  const match = String(input).match(/\/rooms\/(\d+)|^(\d+)$/);
  if (!match) throw new Error(`Cannot extract listing ID from: "${input}"`);
  return match[1] || match[2];
}

function buildUrl(id) {
  // currency=KES → prices in KSH where available; locale=en → consistent field names
  return `${AIRBNB_BASE}${id}?currency=KES&locale=en`;
}

// ---------------------------------------------------------------------------
// Fetch with retry
// ---------------------------------------------------------------------------

async function fetchHtml(url, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const delay = attempt * 2000;
      console.log(`  ↳ retry ${attempt}/${retries} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After');
        throw new Error(`Rate limited (429). Retry-After: ${retryAfter || 'unknown'}s`);
      }
      if (res.status === 404) throw new Error(`Listing not found (404): ${url}`);
      if (!res.ok)            throw new Error(`HTTP ${res.status}: ${url}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) console.warn(`  [fetch] attempt ${attempt + 1} failed: ${err.message}`);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Data extraction
// ---------------------------------------------------------------------------

function extractDeferredState($) {
  // Primary data source: data-deferred-state-0
  const raw = $('#data-deferred-state-0').html();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.niobeClientData?.[0]?.[1]?.data?.node?.pdpPresentation ?? null;
  } catch (err) {
    console.warn(`  [parse] data-deferred-state-0 parse failed: ${err.message}`);
    return null;
  }
}

function extractJsonLd($) {
  // Fallback: JSON-LD VacationRental schema
  let result = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).html() || '');
      if (parsed?.['@type'] === 'VacationRental') result = parsed;
    } catch {}
  });
  return result;
}

function extractOgTitle($) {
  return $('meta[property="og:title"]').attr('content') || $('title').text() || null;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function fetchListing(input, options = {}) {
  const { save = true, refresh = false, verbose = false } = options;

  const listingId = extractListingId(input);
  const url       = buildUrl(listingId);
  const outPath   = path.join(DATA_DIR, `${listingId}.json`);

  // Return cached version unless refresh is requested
  if (!refresh && fs.existsSync(outPath)) {
    console.log(`[fetch] Cache hit: ${outPath}`);
    return JSON.parse(fs.readFileSync(outPath, 'utf8'));
  }

  console.log(`[fetch] listing ${listingId}`);
  console.log(`  → ${url}`);

  const html = await fetchHtml(url);
  console.log(`  HTML: ${(html.length / 1024).toFixed(0)}KB`);

  const $ = cheerioLoad(html);

  const pdp     = extractDeferredState($);
  const jsonLd  = extractJsonLd($);
  const ogTitle = extractOgTitle($);

  if (!pdp) {
    console.warn('  ⚠ data-deferred-state-0 not found — falling back to JSON-LD only');
  }
  if (!jsonLd) {
    console.warn('  ⚠ JSON-LD VacationRental not found');
  }

  if (verbose && pdp) {
    console.log('\n[debug] pdpPresentation keys:', Object.keys(pdp).join(', '));
  }

  const listing = normalizeListing({ pdp, jsonLd, ogTitle, listingId, sourceUrl: url });

  // Report
  const l = listing;
  console.log(`  title:       ${l.title}`);
  console.log(`  location:    ${l.location.neighbourhood || '—'} · ${l.location.city}`);
  console.log(`  specs:       ${l.specs.max_guests}G · ${l.specs.bedrooms}BR · ${l.specs.beds}B · ${l.specs.bathrooms}ba`);
  console.log(`  host:        ${l.host.name}${l.host.is_superhost ? ' ★ Superhost' : ''}`);
  console.log(`  rating:      ${l.rating.value} (${l.rating.count} reviews)${l.rating.is_guest_fave ? ' · Guest Fave' : ''}`);
  console.log(`  photos:      ${l._meta.photo_count}`);
  console.log(`  amenities:   ${l._meta.amenity_count}`);
  console.log(`  nbhd slug:   ${l.location.neighbourhood_slug}`);

  if (save) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(listing, null, 2));
    console.log(`  ✓ saved → ${outPath}`);
  }

  return listing;
}

