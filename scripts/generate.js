#!/usr/bin/env node
/**
 * generate.js
 *
 * Main static site generator. Reads host config + listing data,
 * renders Mustache templates, writes self-contained HTML to output/.
 *
 * Usage:
 *   node scripts/generate.js --slug <slug> [--refresh]
 *   node scripts/generate.js --test
 *
 * Output:
 *   output/h/<slug>/index.html
 *   output/h/<slug>/listing/<id>.html
 */

import * as fs   from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import Mustache from 'mustache';
import { fetchListing } from './fetch-listing.js';
import { buildNeighbourhoodFromListing } from './build-neighbourhood.js';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const ROOT        = path.join(__dirname, '..');
const HOSTS_DIR   = path.join(ROOT, 'data', 'hosts');
const TMPL_DIR    = path.join(ROOT, 'templates');
const STYLES_PATH = path.join(ROOT, 'styles', 'main.css');
const OUTPUT_DIR  = path.join(ROOT, 'output');

// ── Load templates + CSS once ───────────────────────────────────
const TEMPLATES = {
  homepage: fs.readFileSync(path.join(TMPL_DIR, 'homepage.html'),        'utf8'),
  detail:   fs.readFileSync(path.join(TMPL_DIR, 'listing-detail.html'),  'utf8'),
};
const CSS = fs.readFileSync(STYLES_PATH, 'utf8');

// ── Helpers ─────────────────────────────────────────────────────

function waUrl(number, message = '') {
  const num = String(number).replace(/\D/g, '');
  const full = num.startsWith('254') ? num : '254' + num.replace(/^0/, '');
  return `https://wa.me/${full}${message ? '?text=' + encodeURIComponent(message) : ''}`;
}

function shortDesc(text, len = 160) {
  if (!text) return '';
  const plain = text.replace(/<[^>]+>/g, '');
  return plain.length > len ? plain.slice(0, len).replace(/\s\S+$/, '') + '…' : plain;
}

function plural(n, unit) {
  return n === 1 ? '' : 's';
}

function heroHeadline(listing, brand) {
  const city = listing.location?.city || 'Nairobi';
  const type = listing.property_type?.toLowerCase() || 'apartment';
  if (listing.specs?.bedrooms >= 2) return `${listing.specs.bedrooms}-bedroom ${type}s in ${city}`;
  return `Modern city stays in the heart of ${city}`;
}

// ── Build homepage template data ────────────────────────────────

function buildHomepageData(host, listings, guide) {
  const primary = listings[0];
  const city    = primary?.location?.city || 'Nairobi';
  const nbhd    = primary?.location?.neighbourhood;

  const listingItems = listings.map(l => ({
    id:               l.listing_id,
    detail_path:      `listing/${l.listing_id}.html`,
    photo_url:        l.photos?.[0] || '',
    title:            l.title,
    city:             l.location?.city || city,
    description_short: shortDesc(l.description, 140),
    max_guests:       l.specs?.max_guests,
    bedrooms:         l.specs?.bedrooms,
    beds:             l.specs?.beds,
    bathrooms:        l.specs?.bathrooms,
    vetted:           host.vetted,
  }));

  // Merge amenities from all listings, deduplicate, limit to 12
  const allAmenities = [...new Set(listings.flatMap(l => l.amenities || []))].slice(0, 12);

  return {
    // Page meta
    brand:    host.brand,
    tagline:  host.tagline || `${host.brand} · Direct booking in ${city}.`,
    city,

    // Banner/nav
    vetted:        host.vetted,
    whatsapp_url:  waUrl(host.whatsapp_number),

    // Hero
    hero_photo:        primary?.photos?.[0] || '',
    hero_neighbourhood: nbhd,
    hero_headline:     heroHeadline(primary, host.brand),
    hero_subtext:      'Hotel-level comfort, booked directly.',

    // Listings
    listings: listingItems,

    // About
    about_text: primary?.description ? shortDesc(primary.description, 400) : `${host.brand} offers carefully selected apartments in ${city}. Book directly for the best rate and a smooth, secure stay.`,

    // Neighbourhood guide
    has_guide:    !!(guide?.places?.length),
    guide_area:   guide?.neighbourhood || guide?.city || city,
    guide_places: (guide?.places || []).slice(0, 5),

    // Amenities
    has_amenities: allAmenities.length > 0,
    amenities:     allAmenities,

    // Footer
    year: new Date().getFullYear().toString(),
  };
}

// ── Build listing detail template data ──────────────────────────

function buildDetailData(host, listing, guide) {
  const city = listing.location?.city || 'Nairobi';
  const photos = listing.photos || [];
  const waMsg = `Hi, I'd like to book ${listing.title}. Please let me know your direct rates and availability.`;

  return {
    // Page meta
    brand:                   host.brand,
    tagline:                 host.tagline,
    city,
    vetted:                  host.vetted,
    listing_id:              listing.listing_id,
    listing_title:           listing.title,
    listing_description:     listing.description || '',
    listing_description_short: shortDesc(listing.description, 160),
    listing_hero_photo:      photos[0] || '',
    source_url:              listing.source_url,

    // Nav
    whatsapp_booking_url: waUrl(host.whatsapp_number, waMsg),

    // Specs
    max_guests:        listing.specs?.max_guests,
    bedrooms:          listing.specs?.bedrooms,
    bedrooms_plural:   plural(listing.specs?.bedrooms, 'bedroom'),
    beds:              listing.specs?.beds,
    beds_plural:       plural(listing.specs?.beds, 'bed'),
    bathrooms:         listing.specs?.bathrooms,
    bathrooms_plural:  plural(listing.specs?.bathrooms, 'bath'),

    // Photos
    photo_1:         photos[0] || '',
    photo_2:         photos[1] || null,
    photo_3:         photos[2] || null,
    photo_4:         photos[3] || null,
    photo_5:         photos[4] || null,
    photo_all_url:   listing.source_url,
    photo_count:     photos.length,
    has_many_photos: photos.length > 5,

    // Host
    host_name:         listing.host?.name,
    host_is_superhost: listing.host?.is_superhost,
    host_avatar:       listing.host?.avatar_url,
    host_time_as_host: listing.host?.stats?.time_as_host,
    host_response_time: listing.host?.stats?.response_time,

    // Rating
    rating_value: listing.rating?.value ? Number(listing.rating.value).toFixed(1) : null,
    rating_count: listing.rating?.count,
    is_guest_fave: listing.rating?.is_guest_fave,

    // Reviews
    has_reviews: false,  // individual review text not in static scrape
    reviews:     [],

    // Amenities
    amenities: listing.amenities || [],

    // House rules
    has_rules:    !!(listing.house_rules?.length),
    house_rules:  listing.house_rules || [],
    checkin_time:  listing.checkin_time,
    checkout_time: listing.checkout_time,

    // Pricing
    direct_price: listing.pricing?.direct_nightly || null,
    mpesa_number: host.mpesa_number,

    // Guide
    has_guide:    !!(guide?.places?.length),
    guide_area:   guide?.neighbourhood || guide?.city || city,
    guide_places: (guide?.places || []).slice(0, 5),

    // Footer
    year: new Date().getFullYear().toString(),
  };
}

// ── Write helper ────────────────────────────────────────────────

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

// ── Main generator ──────────────────────────────────────────────

export async function generate(slug, options = {}) {
  const { refresh = false } = options;

  // 1. Load host config
  const hostPath = path.join(HOSTS_DIR, `${slug}.json`);
  if (!fs.existsSync(hostPath)) {
    throw new Error(`Host config not found: ${hostPath}\nCreate it at data/hosts/${slug}.json`);
  }
  const host = JSON.parse(fs.readFileSync(hostPath, 'utf8'));

  if (!host.listing_ids || host.listing_ids.length === 0) {
    console.warn(`[generate] No listing_ids in data/hosts/${slug}.json — nothing to generate.`);
    console.warn(`  Add Airbnb listing IDs to listing_ids[] and re-run.`);
    return null;
  }

  console.log(`\n[generate] ${host.brand} (${slug})`);
  console.log(`  listings: ${host.listing_ids.join(', ')}`);

  // 2. Load/fetch each listing
  const listings = [];
  for (const id of host.listing_ids) {
    console.log(`\n  [listing] ${id}`);
    const listing = await fetchListing(id, { save: true, refresh });
    listings.push(listing);
  }

  // 3. Load/generate neighbourhood guide from primary listing
  console.log('\n  [neighbourhood]');
  const guide = await buildNeighbourhoodFromListing(listings[0], { refresh }).catch(err => {
    console.warn(`  ⚠ neighbourhood guide failed: ${err.message}`);
    return null;
  });

  // 4. Render homepage
  const homepageData = buildHomepageData(host, listings, guide);
  homepageData.styles = CSS;
  const homepageHtml = Mustache.render(TEMPLATES.homepage, homepageData);
  const homepagePath = path.join(OUTPUT_DIR, 'h', slug, 'index.html');
  writeFile(homepagePath, homepageHtml);
  console.log(`\n  ✓ homepage  → ${homepagePath}`);

  // 5. Render each listing detail page
  for (const listing of listings) {
    const detailData = buildDetailData(host, listing, guide);
    detailData.styles = CSS;
    const detailHtml = Mustache.render(TEMPLATES.detail, detailData);
    const detailPath = path.join(OUTPUT_DIR, 'h', slug, 'listing', `${listing.listing_id}.html`);
    writeFile(detailPath, detailHtml);
    console.log(`  ✓ listing   → ${detailPath}`);
  }

  console.log(`\n  ✅ Done — ${listings.length + 1} page(s) written`);
  console.log(`  Open: file://${path.join(OUTPUT_DIR, 'h', slug, 'index.html')}\n`);

  return {
    slug,
    homepage:  homepagePath,
    listings:  listings.map(l => path.join(OUTPUT_DIR, 'h', slug, 'listing', `${l.listing_id}.html`)),
  };
}

// ── CLI ─────────────────────────────────────────────────────────

async function main() {
  const args    = process.argv.slice(2);
  const refresh = args.includes('--refresh');

  if (args.includes('--test')) {
    await generate('stays-by-jo', { refresh });
    return;
  }

  const slugIdx = args.indexOf('--slug');
  const slug    = slugIdx > -1 ? args[slugIdx + 1] : args.find(a => !a.startsWith('--'));

  if (!slug) {
    console.error('Usage: node scripts/generate.js --slug <slug> [--refresh]');
    console.error('       node scripts/generate.js --test');
    // List available hosts
    const hosts = fs.readdirSync(HOSTS_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json',''));
    if (hosts.length) console.error('\nAvailable hosts:', hosts.join(', '));
    process.exit(1);
  }

  try {
    await generate(slug, { refresh });
  } catch (err) {
    console.error(`\n❌ ${err.message}`);
    process.exit(1);
  }
}

// Only run CLI when invoked directly (not when imported)
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main();
}
