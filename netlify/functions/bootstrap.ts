import type { Config, Handler } from '@netlify/functions'
import { getBootstrapData } from './lib/data.ts'
import { errorResponse, jsonResponse } from './lib/http.ts'

export const config: Config = {
  path: '/api/bootstrap',
  method: 'GET',
}

export const handler: Handler = async () => {
  try {
    const data = await getBootstrapData()
    return jsonResponse(data)
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Impossible de charger le réseau.',
    )
  }
}
