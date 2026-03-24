import type { BixiAlert, BixiResponse, BixiStation } from '../../../src/shared/types.ts'

const DEFAULT_BIXI_GBFS_URL = 'https://gbfs.velobixi.com/gbfs/gbfs.json'
const DEFAULT_CACHE_TTL_MS = 1000 * 15

interface BixiCacheEntry {
  expiresAt: number
  value: BixiResponse
}

interface GbfsIndex {
  last_updated?: number
  ttl?: number
  data?: Record<
    string,
    {
      feeds?: Array<{
        name?: string
        url?: string
      }>
    }
  >
}

interface StationInformationFeed {
  last_updated?: number
  ttl?: number
  data?: {
    stations?: Array<{
      station_id?: string
      name?: string
      lat?: number
      lon?: number
      capacity?: number
    }>
  }
}

interface StationStatusFeed {
  last_updated?: number
  ttl?: number
  data?: {
    stations?: Array<{
      station_id?: string
      num_bikes_available?: number
      num_ebikes_available?: number
      num_docks_available?: number
      is_installed?: number
      is_renting?: number
      is_returning?: number
      last_reported?: number
    }>
  }
}

interface SystemAlertsFeed {
  data?: {
    alerts?: Array<{
      alert_id?: string
      summary?: string
      description?: string
      url?: string
      start?: number
      end?: number
    }>
  }
}

let bixiCache: BixiCacheEntry | undefined
let bixiPromise: Promise<BixiResponse> | undefined

export async function getBixiData({
  availableOnly = false,
}: {
  availableOnly?: boolean
} = {}) {
  const snapshot = await getBixiSnapshot()
  if (!availableOnly) {
    return snapshot
  }

  return {
    ...snapshot,
    stations: snapshot.stations.filter(
      (station) =>
        station.isInstalled &&
        (station.bikesAvailable > 0 || station.docksAvailable > 0),
    ),
  } satisfies BixiResponse
}

async function getBixiSnapshot() {
  if (bixiCache && Date.now() < bixiCache.expiresAt) {
    return bixiCache.value
  }

  if (bixiPromise) {
    return bixiPromise
  }

  bixiPromise = buildBixiSnapshot()
    .then((value) => {
      const ttlMs = deriveTtlMs(value.sourceTimestamp)
      bixiCache = {
        expiresAt: Date.now() + ttlMs,
        value,
      }
      bixiPromise = undefined
      return value
    })
    .catch((error) => {
      bixiPromise = undefined
      if (bixiCache) {
        return {
          ...bixiCache.value,
          stale: true,
          warnings: [
            ...bixiCache.value.warnings,
            `BIXI fallback stale: ${stringifyError(error)}`,
          ],
        }
      }

      return {
        generatedAt: new Date().toISOString(),
        sourceTimestamp: new Date().toISOString(),
        stations: [],
        alerts: [],
        stale: true,
        warnings: [`BIXI unavailable: ${stringifyError(error)}`],
      } satisfies BixiResponse
    })

  return bixiPromise
}

async function buildBixiSnapshot() {
  const gbfsUrl = process.env.BIXI_GBFS_URL || DEFAULT_BIXI_GBFS_URL
  const index = await fetchJson<GbfsIndex>(gbfsUrl)
  const languageBucket = index.data?.fr ?? index.data?.en
  const feeds = new Map(
    (languageBucket?.feeds ?? [])
      .filter(
        (feed): feed is { name: string; url: string } =>
          typeof feed?.name === 'string' && typeof feed?.url === 'string',
      )
      .map((feed) => [feed.name, feed.url] as const),
  )

  const stationInformationUrl = feeds.get('station_information')
  const stationStatusUrl = feeds.get('station_status')
  const systemAlertsUrl = feeds.get('system_alerts')

  if (!stationInformationUrl || !stationStatusUrl) {
    throw new Error('BIXI GBFS feeds station_information/station_status missing.')
  }

  const [informationFeed, statusFeed, alertsFeed] = await Promise.all([
    fetchJson<StationInformationFeed>(stationInformationUrl),
    fetchJson<StationStatusFeed>(stationStatusUrl),
    systemAlertsUrl
      ? fetchJson<SystemAlertsFeed>(systemAlertsUrl)
      : Promise.resolve({ data: { alerts: [] } }),
  ])

  const statusById = new Map(
    (statusFeed.data?.stations ?? [])
      .filter((station): station is NonNullable<typeof station> & { station_id: string } =>
        typeof station?.station_id === 'string',
      )
      .map((station) => [station.station_id, station] as const),
  )

  const stations = (informationFeed.data?.stations ?? [])
    .filter(
      (station): station is NonNullable<typeof station> & {
        station_id: string
        name: string
        lat: number
        lon: number
      } =>
        typeof station?.station_id === 'string' &&
        typeof station?.name === 'string' &&
        typeof station?.lat === 'number' &&
        typeof station?.lon === 'number',
    )
    .map<BixiStation>((station) => {
      const status = statusById.get(station.station_id)
      const bikesAvailable = status?.num_bikes_available ?? 0
      const ebikesAvailable = status?.num_ebikes_available ?? 0
      const docksAvailable = status?.num_docks_available ?? 0

      return {
        id: station.station_id,
        name: station.name,
        lat: station.lat,
        lon: station.lon,
        capacity: station.capacity ?? bikesAvailable + docksAvailable,
        bikesAvailable,
        ebikesAvailable,
        docksAvailable,
        isInstalled: status?.is_installed !== 0,
        isRenting: status?.is_renting !== 0,
        isReturning: status?.is_returning !== 0,
        lastReportedAt: status?.last_reported
          ? new Date(status.last_reported * 1000).toISOString()
          : null,
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name, 'fr'))

  const alerts = (alertsFeed.data?.alerts ?? []).map<BixiAlert>((alert, index) => ({
    id: alert.alert_id || `bixi-alert-${index}`,
    title: alert.summary || 'Alerte BIXI',
    description: alert.description || '',
    url: alert.url || null,
    startAt: alert.start ? new Date(alert.start * 1000).toISOString() : null,
    endAt: alert.end ? new Date(alert.end * 1000).toISOString() : null,
  }))

  const feedUpdatedAt = Math.max(
    informationFeed.last_updated ?? 0,
    statusFeed.last_updated ?? 0,
    index.last_updated ?? 0,
  )

  return {
    generatedAt: new Date().toISOString(),
    sourceTimestamp: feedUpdatedAt
      ? new Date(feedUpdatedAt * 1000).toISOString()
      : new Date().toISOString(),
    stations,
    alerts,
    stale: false,
    warnings: [],
  } satisfies BixiResponse
}

async function fetchJson<T>(url: string) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`)
  }

  return (await response.json()) as T
}

function deriveTtlMs(sourceTimestamp: string) {
  const ageMs = Math.max(0, Date.now() - new Date(sourceTimestamp).getTime())
  const ttlMs = DEFAULT_CACHE_TTL_MS - Math.min(ageMs / 2, 5000)
  return Math.max(3000, Math.round(ttlMs))
}

function stringifyError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
