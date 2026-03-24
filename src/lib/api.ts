import type {
  BootstrapResponse,
  FavoriteItem,
  FavoritesResponse,
  LiveResponse,
  SearchItem,
  TransportMode,
} from '../shared/types.ts'

async function apiRequest<T>(input: string, init?: RequestInit) {
  const response = await fetch(input, init)
  const payload = await response.json().catch(() => null)

  if (!response.ok) {
    const message =
      payload && typeof payload.error === 'string'
        ? payload.error
        : 'La requête API a échoué.'
    throw new Error(message)
  }

  return payload as T
}

export function fetchBootstrap() {
  return apiRequest<BootstrapResponse>('/api/bootstrap')
}

export function fetchLiveData({
  modes,
  routeId,
  stationId,
}: {
  modes: TransportMode[]
  routeId?: string | null
  stationId?: string | null
}) {
  const searchParams = new URLSearchParams()
  searchParams.set('modes', modes.join(','))

  if (routeId) {
    searchParams.set('routeId', routeId)
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
