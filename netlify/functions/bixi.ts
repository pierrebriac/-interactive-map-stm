import type { Config, Handler } from '@netlify/functions'
import { getBixiData } from './lib/bixi.ts'
import { errorResponse, jsonResponse } from './lib/http.ts'

export const config: Config = {
  path: '/api/bixi',
  method: 'GET',
}

export const handler: Handler = async (event) => {
  try {
    const data = await getBixiData({
      availableOnly:
        event.queryStringParameters?.availableOnly === '1' ||
        event.queryStringParameters?.availableOnly === 'true',
    })

    return jsonResponse(data)
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Impossible de charger BIXI.',
    )
  }
}
