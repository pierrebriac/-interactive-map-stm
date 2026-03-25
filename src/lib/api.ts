import type {
  BootstrapResponse,
  FavoriteItem,
  FavoritesResponse,
  GeocodeResponse,
  LiveResponse,
  PlanResponse,
  ProfileResponse,
  SearchItem,
  TransportMode,
  ItineraryMode,
  UserProfile,
} from '../shared/types.ts'

async function apiRequest<T>(input: string, init?: RequestInit) {
  const response = await fetch(input, init)
  const rawText = await response.text()
  const contentType = response.headers.get('content-type') ?? ''
  let payload: unknown = null

  if (rawText) {
    try {
      payload = JSON.parse(rawText)
    } catch {
      payload = null
    }
  }

  if (!response.ok) {
    const message = formatApiErrorMessage(payload, rawText, response.status)
    throw new Error(message)
  }

  if (
    typeof input === 'string' &&
    input.startsWith('/api/') &&
    payload === null &&
    contentType.includes('text/html')
  ) {
    throw new Error('Réponse API invalide. Le déploiement Netlify ne route pas correctement cette requête.')
  }

  return payload as T
}

function formatApiErrorMessage(payload: unknown, rawText: string, status: number) {
  if (payload && typeof payload === 'object') {
    if ('error' in payload && typeof payload.error === 'string') {
      return payload.error
    }

    if (
      'errorType' in payload &&
      payload.errorType === 'Runtime.OutOfMemory'
    ) {
      return 'Le serveur a manqué de mémoire pendant cette requête. Réessaie dans un instant.'
    }

    if ('errorMessage' in payload && typeof payload.errorMessage === 'string') {
      return payload.errorMessage
    }
  }

  return rawText.trim() || `Erreur API (${status}).`
}

export function fetchBootstrap() {
  return apiRequest<BootstrapResponse>('/api/bootstrap')
}

export function fetchLiveData({
  modes,
  routeIds,
  stationId,
}: {
  modes: TransportMode[]
  routeIds?: string[]
  stationId?: string | null
}) {
  const searchParams = new URLSearchParams()
  searchParams.set('modes', modes.join(','))

  if (routeIds && routeIds.length > 0) {
    searchParams.set('routeIds', routeIds.join(','))
  }

  if (stationId) {
    searchParams.set('stationId', stationId)
  }

  return apiRequest<LiveResponse>(`/api/live?${searchParams.toString()}`)
}

export function fetchSearchResults(query: string) {
  return apiRequest<SearchItem[]>(
    `/api/search?q=${encodeURIComponent(query.trim())}`,
  )
}

export function fetchFavorites(token: string) {
  return apiRequest<FavoritesResponse>('/api/favorites', {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })
}

export function saveFavorites(token: string, favorites: FavoriteItem[]) {
  return apiRequest<FavoritesResponse>('/api/favorites', {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ favorites }),
  })
}

export function fetchGeocode(query: string, limit = 6) {
  const searchParams = new URLSearchParams()
  searchParams.set('q', query.trim())
  searchParams.set('limit', String(limit))

  return apiRequest<GeocodeResponse>(`/api/geocode?${searchParams.toString()}`)
}

export function fetchProfile(token: string) {
  return apiRequest<ProfileResponse>('/api/profile', {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })
}

export function saveProfile(token: string, profile: UserProfile) {
  return apiRequest<ProfileResponse>('/api/profile', {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ profile }),
  })
}

export function fetchPlan(input: {
  from?: string
  to?: string
  fromLat?: number
  fromLon?: number
  toLat?: number
  toLon?: number
  modes: ItineraryMode[]
}) {
  return apiRequest<PlanResponse>('/api/plan', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  })
}
