import { haversineKm } from '../../../src/shared/geo.ts'
import type {
  GeoPoint,
  GeocodeResponse,
  ResolvedPlace,
} from '../../../src/shared/types.ts'

const MONTREAL_BBOX = [-74.15, 45.35, -73.35, 45.75] as const
const MONTREAL_PROXIMITY = [-73.5673, 45.5017] as const

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

export interface RoutedSurface {
  geometry: [number, number][]
  distanceKm: number
  durationMin: number
  provider: 'openrouteservice' | 'estimated'
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

  const mapTilerKey = getMapTilerKey()
  const url = new URL(
    `https://api.maptiler.com/geocoding/${encodeURIComponent(trimmed)}.json`,
  )
  url.searchParams.set('key', mapTilerKey)
  url.searchParams.set('language', 'fr')
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 10)))
  url.searchParams.set('bbox', MONTREAL_BBOX.join(','))
  url.searchParams.set('proximity', MONTREAL_PROXIMITY.join(','))
  url.searchParams.set('country', 'ca')
  url.searchParams.set('autocomplete', 'true')

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`MapTiler geocoding returned ${response.status}`)
  }

  const payload = (await response.json()) as MapTilerGeocodeResponse
  const features = (payload.features ?? [])
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

  return {
    generatedAt: new Date().toISOString(),
    query: trimmed,
    features,
    warnings: [],
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

  return bestMatch
}

export async function routeSurfacePath(
  from: GeoPoint,
  to: GeoPoint,
  profile: 'walking' | 'cycling',
) {
  const orsKey = process.env.ORS_API_KEY
  if (!orsKey) {
    return estimateSurfacePath(from, to, profile)
  }

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

  if (!response.ok) {
    const fallback = estimateSurfacePath(from, to, profile)
    fallback.warnings.push(
      `OpenRouteService returned ${response.status}; fallback estimation used.`,
    )
    return fallback
  }

  const payload = (await response.json()) as OrsFeatureCollection
  const feature = payload.features?.[0]
  const coordinates = feature?.geometry?.coordinates
  const distanceMeters = feature?.properties?.summary?.distance
  const durationSeconds = feature?.properties?.summary?.duration

  if (!coordinates || typeof distanceMeters !== 'number' || typeof durationSeconds !== 'number') {
    const fallback = estimateSurfacePath(from, to, profile)
    fallback.warnings.push('OpenRouteService response incomplete; fallback estimation used.')
    return fallback
  }

  return {
    geometry: coordinates,
    distanceKm: distanceMeters / 1000,
    durationMin: durationSeconds / 60,
    provider: 'openrouteservice',
    warnings: [] as string[],
  } satisfies RoutedSurface
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
