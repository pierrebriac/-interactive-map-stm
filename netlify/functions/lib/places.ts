import { haversineKm } from '../../../src/shared/geo.ts'
import type {
  GeoPoint,
  GeocodeResponse,
  ResolvedPlace,
} from '../../../src/shared/types.ts'

const MONTREAL_BBOX = [-74.15, 45.35, -73.35, 45.75] as const
const MONTREAL_PROXIMITY = [-73.5673, 45.5017] as const
const MONTREAL_CIVIC_RESOURCE_ID = 'fed5fd02-5535-458e-b13f-66e7a31a6d78'
const MONTREAL_CIVIC_API_URL =
  'https://www.donneesquebec.ca/recherche/api/3/action/datastore_search'
const MONTREAL_CIVIC_CACHE_TTL_MS = 1000 * 60 * 30
const MONTREAL_CIVIC_PAGE_SIZE = 250
const MONTREAL_CIVIC_MAX_ROWS = 1000

const STREET_TYPE_ALIASES = new Map<string, string>([
  ['av', 'avenue'],
  ['ave', 'avenue'],
  ['avenue', 'avenue'],
  ['aut', 'autoroute'],
  ['autoroute', 'autoroute'],
  ['bd', 'boulevard'],
  ['boul', 'boulevard'],
  ['boulevard', 'boulevard'],
  ['carre', 'carré'],
  ['carre.', 'carré'],
  ['carré', 'carré'],
  ['ch', 'chemin'],
  ['chemin', 'chemin'],
  ['crois', 'croissant'],
  ['croissant', 'croissant'],
  ['imp', 'impasse'],
  ['impasse', 'impasse'],
  ['montee', 'montée'],
  ['montée', 'montée'],
  ['pl', 'place'],
  ['place', 'place'],
  ['prom', 'promenade'],
  ['promenade', 'promenade'],
  ['rte', 'route'],
  ['route', 'route'],
  ['ruelle', 'ruelle'],
  ['rue', 'rue'],
  ['terr', 'terrasse'],
  ['terrasse', 'terrasse'],
])

const STREET_LINK_WORDS = new Set([
  'd',
  'de',
  'des',
  'du',
  'l',
  'la',
  'le',
  'les',
])

const ORIENTATION_ALIASES = new Map<string, string>([
  ['e', 'E'],
  ['est', 'E'],
  ['n', 'N'],
  ['nord', 'N'],
  ['o', 'O'],
  ['ouest', 'O'],
  ['s', 'S'],
  ['sud', 'S'],
  ['x', 'X'],
])

const civicLookupCache = new Map<
  string,
  {
    expiresAt: number
    value: ResolvedPlace[]
  }
>()

interface MapTilerGeocodeFeature {
  id?: string
  text?: string
  place_name?: string
  center?: [number, number]
  place_type?: string[]
  relevance?: number
  properties?: {
    address?: string
  }
}

interface MapTilerGeocodeResponse {
  features?: MapTilerGeocodeFeature[]
}

interface NominatimResult {
  place_id?: number
  lat?: string
  lon?: string
  name?: string
  display_name?: string
  category?: string
  type?: string
  importance?: number
}

interface OrsFeatureCollection {
  features?: Array<{
    geometry?: {
      coordinates?: [number, number][]
    }
    properties?: {
      summary?: {
        distance?: number
        duration?: number
      }
    }
  }>
}

interface MontrealCivicRecord {
  ID_ADRESSE?: string
  SPECIFIQUE?: string
  ORIENTATION?: string
  LIEN?: string | null
  GENERIQUE?: string
  ADDR_DE?: string
  ADDR_A?: string
  LONGITUDE?: string
  LATITUDE?: string
}

interface MontrealCivicResponse {
  success?: boolean
  result?: {
    total?: number
    records?: MontrealCivicRecord[]
  }
}

interface StreetDescriptor {
  generic: string
  specific: string
  orientation: string | null
  normalizedStreet: string
}

export interface RoutedSurface {
  geometry: [number, number][]
  distanceKm: number
  durationMin: number
  provider: 'openrouteservice' | 'osrm' | 'estimated'
  warnings: string[]
}

export async function geocodePlaces(query: string, limit = 6) {
  const trimmed = query.trim()
  if (!trimmed) {
    return {
      generatedAt: new Date().toISOString(),
      query: '',
      features: [],
      warnings: [],
    } satisfies GeocodeResponse
  }

  const warnings: string[] = []

  let features = await geocodeWithMapTiler(trimmed, limit).catch((error) => {
    warnings.push(
      error instanceof Error
        ? `MapTiler indisponible: ${error.message}`
        : 'MapTiler indisponible.',
    )
    return [] as ResolvedPlace[]
  })

  if (shouldUseNominatimFallback(trimmed, features)) {
    const fallbackFeatures = await geocodeWithNominatim(trimmed, limit).catch((error) => {
      warnings.push(
        error instanceof Error
          ? `Nominatim indisponible: ${error.message}`
          : 'Nominatim indisponible.',
      )
      return [] as ResolvedPlace[]
    })

    if (fallbackFeatures.length > 0) {
      features = fallbackFeatures
    }
  }

  if (containsStreetNumber(trimmed) && !hasExactStreetNumberMatch(trimmed, features)) {
    const civicMatches = await geocodeWithMontrealCivic(trimmed, features, limit).catch(
      (error) => {
        warnings.push(
          error instanceof Error
            ? `Adresse civique Montréal indisponible: ${error.message}`
            : 'Adresse civique Montréal indisponible.',
        )
        return [] as ResolvedPlace[]
      },
    )

    if (civicMatches.length > 0) {
      features = dedupeResolvedPlaces([...civicMatches, ...features])
    }
  }

  features = rankResolvedPlaces(trimmed, features).slice(0, Math.min(Math.max(limit, 1), 10))

  return {
    generatedAt: new Date().toISOString(),
    query: trimmed,
    features,
    warnings,
  } satisfies GeocodeResponse
}

export async function resolvePlace(input: {
  query?: string | null
  lat?: number | null
  lon?: number | null
  label?: string | null
}) {
  if (typeof input.lat === 'number' && typeof input.lon === 'number') {
    return {
      id: `coord:${input.lat.toFixed(6)},${input.lon.toFixed(6)}`,
      label: input.label || input.query || 'Point sélectionné',
      address: input.query || input.label || 'Coordonnées fournies',
      placeType: 'coordinate',
      relevance: 1,
      lat: input.lat,
      lon: input.lon,
    } satisfies ResolvedPlace
  }

  if (!input.query?.trim()) {
    throw new Error('Une adresse ou des coordonnées sont requises.')
  }

  const geocoded = await geocodePlaces(input.query, 1)
  const bestMatch = geocoded.features[0]
  if (!bestMatch) {
    throw new Error(`Adresse introuvable: ${input.query}`)
  }

  return mergePlaceWithQuery(bestMatch, input.query)
}

export async function routeSurfacePath(
  from: GeoPoint,
  to: GeoPoint,
  profile: 'walking' | 'cycling',
) {
  const orsKey = process.env.ORS_API_KEY
  const warnings: string[] = []

  if (orsKey) {
    const profileId = profile === 'walking' ? 'foot-walking' : 'cycling-regular'
    const response = await fetch(
      `https://api.openrouteservice.org/v2/directions/${profileId}/geojson`,
      {
        method: 'POST',
        headers: {
          Authorization: orsKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          coordinates: [
            [from.lon, from.lat],
            [to.lon, to.lat],
          ],
          instructions: false,
        }),
      },
    )

    if (response.ok) {
      const payload = (await response.json()) as OrsFeatureCollection
      const feature = payload.features?.[0]
      const coordinates = feature?.geometry?.coordinates
      const distanceMeters = feature?.properties?.summary?.distance
      const durationSeconds = feature?.properties?.summary?.duration

      if (
        coordinates &&
        typeof distanceMeters === 'number' &&
        typeof durationSeconds === 'number'
      ) {
        return {
          geometry: coordinates,
          distanceKm: distanceMeters / 1000,
          durationMin: durationSeconds / 60,
          provider: 'openrouteservice',
          warnings,
        } satisfies RoutedSurface
      }

      warnings.push('OpenRouteService a répondu de façon incomplète.')
    } else {
      warnings.push(`OpenRouteService a répondu ${response.status}.`)
    }
  }

  const osrmRoute = await routeSurfaceWithOsrm(from, to, profile).catch((error) => {
    warnings.push(
      error instanceof Error ? error.message : 'Le routage OSRM a échoué.',
    )
    return null
  })

  if (osrmRoute) {
    return {
      ...osrmRoute,
      warnings,
    }
  }

  const fallback = estimateSurfacePath(from, to, profile)
  fallback.warnings.push(...warnings)
  fallback.warnings.push('Le tracé a été estimé faute de moteur de routage disponible.')
  return fallback
}

export function estimateSurfacePath(
  from: GeoPoint,
  to: GeoPoint,
  profile: 'walking' | 'cycling',
) {
  const directKm = haversineKm(from.lat, from.lon, to.lat, to.lon)
  const networkFactor = profile === 'walking' ? 1.24 : 1.12
  const speedKmH = profile === 'walking' ? 4.8 : 15.5
  const distanceKm = directKm * networkFactor

  return {
    geometry: [
      [from.lon, from.lat],
      [to.lon, to.lat],
    ],
    distanceKm,
    durationMin: (distanceKm / speedKmH) * 60,
    provider: 'estimated',
    warnings: [] as string[],
  } satisfies RoutedSurface
}

function getMapTilerKey() {
  const key = process.env.MAPTILER_API_KEY || process.env.VITE_MAPTILER_API_KEY
  if (!key) {
    throw new Error('MAPTILER_API_KEY manquante pour le géocodage.')
  }

  return key
}

async function geocodeWithMapTiler(query: string, limit: number) {
  const mapTilerKey = getMapTilerKey()
  const url = new URL(
    `https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json`,
  )
  url.searchParams.set('key', mapTilerKey)
  url.searchParams.set('language', 'fr')
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 10)))
  url.searchParams.set('bbox', MONTREAL_BBOX.join(','))
  url.searchParams.set('proximity', MONTREAL_PROXIMITY.join(','))
  url.searchParams.set('country', 'ca')
  url.searchParams.set('autocomplete', containsStreetNumber(query) ? 'false' : 'true')

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`MapTiler geocoding returned ${response.status}`)
  }

  const payload = (await response.json()) as MapTilerGeocodeResponse
  return (payload.features ?? [])
    .filter(
      (feature): feature is MapTilerGeocodeFeature & {
        id: string
        place_name: string
        center: [number, number]
      } =>
        typeof feature.id === 'string' &&
        typeof feature.place_name === 'string' &&
        Array.isArray(feature.center) &&
        feature.center.length === 2 &&
        typeof feature.center[0] === 'number' &&
        typeof feature.center[1] === 'number',
    )
    .map<ResolvedPlace>((feature) => ({
      id: feature.id,
      label: feature.text || feature.place_name,
      address: feature.place_name,
      placeType: feature.place_type?.[0] || 'place',
      relevance: feature.relevance ?? 0,
      lon: feature.center[0],
      lat: feature.center[1],
    }))
}

async function geocodeWithNominatim(query: string, limit: number) {
  const url = new URL('https://nominatim.openstreetmap.org/search')
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('addressdetails', '1')
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 10)))
  url.searchParams.set('countrycodes', 'ca')
  url.searchParams.set('viewbox', `${MONTREAL_BBOX[0]},${MONTREAL_BBOX[3]},${MONTREAL_BBOX[2]},${MONTREAL_BBOX[1]}`)
  url.searchParams.set('bounded', '1')
  url.searchParams.set('q', query)

  const response = await fetch(url, {
    headers: {
      'accept-language': 'fr',
      'user-agent': 'TransitAtlas/1.0',
    },
  })

  if (!response.ok) {
    throw new Error(`Nominatim returned ${response.status}`)
  }

  const payload = (await response.json()) as NominatimResult[]

  return payload
    .filter(
      (entry): entry is NominatimResult & {
        place_id: number
        lat: string
        lon: string
        display_name: string
      } =>
        typeof entry.place_id === 'number' &&
        typeof entry.display_name === 'string' &&
        typeof entry.lat === 'string' &&
        typeof entry.lon === 'string',
    )
    .map<ResolvedPlace>((entry) => ({
      id: `nominatim:${entry.place_id}`,
      label: entry.name || entry.display_name.split(',')[0] || entry.display_name,
      address: entry.display_name,
      placeType: entry.type || entry.category || 'place',
      relevance: entry.importance ?? 0.5,
      lon: Number.parseFloat(entry.lon),
      lat: Number.parseFloat(entry.lat),
    }))
    .filter(
      (entry) =>
        Number.isFinite(entry.lon) &&
        Number.isFinite(entry.lat),
    )
}

async function geocodeWithMontrealCivic(
  query: string,
  seedPlaces: ResolvedPlace[],
  limit: number,
) {
  const cached = civicLookupCache.get(query)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value.slice(0, limit)
  }

  const descriptors = buildStreetDescriptors(query, seedPlaces)
  const houseNumber = parseStreetNumber(query)
  if (!houseNumber || descriptors.length === 0) {
    return []
  }

  const exactMatches: Array<{
    descriptor: StreetDescriptor
    row: MontrealCivicRecord
    distanceToRange: number
    exact: boolean
  }> = []
  const approximateMatches: Array<{
    descriptor: StreetDescriptor
    row: MontrealCivicRecord
    distanceToRange: number
    exact: boolean
  }> = []

  for (const descriptor of descriptors) {
    const rows = await fetchMontrealStreetRows(descriptor)
    if (rows.length === 0) {
      continue
    }

    for (const row of rows) {
      const range = parseCivicRange(row.ADDR_DE, row.ADDR_A)
      if (!range) {
        continue
      }

      const distanceToRange =
        houseNumber < range.min
          ? range.min - houseNumber
          : houseNumber > range.max
            ? houseNumber - range.max
            : 0

      const candidate = {
        descriptor,
        row,
        distanceToRange,
        exact: distanceToRange === 0,
      }

      if (candidate.exact) {
        exactMatches.push(candidate)
      } else {
        approximateMatches.push(candidate)
      }
    }

    if (exactMatches.length > 0) {
      break
    }
  }

  const chosen = (exactMatches.length > 0 ? exactMatches : approximateMatches)
    .sort((left, right) => left.distanceToRange - right.distanceToRange)
    .slice(0, exactMatches.length > 0 ? Math.min(Math.max(limit, 1), 4) : 1)
    .map((candidate) => toMontrealCivicPlace(houseNumber, candidate))

  civicLookupCache.set(query, {
    expiresAt: Date.now() + MONTREAL_CIVIC_CACHE_TTL_MS,
    value: chosen,
  })

  return chosen
}

function shouldUseNominatimFallback(query: string, features: ResolvedPlace[]) {
  if (features.length === 0) {
    return true
  }

  const top = features[0]
  if (containsStreetNumber(query) && top.placeType === 'address') {
    return false
  }

  const normalizedQuery = normalizeLooseText(query)
  const normalizedMatch = normalizeLooseText(`${top.label} ${top.address}`)
  const broadPlace =
    top.placeType === 'municipality' ||
    top.placeType === 'county' ||
    top.placeType === 'subregion' ||
    top.placeType === 'country'

  if (broadPlace && top.relevance < 0.8) {
    return true
  }

  if (normalizedQuery.length >= 4 && !normalizedMatch.includes(normalizedQuery)) {
    return true
  }

  return false
}

function hasExactStreetNumberMatch(query: string, features: ResolvedPlace[]) {
  const houseNumber = extractStreetNumber(query)
  if (!houseNumber) {
    return false
  }

  return features.some((feature) => {
    const haystack = normalizeLooseText(`${feature.label} ${feature.address}`)
    return feature.placeType === 'address' && haystack.includes(houseNumber)
  })
}

function normalizeLooseText(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
}

function dedupeResolvedPlaces(features: ResolvedPlace[]) {
  const deduped = new Map<string, ResolvedPlace>()

  for (const feature of features) {
    const key = [
      normalizeLooseText(feature.label),
      normalizeLooseText(feature.address),
      feature.lat.toFixed(5),
      feature.lon.toFixed(5),
    ].join(':')
    if (!deduped.has(key)) {
      deduped.set(key, feature)
    }
  }

  return Array.from(deduped.values())
}

async function routeSurfaceWithOsrm(
  from: GeoPoint,
  to: GeoPoint,
  profile: 'walking' | 'cycling',
) {
  const profileId = profile === 'walking' ? 'foot' : 'bike'
  const url = new URL(
    `https://router.project-osrm.org/route/v1/${profileId}/${from.lon},${from.lat};${to.lon},${to.lat}`,
  )
  url.searchParams.set('overview', 'full')
  url.searchParams.set('geometries', 'geojson')

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`OSRM a répondu ${response.status}.`)
  }

  const payload = (await response.json()) as {
    routes?: Array<{
      distance?: number
      duration?: number
      geometry?: {
        coordinates?: [number, number][]
      }
    }>
  }

  const route = payload.routes?.[0]
  const coordinates = route?.geometry?.coordinates
  const distanceMeters = route?.distance
  const durationSeconds = route?.duration

  if (!coordinates || typeof distanceMeters !== 'number' || typeof durationSeconds !== 'number') {
    throw new Error('OSRM a répondu sans géométrie exploitable.')
  }

  return {
    geometry: coordinates,
    distanceKm: distanceMeters / 1000,
    durationMin: durationSeconds / 60,
    provider: 'osrm',
    warnings: [] as string[],
  } satisfies RoutedSurface
}

function rankResolvedPlaces(query: string, features: ResolvedPlace[]) {
  return [...features].sort(
    (left, right) => scoreResolvedPlace(query, right) - scoreResolvedPlace(query, left),
  )
}

function scoreResolvedPlace(query: string, place: ResolvedPlace) {
  let score = place.relevance
  const normalizedQuery = normalizeLooseText(query)
  const normalizedAddress = normalizeLooseText(`${place.label} ${place.address}`)
  const queryTokens = normalizedQuery.split(/\s+/).filter(Boolean)
  const houseNumber = extractStreetNumber(query)

  if (place.placeType === 'address') {
    score += 2
  }

  if (houseNumber && normalizedAddress.includes(houseNumber)) {
    score += 4
  }

  if (houseNumber && place.placeType === 'address' && normalizeLooseText(place.label).startsWith(houseNumber)) {
    score += 6
  }

  const matchedTokens = queryTokens.filter((token) => normalizedAddress.includes(token)).length
  score += matchedTokens * 0.2

  return score
}

function mergePlaceWithQuery(place: ResolvedPlace, query: string) {
  const trimmed = query.trim()
  if (!trimmed) {
    return place
  }

  const label = trimmed.split(',')[0]?.trim() || trimmed
  const houseNumber = extractStreetNumber(trimmed)
  const normalizedMatch = normalizeLooseText(`${place.label} ${place.address}`)

  if (houseNumber && !normalizedMatch.includes(houseNumber)) {
    return {
      ...place,
      label,
      address: trimmed,
    } satisfies ResolvedPlace
  }

  return {
    ...place,
    label,
    address: trimmed,
  } satisfies ResolvedPlace
}

async function fetchMontrealStreetRows(descriptor: StreetDescriptor) {
  const rows: MontrealCivicRecord[] = []
  let offset = 0
  let total = Number.POSITIVE_INFINITY

  while (offset < total && offset < MONTREAL_CIVIC_MAX_ROWS) {
    const url = new URL(MONTREAL_CIVIC_API_URL)
    url.searchParams.set('resource_id', MONTREAL_CIVIC_RESOURCE_ID)
    url.searchParams.set('limit', String(MONTREAL_CIVIC_PAGE_SIZE))
    url.searchParams.set('offset', String(offset))
    url.searchParams.set(
      'filters',
      JSON.stringify({
        SPECIFIQUE: descriptor.specific,
        GENERIQUE: descriptor.generic,
      }),
    )

    const response = await fetch(url, {
      headers: {
        'user-agent': 'TransitAtlas/1.0',
      },
      signal: AbortSignal.timeout(3000),
    })

    if (!response.ok) {
      throw new Error(`Données Québec a répondu ${response.status}`)
    }

    const payload = (await response.json()) as MontrealCivicResponse
    const result = payload.result
    const pageRows = result?.records ?? []
    total = result?.total ?? pageRows.length
    rows.push(...pageRows)

    if (pageRows.length < MONTREAL_CIVIC_PAGE_SIZE) {
      break
    }

    offset += MONTREAL_CIVIC_PAGE_SIZE
  }

  return rows
}

function buildStreetDescriptors(query: string, seedPlaces: ResolvedPlace[]) {
  const seeds = [
    ...seedPlaces.slice(0, 3).flatMap((place) => [place.label, place.address]),
    query,
  ]
  const descriptors = new Map<string, StreetDescriptor>()

  for (const seed of seeds) {
    const descriptor = parseStreetDescriptor(seed)
    if (!descriptor) {
      continue
    }

    descriptors.set(
      `${descriptor.generic}:${descriptor.specific}:${descriptor.orientation ?? 'X'}`,
      descriptor,
    )
  }

  return Array.from(descriptors.values())
}

function parseStreetDescriptor(value: string) {
  const firstPart = value
    .split(',')[0]
    .replace(/\s+/g, ' ')
    .replace(/^\d+[A-Za-z]?(?:-\d+[A-Za-z]?)?\s+/u, '')
    .trim()

  if (!firstPart) {
    return null
  }

  const tokens = firstPart.split(/\s+/).filter(Boolean)
  const generic = canonicalStreetType(tokens[0])
  if (!generic) {
    return null
  }

  const remainder = [...tokens.slice(1)]
  const orientation = remainder.length > 0 ? canonicalOrientation(remainder.at(-1) ?? '') : null
  if (orientation) {
    remainder.pop()
  }

  while (remainder.length > 0 && STREET_LINK_WORDS.has(normalizeLooseText(remainder[0]))) {
    remainder.shift()
  }

  const specific = remainder.join(' ').trim()
  if (!specific) {
    return null
  }

  const normalizedStreet = normalizeLooseText(
    `${generic} ${specific} ${orientation && orientation !== 'X' ? orientation : ''}`,
  )

  return {
    generic,
    specific,
    orientation,
    normalizedStreet,
  } satisfies StreetDescriptor
}

function canonicalStreetType(value: string) {
  return STREET_TYPE_ALIASES.get(normalizeLooseText(value).replace(/\./g, '')) ?? null
}

function canonicalOrientation(value: string) {
  return ORIENTATION_ALIASES.get(normalizeLooseText(value)) ?? null
}

function parseStreetNumber(value: string) {
  const digits = extractStreetNumber(value)
  return digits ? Number.parseInt(digits, 10) : null
}

function parseCivicRange(minValue?: string, maxValue?: string) {
  const min = parseStreetNumber(minValue ?? '')
  const max = parseStreetNumber(maxValue ?? '')

  if (!min && !max) {
    return null
  }

  const safeMin = min ?? max ?? 0
  const safeMax = max ?? min ?? safeMin

  return {
    min: Math.min(safeMin, safeMax),
    max: Math.max(safeMin, safeMax),
  }
}

function toMontrealCivicPlace(
  houseNumber: number,
  candidate: {
    descriptor: StreetDescriptor
    row: MontrealCivicRecord
    distanceToRange: number
    exact: boolean
  },
) {
  const label = `${houseNumber} ${formatStreetName(candidate.row)}`.replace(/\s+/g, ' ').trim()
  const address = candidate.exact
    ? `${label}, Montréal, Québec, Canada`
    : `${label}, Montréal, Québec, Canada • adresse approchée`

  return {
    id: `mtl-civic:${candidate.row.ID_ADRESSE ?? label}`,
    label,
    address,
    placeType: 'address',
    relevance: candidate.exact ? 0.99 : Math.max(0.72, 0.9 - candidate.distanceToRange / 1000),
    lon: Number.parseFloat(candidate.row.LONGITUDE || ''),
    lat: Number.parseFloat(candidate.row.LATITUDE || ''),
  } satisfies ResolvedPlace
}

function formatStreetName(row: MontrealCivicRecord) {
  const parts = [
    row.GENERIQUE ? capitalizeStreetPart(row.GENERIQUE) : '',
    row.LIEN && row.LIEN !== 'X' ? row.LIEN.toLowerCase() : '',
    row.SPECIFIQUE ?? '',
    row.ORIENTATION && row.ORIENTATION !== 'X' ? row.ORIENTATION : '',
  ].filter(Boolean)

  return parts.join(' ')
}

function capitalizeStreetPart(value: string) {
  if (!value) {
    return value
  }

  return value.charAt(0).toUpperCase() + value.slice(1)
}

function containsStreetNumber(value: string) {
  return /\b\d{1,6}\b/.test(value)
}

function extractStreetNumber(value: string) {
  return value.match(/\b\d{1,6}\b/u)?.[0] ?? null
}
