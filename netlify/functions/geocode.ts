import type { Config, Handler } from '@netlify/functions'
import { geocodePlaces } from './lib/places.ts'
import { errorResponse, jsonResponse } from './lib/http.ts'

export const config: Config = {
  path: '/api/geocode',
  method: 'GET',
}

export const handler: Handler = async (event) => {
  const query = event.queryStringParameters?.q?.trim() ?? ''
  const limit = Number.parseInt(event.queryStringParameters?.limit ?? '6', 10)

  try {
    const data = await geocodePlaces(query, Number.isFinite(limit) ? limit : 6)
    return jsonResponse(data)
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Impossible de géocoder cette adresse.',
    )
  }
}
