import type { Config, Handler } from '@netlify/functions'
import { searchNetwork } from './lib/data.ts'
import { errorResponse, jsonResponse } from './lib/http.ts'

export const config: Config = {
  path: '/api/search',
  method: 'GET',
}

export const handler: Handler = async (event) => {
  const query = event.queryStringParameters?.q?.trim() ?? ''

  try {
    const results = await searchNetwork(query)
    return jsonResponse(results)
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Impossible d’effectuer la recherche.',
    )
  }
}
