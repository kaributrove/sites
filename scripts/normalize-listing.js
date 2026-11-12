/**
 * normalize-listing.js
 *
 * Maps Airbnb page data to our canonical listing schema.
 *
 * Data sources (in priority order):
 *   1. data-deferred-state-0  → pdpPresentation  (primary — has everything)
 *   2. JSON-LD VacationRental                     (fallback for core fields)
 *   3. og:title / meta tags                       (last resort)
 *
 * When Airbnb restructures, only the PATHS constants below need updating.
 */

// ---------------------------------------------------------------------------
// Neighbourhood slug mapping
// ---------------------------------------------------------------------------
const NEIGHBOURHOOD_MAP = {
  // Nairobi
  'westlands':     'westlands-nairobi',
  'kilimani':      'kilimani-nairobi',
  'upper hill':    'upper-hill-nairobi',
  'upperhill':     'upper-hill-nairobi',
  'riverside':     'riverside-nairobi',
  'karen':         'karen-nairobi',
  'lavington':     'lavington-nairobi',
  'parklands':     'parklands-nairobi',
  'kileleshwa':    'kileleshwa-nairobi',
  'runda':         'runda-nairobi',
  'muthaiga':      'muthaiga-nairobi',
  'gigiri':        'gigiri-nairobi',
  'hurlingham':    'hurlingham-nairobi',
  'south b':       'south-b-nairobi',
  'south c':       'south-c-nairobi',
  'langata':       'langata-nairobi',
  'ngong road':    'ngong-road-nairobi',
  'cbd':           'cbd-nairobi',
  'nairobi':       'nairobi-city',
  // Kampala
  'kololo':        'kololo-kampala',
  'nakasero':      'nakasero-kampala',
  'kampala':       'kampala-city',
  // Dar es Salaam
  'oyster bay':    'oyster-bay-dar',
  'masaki':        'masaki-dar',
  'dar es salaam': 'dar-es-salaam-city',
  // Zanzibar
  'stone town':    'stone-town-zanzibar',
  'zanzibar':      'zanzibar-city',
};

function neighbourhoodSlug(city, neighbourhood) {
  const area = (neighbourhood || city || '').toLowerCase().trim();
  if (!area) return null;
  if (NEIGHBOURHOOD_MAP[area]) return NEIGHBOURHOOD_MAP[area];
  // Fallback: slugify whatever we got (strip punctuation before slugifying)
  const citySlug = (city || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const areaSlug = area.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${areaSlug}-${citySlug}`.replace(/--+/g, '-').replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// Amenities we don't bother showing — adds noise, not signal
// ---------------------------------------------------------------------------
const AMENITY_BLOCKLIST = new Set([
  'essentials', 'hangers', 'extra pillows and blankets', 'luggage dropoff allowed',
  'long term stays allowed', 'ethernet connection',
]);

// ---------------------------------------------------------------------------
// Parse "2 bedrooms · 2 beds · 2 baths" from og:title
// ---------------------------------------------------------------------------
function parseSpecsFromTitle(ogTitle) {
  if (!ogTitle) return {};
  return {
    bedrooms:  parseInt(ogTitle.match(/(\d+)\s+bedroom/i)?.[1])  || null,
    beds:      parseInt(ogTitle.match(/(\d+)\s+bed[^r]/i)?.[1])  || null,
    bathrooms: parseFloat(ogTitle.match(/([\d.]+)\s+bath/i)?.[1]) || null,
  };
}

// ---------------------------------------------------------------------------
// Parse overview items array: ["4 guests","2 bedrooms","2 beds","2 baths"]
// ---------------------------------------------------------------------------
function parseOverviewItems(items) {
  if (!Array.isArray(items)) return {};
  const str = items.join(' ');
  return {
    max_guests: parseInt(str.match(/(\d+)\s+guest/i)?.[1])        || null,
    bedrooms:   parseInt(str.match(/(\d+)\s+bedroom/i)?.[1])      || null,
    beds:       parseInt(str.match(/(\d+)\s+bed[^r]/i)?.[1])      || null,
    bathrooms:  parseFloat(str.match(/([\d.]+)\s+bath/i)?.[1])    || null,
  };
}

// ---------------------------------------------------------------------------
// Extract all available amenities from seeAllAmenitiesGroups
// ---------------------------------------------------------------------------
function extractAmenities(amenitiesObj) {
  const groups = amenitiesObj?.seeAllAmenitiesGroups || amenitiesObj?.previewAmenitiesGroups || [];
  const result = [];
  for (const group of groups) {
    for (const a of (group.amenities || [])) {
      if (a.available && a.title && !AMENITY_BLOCKLIST.has(a.title.toLowerCase())) {
        result.push(a.title);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Extract photos from heroMedia.edges
// ---------------------------------------------------------------------------
function extractPhotos(heroMedia) {
  const edges = heroMedia?.edges || [];
  return edges
    .map(e => e?.node?.image?.uri)
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Extract house rules
// ---------------------------------------------------------------------------
function extractHouseRules(rulesObj) {
  const groups = rulesObj?.groupItems || [];
  const rules = [];
  for (const group of groups) {
    for (const item of (group.items || [])) {
      if (item?.title) rules.push(item.title);
    }
  }
  return rules;
}

// ---------------------------------------------------------------------------
// Main normalizer — takes parsed page data objects, returns canonical listing
// ---------------------------------------------------------------------------
export function normalizeListing({ pdp, jsonLd, ogTitle, listingId, sourceUrl }) {
  // ── Core fields from pdp (data-deferred-state-0) ──────────────────────────
  const title = pdp?.title?.content?.localizedStringWithTranslationPreference
             || jsonLd?.name
             || ogTitle?.replace(/ - Airbnb$/, '')
             || `Property ${listingId}`;

  const description = pdp?.descriptions?.longDescriptionHtml?.localizedStringWithTranslationPreference
                   || jsonLd?.description
                   || '';

  const city          = (pdp?.localizedLocation || jsonLd?.address?.addressLocality || '').trim();
  const locationName  = pdp?.location?.locationName || null;  // neighbourhood when available
  const latitude      = pdp?.location?.latitude  ?? jsonLd?.latitude  ?? null;
  const longitude     = pdp?.location?.longitude ?? jsonLd?.longitude ?? null;

  const neighbourhood = locationName || null;
  const nbSlug        = neighbourhoodSlug(city, neighbourhood);

  // ── Specs ─────────────────────────────────────────────────────────────────
  const overviewSpecs = parseOverviewItems(pdp?.overview?.items);
  const titleSpecs    = parseSpecsFromTitle(ogTitle);

  const specs = {
    bedrooms:   overviewSpecs.bedrooms   ?? titleSpecs.bedrooms   ?? null,
    bathrooms:  overviewSpecs.bathrooms  ?? titleSpecs.bathrooms  ?? null,
    beds:       overviewSpecs.beds       ?? titleSpecs.beds       ?? null,
    max_guests: pdp?.personCapacity
             ?? overviewSpecs.max_guests
             ?? jsonLd?.containsPlace?.occupancy?.value
             ?? null,
  };

  // ── Host ──────────────────────────────────────────────────────────────────
  const passport    = pdp?.hostInfo?.passportData;
  const hostOverview = pdp?.hostInfo?.overview;
  const hostName    = passport?.name
                   || hostOverview?.title?.text?.replace('Hosted by ', '')
                   || null;
  const isSuperhost = passport?.isSuperhost ?? false;
  const hostAvatar  = passport?.profilePictureUrl || null;
  const hostAbout   = pdp?.hostInfo?.about?.content?.localizedStringWithTranslationPreference
                   || null;
  const hostStats   = {
    response_time:  pdp?.hostInfo?.responseTimeText || null,
    response_rate:  pdp?.hostInfo?.responseRateText || null,
    reviews:        passport?.ratingCount ?? null,
    rating:         passport?.ratingAverage ?? null,
    time_as_host:   hostOverview?.items?.find(i => i?.text?.includes('hosting'))?.text || null,
  };

  // ── Rating ────────────────────────────────────────────────────────────────
  const ratingStats  = pdp?.quality?.listingRatingStats?.overallRatingStats;
  const ratingValue  = ratingStats?.ratingAverage
                    ?? (jsonLd?.aggregateRating?.ratingValue ? parseFloat(jsonLd.aggregateRating.ratingValue) : null);
  const ratingCount  = ratingStats?.ratingCount
                    ?? (jsonLd?.aggregateRating?.ratingCount ? parseInt(jsonLd.aggregateRating.ratingCount) : null);
  const isGuestFave  = pdp?.quality?.isGuestFavorite ?? false;
  const categoryRatings = (pdp?.quality?.categoryRatings || []).map(r => ({
    label: r?.localizedRatingTitle || r?.title,
    value: r?.rating,
  }));

  // ── Photos ────────────────────────────────────────────────────────────────
  const photos = extractPhotos(pdp?.heroMedia).length > 0
    ? extractPhotos(pdp?.heroMedia)
    : (Array.isArray(jsonLd?.image) ? jsonLd.image : jsonLd?.image ? [jsonLd.image] : []);

  // ── Amenities ─────────────────────────────────────────────────────────────
  const amenities = extractAmenities(pdp?.amenities);

  // ── House rules ───────────────────────────────────────────────────────────
  const houseRules = extractHouseRules(pdp?.rules);

  // ── Property type ─────────────────────────────────────────────────────────
  const propertyType = pdp?.sharingConfig?.propertyType || null;

  return {
    listing_id:    String(listingId),
    source_url:    sourceUrl,
    scraped_at:    new Date().toISOString(),
    title,
    description,
    property_type: propertyType,

    location: {
      city,
      country:            null,  // not reliably in pdp — enrich from JSON-LD breadcrumbs if needed
      neighbourhood,
      neighbourhood_slug: nbSlug,
      latitude,
      longitude,
    },

    specs,

    host: {
      name:        hostName,
      is_superhost: isSuperhost,
      avatar_url:  hostAvatar,
      about:       hostAbout,
      stats:       hostStats,
    },

    rating: {
      value:           ratingValue,
      count:           ratingCount,
      is_guest_fave:   isGuestFave,
      category_ratings: categoryRatings,
    },

    photos,
    amenities,
    house_rules: houseRules,

    pricing: {
      nightly_display: null,  // Airbnb pricing requires date params — set by host in onboarding
      direct_nightly:  null,  // set by host
    },

    checkin_time:  null,  // not in static data — host sets during onboarding
    checkout_time: null,

    _meta: {
      photo_count:   photos.length,
      amenity_count: amenities.length,
      has_full_data: !!pdp,
    },
  };
}
