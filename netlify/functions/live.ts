import type { Config, Handler } from '@netlify/functions'
import { getLiveData } from './lib/data.ts'
import { errorResponse, jsonResponse } from './lib/http.ts'
import type { TransportMode } from '../../src/shared/types.ts'

const ALL_MODES: TransportMode[] = ['bus', 'metro', 'rem']

export const config: Config = {
  path: '/api/live',
}

export const handler: Handler = async (event) => {
  const modesParam = event.queryStringParameters?.modes
  const routeIds = (event.queryStringParameters?.routeIds ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const modes = modesParam
    ? modesParam
        .split(',')
        .map((value) => value.trim())
        .filter((value): value is TransportMode =>
          ALL_MODES.includes(value as TransportMode),
        )
    : ALL_MODES

  try {
    const data = await getLiveData({
      modes: modes.length > 0 ? modes : ALL_MODES,
      routeIds,
      stationId: event.queryStringParameters?.stationId ?? null,
    })

    return jsonResponse(data)
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Impossible de charger les données live.',
    )
  }
}
