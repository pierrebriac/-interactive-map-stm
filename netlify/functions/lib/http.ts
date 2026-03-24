import type { HandlerResponse } from '@netlify/functions'

export function jsonResponse(
  body: unknown,
  statusCode = 200,
  headers: Record<string, string> = {},
): HandlerResponse {
  return {
    statusCode,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
    body: JSON.stringify(body),
  }
}

export function errorResponse(message: string, statusCode = 500) {
  return jsonResponse({ error: message }, statusCode)
}
