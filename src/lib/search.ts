import type { SearchItem } from '../shared/types.ts'

function normalizeText(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
}

function compact(value: string) {
  return normalizeText(value).replace(/\s+/g, '')
}

function detectModeHint(query: string) {
  if (/\b(bus|autobus)\b/.test(query)) {
    return 'bus' as const
  }

  if (/\b(metro|ligne|subway)\b/.test(query)) {
    return 'metro' as const
  }

  if (/\b(rem|a[12])\b/.test(query)) {
    return 'rem' as const
  }

  return null
}

function numericCandidate(query: string) {
  const match = query.match(/\b([a-z]?\d+[a-z]?|a[12])\b/i)
  return match ? compact(match[1]) : ''
}

function scoreSearchItem(item: SearchItem, normalizedQuery: string) {
  const normalizedLabel = normalizeText(item.label)
  const normalizedSubtitle = normalizeText(item.subtitle)
  const compactLabel = compact(item.label)
  const compactQuery = compact(normalizedQuery)
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean)
  const modeHint = detectModeHint(normalizedQuery)
  const routeToken = numericCandidate(normalizedQuery)

  let score = 0

  if (modeHint) {
    score += item.mode === modeHint ? 24 : -16
  }

  if (item.type === 'route' && routeToken) {
    if (compactLabel === routeToken) {
      score += 220
    } else if (compactLabel.startsWith(routeToken)) {
      score += 140
    }
  }

  if (normalizedLabel === normalizedQuery) {
    score += 200
  } else if (compactLabel === compactQuery) {
    score += 180
  } else if (normalizedLabel.startsWith(normalizedQuery)) {
    score += 150
  } else if (normalizedLabel.includes(normalizedQuery)) {
    score += 120
  }

  if (normalizedSubtitle.startsWith(normalizedQuery)) {
    score += 90
  } else if (normalizedSubtitle.includes(normalizedQuery)) {
    score += 50
  }

  for (const token of tokens) {
    if (normalizedLabel.includes(token)) {
      score += 18
    }

    if (normalizedSubtitle.includes(token)) {
      score += 9
    }
  }

  if (item.type === 'station') {
    score += 8
  }

  return score
}

export function searchItems(
  items: SearchItem[],
  query: string,
  {
    limit = 12,
    types,
  }: {
    limit?: number
    types?: SearchItem['type'][]
  } = {},
) {
  const normalizedQuery = normalizeText(query)
  if (!normalizedQuery) {
    return []
  }

  return items
    .filter((item) => (types ? types.includes(item.type) : true))
    .map((item) => ({ item, score: scoreSearchItem(item, normalizedQuery) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score
      }

      if (left.item.type !== right.item.type) {
        return left.item.type === 'route' ? -1 : 1
      }

      return left.item.label.localeCompare(right.item.label, 'fr', {
        numeric: true,
      })
    })
    .slice(0, limit)
    .map((entry) => entry.item)
}

export function normalizeSearchText(value: string) {
  return normalizeText(value)
}
