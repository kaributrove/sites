#!/usr/bin/env node
/**
 * build-neighbourhood.js
 *
 * Generates a neighbourhood guide for a given city + area using Claude.
 * Result is cached to data/neighbourhoods/[slug].json — API is called
 * once per neighbourhood, then every future site in that area reuses it.
 *
 * Cache schema (same shape for AI-generated and future curated content):
 * {
 *   neighbourhood: string,
 *   city:          string,
 *   country:       string,
 *   slug:          string,
 *   generated_by:  string,       // model ID or "curated"
 *   generated_at:  string,       // ISO date
 *   curated:       boolean,      // true = hand-verified, shows "Local pick" badge
 *   places: [{
 *     name:             string,
 *     category:         string,  // Food | Nature | Culture | Shopping | Nightlife | Wellness | Practical
 *     description:      string,  // 2 sentences, specific
 *     walking_distance: string,  // "8 min walk" | "5 min drive"
 *   }]
 * }
 *
 * Usage:
 *   node scripts/build-neighbourhood.js <slug>
 *   node scripts/build-neighbourhood.js --listing <listing-json-path>
 *   node scripts/build-neighbourhood.js --test
 *
 * From generate.js:
 *   import { buildNeighbourhood } from './build-neighbourhood.js';
 *   const guide = await buildNeighbourhood('westlands-nairobi');
 */

import * as fs   from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';

// Load .env from project root if present (Node 20+ built-in dotenv via --env-file,
// but we also support a manual load here so the script works without the flag)
const __envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (fs.existsSync(__envPath)) {
  const lines = fs.readFileSync(__envPath, 'utf8').split('\n');
  for (const line of lines) {
    const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)$/);
    if (match) process.env[match[1]] ??= match[2].replace(/^['"]|['"]$/g, '');
  }
}

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR  = path.join(__dirname, '..', 'data', 'neighbourhoods');

const MODEL      = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 1024;

// ---------------------------------------------------------------------------
// Slug → {neighbourhood, city, country} lookup
// Covers known East Africa locations. Unknown slugs are parsed from the slug.
// ---------------------------------------------------------------------------
const SLUG_META = {
  // Nairobi
  'westlands-nairobi':     { neighbourhood: 'Westlands',     city: 'Nairobi',       country: 'Kenya' },
  'kilimani-nairobi':      { neighbourhood: 'Kilimani',       city: 'Nairobi',       country: 'Kenya' },
  'upper-hill-nairobi':    { neighbourhood: 'Upper Hill',     city: 'Nairobi',       country: 'Kenya' },
  'riverside-nairobi':     { neighbourhood: 'Riverside',      city: 'Nairobi',       country: 'Kenya' },
  'karen-nairobi':         { neighbourhood: 'Karen',           city: 'Nairobi',       country: 'Kenya' },
  'lavington-nairobi':     { neighbourhood: 'Lavington',      city: 'Nairobi',       country: 'Kenya' },
  'parklands-nairobi':     { neighbourhood: 'Parklands',      city: 'Nairobi',       country: 'Kenya' },
  'kileleshwa-nairobi':    { neighbourhood: 'Kileleshwa',     city: 'Nairobi',       country: 'Kenya' },
  'runda-nairobi':         { neighbourhood: 'Runda',           city: 'Nairobi',       country: 'Kenya' },
  'muthaiga-nairobi':      { neighbourhood: 'Muthaiga',       city: 'Nairobi',       country: 'Kenya' },
  'gigiri-nairobi':        { neighbourhood: 'Gigiri',          city: 'Nairobi',       country: 'Kenya' },
  'hurlingham-nairobi':    { neighbourhood: 'Hurlingham',     city: 'Nairobi',       country: 'Kenya' },
  'south-b-nairobi':       { neighbourhood: 'South B',        city: 'Nairobi',       country: 'Kenya' },
  'south-c-nairobi':       { neighbourhood: 'South C',        city: 'Nairobi',       country: 'Kenya' },
  'langata-nairobi':       { neighbourhood: 'Lang\'ata',      city: 'Nairobi',       country: 'Kenya' },
  'ngong-road-nairobi':    { neighbourhood: 'Ngong Road',     city: 'Nairobi',       country: 'Kenya' },
  'cbd-nairobi':           { neighbourhood: 'CBD',             city: 'Nairobi',       country: 'Kenya' },
  'nairobi-city':          { neighbourhood: null,              city: 'Nairobi',       country: 'Kenya' },
  // Kampala
  'kololo-kampala':        { neighbourhood: 'Kololo',          city: 'Kampala',       country: 'Uganda' },
  'nakasero-kampala':      { neighbourhood: 'Nakasero',        city: 'Kampala',       country: 'Uganda' },
  'kampala-city':          { neighbourhood: null,              city: 'Kampala',       country: 'Uganda' },
  // Dar es Salaam
  'oyster-bay-dar':        { neighbourhood: 'Oyster Bay',     city: 'Dar es Salaam', country: 'Tanzania' },
  'masaki-dar':            { neighbourhood: 'Masaki',          city: 'Dar es Salaam', country: 'Tanzania' },
  'dar-es-salaam-city':    { neighbourhood: null,              city: 'Dar es Salaam', country: 'Tanzania' },
  // Zanzibar
  'stone-town-zanzibar':   { neighbourhood: 'Stone Town',     city: 'Zanzibar',      country: 'Tanzania' },
  'zanzibar-city':         { neighbourhood: null,              city: 'Zanzibar',      country: 'Tanzania' },
};

function metaFromSlug(slug) {
  if (SLUG_META[slug]) return SLUG_META[slug];
  // Parse unknown slug: "some-area-cityname" → best effort
  const parts = slug.split('-');
  const city  = parts[parts.length - 1];
  const area  = parts.slice(0, -1).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  return { neighbourhood: area || null, city: city[0].toUpperCase() + city.slice(1), country: 'Kenya' };
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildPrompt({ neighbourhood, city, country }) {
  const area    = neighbourhood ? `the ${neighbourhood} neighbourhood of ${city}, ${country}` : `${city}, ${country}`;
  const context = neighbourhood
    ? `The guest is staying in ${neighbourhood}.`
    : `The guest is staying somewhere in ${city}.`;

  return `You are a knowledgeable local guide for ${area}.

${context} Generate a neighbourhood guide for short-stay guests: business travellers, diaspora visitors, and tourists.

Return exactly 5 places as a JSON array. Each place must follow this schema:
{
  "name": "exact place name (must be a real, well-known place)",
  "category": "one of: Food | Nature | Culture | Shopping | Nightlife | Wellness | Practical",
  "description": "exactly 2 sentences — be specific about why it's worth visiting for someone staying nearby. Mention one concrete detail (a dish, a view, a price range, an opening time, etc.)",
  "walking_distance": "approximate from the neighbourhood centre, e.g. '8 min walk' or '5 min drive'"
}

Rules:
- Only include places that genuinely exist in or very close to ${area}
- Mix categories — no more than 2 places in the same category
- Prioritise places a first-time visitor would actually use, not obscure local gems
- Do not invent or hallucinate places
- Return only valid JSON — no markdown, no code fences, no explanation

JSON array:`;
}

// ---------------------------------------------------------------------------
// Claude API call
// ---------------------------------------------------------------------------

async function generateFromClaude(meta) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set.\n' +
      'Add it to your environment: export ANTHROPIC_API_KEY=sk-ant-...'
    );
  }

  const client = new Anthropic({ apiKey });
  const prompt = buildPrompt(meta);

  const response = await client.messages.create({
    model:      MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = response.content[0]?.text?.trim();
  if (!raw) throw new Error('Empty response from Claude');

  return raw;
}

// ---------------------------------------------------------------------------
// Parse + validate Claude's JSON output
// ---------------------------------------------------------------------------

const VALID_CATEGORIES = new Set(['Food', 'Nature', 'Culture', 'Shopping', 'Nightlife', 'Wellness', 'Practical']);

function validateAndParse(raw, meta) {
  let places;
  try {
    // Strip any accidental markdown fences
    const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    places = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Claude returned invalid JSON: ${err.message}\n\nRaw output:\n${raw}`);
  }

  if (!Array.isArray(places)) {
    throw new Error(`Expected JSON array, got: ${typeof places}`);
  }

  // Validate and coerce each place
  const validated = places.map((p, i) => {
    if (!p.name)        throw new Error(`Place [${i}] missing "name"`);
    if (!p.description) throw new Error(`Place [${i}] missing "description"`);

    // Normalise category
    const cat = p.category ? String(p.category).trim() : 'Practical';
    const category = VALID_CATEGORIES.has(cat) ? cat : 'Practical';

    return {
      name:             String(p.name).trim(),
      category,
      description:      String(p.description).trim(),
      walking_distance: p.walking_distance ? String(p.walking_distance).trim() : null,
    };
  });

  if (validated.length < 3) {
    throw new Error(`Only ${validated.length} places returned — expected at least 3`);
  }

  return validated;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function buildNeighbourhood(slug, options = {}) {
  const { refresh = false, verbose = false } = options;

  const cachePath = path.join(CACHE_DIR, `${slug}.json`);

  // Return cached guide unless refresh requested
  if (!refresh && fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (verbose) console.log(`[neighbourhood] Cache hit: ${slug} (curated: ${cached.curated})`);
    return cached;
  }

  const meta = metaFromSlug(slug);
  const area = meta.neighbourhood || meta.city;
  console.log(`[neighbourhood] Generating guide for: ${area}, ${meta.city}`);

  let places;
  try {
    const raw = await generateFromClaude(meta);
    if (verbose) console.log('\n[debug] Raw Claude output:\n', raw, '\n');
    places = validateAndParse(raw, meta);
  } catch (err) {
    console.error(`  ✗ Claude generation failed: ${err.message}`);
    // Return a minimal safe fallback so site generation doesn't break
    console.warn('  → Using empty fallback guide');
    places = [];
  }

  const guide = {
    neighbourhood: meta.neighbourhood,
    city:          meta.city,
    country:       meta.country,
    slug,
    generated_by:  places.length > 0 ? MODEL : 'fallback',
    generated_at:  new Date().toISOString().split('T')[0],
    curated:       false,
    places,
  };

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(guide, null, 2));
  console.log(`  ✓ ${places.length} places → ${cachePath}`);

  if (verbose && places.length > 0) {
    console.log('\n  Places:');
    places.forEach(p => console.log(`    [${p.category}] ${p.name} — ${p.walking_distance}`));
  }

  return guide;
}

/**
 * Convenience wrapper — takes a listing object and derives the slug,
 * then returns the guide. Used by generate.js.
 */
export async function buildNeighbourhoodFromListing(listing, options = {}) {
  const slug = listing?.location?.neighbourhood_slug;
  if (!slug) {
    console.warn('[neighbourhood] No neighbourhood slug on listing — skipping guide');
    return null;
  }
  return buildNeighbourhood(slug, options);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args    = process.argv.slice(2);
  const refresh = args.includes('--refresh');
  const verbose = args.includes('--verbose');

  if (args.includes('--test')) {
    console.log('=== Neighbourhood guide smoke test ===\n');
    const testSlug = 'westlands-nairobi';
    try {
      const guide = await buildNeighbourhood(testSlug, { refresh: true, verbose: true });
      if (guide.places.length < 3) throw new Error(`Only ${guide.places.length} places`);
      console.log('\n✅ PASS');
    } catch (err) {
      console.error(`\n❌ FAIL: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (args.includes('--listing')) {
    const listingPath = args[args.indexOf('--listing') + 1];
    if (!listingPath || !fs.existsSync(listingPath)) {
      console.error('--listing requires a path to a listing JSON file');
      process.exit(1);
    }
    const listing = JSON.parse(fs.readFileSync(listingPath, 'utf8'));
    await buildNeighbourhoodFromListing(listing, { refresh, verbose });
    return;
  }

  const slug = args.find(a => !a.startsWith('--'));
  if (!slug) {
    console.error('Usage: node scripts/build-neighbourhood.js <slug>');
    console.error('       node scripts/build-neighbourhood.js --listing <path-to-listing.json>');
    console.error('       node scripts/build-neighbourhood.js --test');
    console.error('\nKnown slugs:', Object.keys(SLUG_META).join(', '));
    process.exit(1);
  }

  try {
    await buildNeighbourhood(slug, { refresh, verbose });
  } catch (err) {
    console.error(`\n❌ ${err.message}`);
    process.exit(1);
  }
}

// Only run CLI when invoked directly (not when imported)
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main();
}
