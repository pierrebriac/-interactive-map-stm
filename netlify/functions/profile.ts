import { getStore } from '@netlify/blobs'
import type { Config, Handler } from '@netlify/functions'
import { errorResponse, jsonResponse } from './lib/http.ts'
import type {
  LocationPreference,
  ProfileResponse,
  SavedPlace,
  UserProfile,
} from '../../src/shared/types.ts'

const inMemoryProfiles = new Map<string, UserProfile>()

export const config: Config = {
  path: '/api/profile',
  method: ['GET', 'PUT'],
}

const DEFAULT_PROFILE: UserProfile = {
  displayName: '',
  savedPlaces: [],
  locationPreference: 'unknown',
}

export const handler: Handler = async (event, context) => {
  const user = context.clientContext?.user
  const userId = user?.sub
  const email = typeof user?.email === 'string' ? user.email : null

  if (!userId) {
    return errorResponse('Authentification requise.', 401)
  }

  if (event.httpMethod === 'GET') {
    const profile = await readProfile(userId)
    return jsonResponse({
      profile,
      user: {
        id: userId,
        email,
      },
    } satisfies ProfileResponse)
  }

  if (event.httpMethod === 'PUT') {
    const body = event.body ? JSON.parse(event.body) : {}
    const profile = sanitizeProfile(body?.profile)
    await writeProfile(userId, profile)

    return jsonResponse({
      profile,
      user: {
        id: userId,
        email,
      },
    } satisfies ProfileResponse)
  }

  return errorResponse('Méthode non autorisée.', 405)
}

async function readProfile(userId: string) {
  try {
    const store = getStore('profiles')
    const profile = (await store.get(userId, {
      type: 'json',
    })) as UserProfile | null
    return sanitizeProfile(profile)
  } catch {
    return sanitizeProfile(inMemoryProfiles.get(userId))
  }
}

async function writeProfile(userId: string, profile: UserProfile) {
  try {
    const store = getStore('profiles')
    await store.setJSON(userId, profile)
    return
  } catch {
    inMemoryProfiles.set(userId, profile)
  }
}

function sanitizeProfile(input: unknown) {
  if (!input || typeof input !== 'object') {
    return { ...DEFAULT_PROFILE }
  }

  const value = input as Partial<UserProfile>
  const displayName =
    typeof value.displayName === 'string' ? value.displayName.trim().slice(0, 80) : ''
  const locationPreference = sanitizeLocationPreference(value.locationPreference)
  const savedPlaces = Array.isArray(value.savedPlaces)
    ? sanitizeSavedPlaces(value.savedPlaces)
    : []

  return {
    displayName,
    savedPlaces,
    locationPreference,
  } satisfies UserProfile
}

function sanitizeSavedPlaces(input: unknown[]) {
  const home = new Map<string, SavedPlace>()
  const work = new Map<string, SavedPlace>()
  const saved = new Map<string, SavedPlace>()

  for (const entry of input) {
    if (!entry || typeof entry !== 'object') {
      continue
    }

    const place = entry as SavedPlace
    const kind = sanitizeSavedPlaceKind(place.kind)
    if (!kind) {
      continue
    }

    const lat = Number(place.lat)
    const lon = Number(place.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      continue
    }

    const sanitized = {
      id: typeof place.id === 'string' ? place.id : `saved:${lat}:${lon}`,
      kind,
      name:
        typeof place.name === 'string' && place.name.trim()
          ? place.name.trim().slice(0, 60)
          : kind === 'home'
            ? 'Domicile'
            : kind === 'work'
              ? 'Travail'
              : 'Adresse enregistrée',
      label:
        typeof place.label === 'string' && place.label.trim()
          ? place.label.trim().slice(0, 120)
          : typeof place.address === 'string' && place.address.trim()
            ? place.address.trim().slice(0, 120)
            : 'Adresse',
      address:
        typeof place.address === 'string' && place.address.trim()
          ? place.address.trim().slice(0, 180)
          : typeof place.label === 'string'
            ? place.label.trim().slice(0, 180)
            : 'Adresse',
      placeType:
        typeof place.placeType === 'string' && place.placeType.trim()
          ? place.placeType.trim().slice(0, 40)
          : 'place',
      relevance:
        typeof place.relevance === 'number' && Number.isFinite(place.relevance)
          ? place.relevance
          : 1,
      lat,
      lon,
    } satisfies SavedPlace

    const key =
      kind === 'saved'
        ? `${sanitized.id}:${sanitized.address}`
        : kind

    if (kind === 'home') {
      home.set(key, sanitized)
      continue
    }

    if (kind === 'work') {
      work.set(key, sanitized)
      continue
    }

    saved.set(key, sanitized)
  }

  return [
    ...home.values(),
    ...work.values(),
    ...Array.from(saved.values()).slice(0, 8),
  ]
}

function sanitizeSavedPlaceKind(value: unknown) {
  return value === 'home' || value === 'work' || value === 'saved' ? value : null
}

function sanitizeLocationPreference(value: unknown): LocationPreference {
  return value === 'granted' ||
    value === 'denied' ||
    value === 'prompt-dismissed'
    ? value
    : 'unknown'
}
