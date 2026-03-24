import type { Config, Handler } from '@netlify/functions'
import { buildPlan } from './lib/trip-planner.ts'
import { errorResponse, jsonResponse } from './lib/http.ts'

type PlannerMode = 'walking' | 'transit' | 'bixi' | 'cycling'

const ALL_MODES: PlannerMode[] = ['walking', 'transit', 'cycling', 'bixi']

export const config: Config = {
  path: '/api/plan',
  method: ['GET', 'POST'],
}

export const handler: Handler = async (event) => {
  try {
    const body =
      event.httpMethod === 'POST' && event.body
        ? (JSON.parse(event.body) as Record<string, unknown>)
        : {}

    const params = event.queryStringParameters ?? {}
    const from = stringValue(body.from) ?? params.from ?? null
    const to = stringValue(body.to) ?? params.to ?? null
    const fromLat = numberValue(body.fromLat) ?? parseNumber(params.fromLat)
    const fromLon = numberValue(body.fromLon) ?? parseNumber(params.fromLon)
    const toLat = numberValue(body.toLat) ?? parseNumber(params.toLat)
    const toLon = numberValue(body.toLon) ?? parseNumber(params.toLon)
    const modes = parseModes(
      stringValue(body.modes) ??
        (Array.isArray(body.modes) ? body.modes.join(',') : null) ??
        params.modes ??
        null,
    )

    const data = await buildPlan({
      from,
      to,
      fromLat,
      fromLon,
      toLat,
      toLon,
      modes,
    })

    return jsonResponse(data)
  } catch (error) {
    return errorResponse(
      error instanceof Error
        ? error.message
        : 'Impossible de calculer cet itinéraire.',
    )
  }
}

function parseModes(value: string | null) {
  if (!value) {
    return [...ALL_MODES]
  }

  const modes = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry): entry is PlannerMode => ALL_MODES.includes(entry as PlannerMode))

  return modes.length > 0 ? modes : [...ALL_MODES]
}

function parseNumber(value: string | null | undefined) {
  if (typeof value !== 'string' || value.trim() === '') {
    return null
  }

  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : null
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
