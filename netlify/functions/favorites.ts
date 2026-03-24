import { getStore } from '@netlify/blobs'
import type { Config, Handler } from '@netlify/functions'
import { errorResponse, jsonResponse } from './lib/http.ts'
import type { FavoriteItem, FavoritesResponse } from '../../src/shared/types.ts'

const inMemoryFavorites = new Map<string, FavoriteItem[]>()

export const config: Config = {
  path: '/api/favorites',
  method: ['GET', 'PUT'],
}

export const handler: Handler = async (event, context) => {
  const user = context.clientContext?.user
  const userId = user?.sub
  const email = typeof user?.email === 'string' ? user.email : null

  if (!userId) {
    return errorResponse('Authentification requise.', 401)
  }

  if (event.httpMethod === 'GET') {
    const favorites = await readFavorites(userId)
    return jsonResponse({
      favorites,
      user: {
        id: userId,
        email,
      },
    } satisfies FavoritesResponse)
  }

  if (event.httpMethod === 'PUT') {
    const body = event.body ? JSON.parse(event.body) : {}
    const favorites = Array.isArray(body?.favorites)
      ? sanitizeFavorites(body.favorites)
      : []

    await writeFavorites(userId, favorites)

    return jsonResponse({
      favorites,
      user: {
        id: userId,
        email,
      },
    } satisfies FavoritesResponse)
  }

  return errorResponse('Méthode non autorisée.', 405)
}

async function readFavorites(userId: string) {
  try {
    const store = getStore('favorites')
    return (
      ((await store.get(userId, { type: 'json' })) as FavoriteItem[] | null) ?? []
    )
  } catch {
    return inMemoryFavorites.get(userId) ?? []
  }
}

async function writeFavorites(userId: string, favorites: FavoriteItem[]) {
  try {
    const store = getStore('favorites')
    await store.setJSON(userId, favorites)
    return
  } catch {
    inMemoryFavorites.set(userId, favorites)
  }
}

function sanitizeFavorites(input: unknown[]) {
  const deduped = new Map<string, FavoriteItem>()

  for (const value of input) {
    if (!value || typeof value !== 'object') {
      continue
    }

    const favorite = value as FavoriteItem
    const valid =
      (favorite.type === 'route' || favorite.type === 'station') &&
      (favorite.mode === 'bus' ||
        favorite.mode === 'metro' ||
        favorite.mode === 'rem') &&
      typeof favorite.id === 'string' &&
      typeof favorite.label === 'string' &&
      typeof favorite.subtitle === 'string' &&
      typeof favorite.lat === 'number' &&
      typeof favorite.lon === 'number'

    if (!valid) {
      continue
    }

    deduped.set(`${favorite.type}:${favorite.id}`, {
      ...favorite,
      pinnedToMap:
        typeof favorite.pinnedToMap === 'boolean'
          ? favorite.pinnedToMap
          : favorite.type === 'route',
    })
  }

  return Array.from(deduped.values())
    .filter((value): value is FavoriteItem => {
      return Boolean(value)
    })
    .slice(0, 64)
}
