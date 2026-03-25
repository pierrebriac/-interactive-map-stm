import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cheerio from 'cheerio'
import gtfsRealtimeBindings from 'gtfs-realtime-bindings'
import JSZip from 'jszip'
import Papa from 'papaparse'
import {
  computeBounds,
  cumulativePolylineDistances,
  haversineKm,
  interpolateAlongPolyline,
  pointToPolylineDistanceKm,
  polylineLengthKm,
  projectPointToPolyline,
  slicePolylineAlongDistances,
  simplifyCoordinates,
} from '../../../src/shared/geo.ts'
import type {
  BootstrapResponse,
  LiveEntity,
  LiveResponse,
  MapStyleOption,
  RouteSummary,
  SearchItem,
  ServiceState,
  ServiceStatus,
  ShapeFeature,
  StationSummary,
  TransportMode,
} from '../../../src/shared/types.ts'

const STATION_PROXIMITY_KM: Record<'metro' | 'rem', number> = {
  metro: 0.45,
  rem: 0.55,
}

const STM_GTFS_URL = 'https://www.stm.info/sites/default/files/gtfs/gtfs_stm.zip'
const STM_STATUS_URL = 'https://www.stm.info/fr/ajax/etats-du-service'
const REM_GTFS_URL = 'https://gtfs.gpmmom.ca/gtfs/gtfs.zip'
const REM_STATUS_URL = 'https://rem.info/fr/se-deplacer/etat-du-service'

const STATIC_CACHE_TTL_MS = 1000 * 60 * 60 * 6
const LIVE_CACHE_TTL_MS = 1000 * 8
const TRANSFER_GRID_DEGREES = 0.0032

interface CsvRow {
  [key: string]: string
}

export interface TransitStopSummary {
  id: string
  mode: TransportMode
  name: string
  lat: number
  lon: number
  routeIds: string[]
}

export interface TransitEdgeSummary {
  from: string
  to: string
  kind: 'ride' | 'walk'
  mode: TransportMode | 'walking'
  routeId?: string
  distanceKm: number
  durationMin: number
  geometry: [number, number][]
}

interface InternalShape extends ShapeFeature {
  fullCoordinates: [number, number][]
  distances: number[]
  lengthKm: number
}

interface RemTripEstimate {
  tripId: string
  routeId: string
  shapeId: string
  serviceId: string
  directionId: string
  headsign: string
  departureTime: number
  arrivalTime: number
  checkpoints: Array<{
    time: number
    distanceKm: number
  }>
}

interface InternalModel {
  bootstrap: BootstrapResponse
  routesById: Map<string, RouteSummary>
  stationsById: Map<string, StationSummary>
  shapesById: Map<string, InternalShape>
  transitStopsById: Map<string, TransitStopSummary>
  transitEdges: TransitEdgeSummary[]
  remTrips: RemTripEstimate[]
  remCalendars: CsvRow[]
  remCalendarDates: CsvRow[]
}

interface SerializedModel {
  bootstrap: BootstrapResponse
  routes: RouteSummary[]
  stations: StationSummary[]
  shapes: InternalShape[]
  transitStops: TransitStopSummary[]
  transitEdges: TransitEdgeSummary[]
  remTrips: RemTripEstimate[]
  remCalendars: CsvRow[]
  remCalendarDates: CsvRow[]
}

interface LiveSnapshot {
  createdAt: string
  entities: LiveEntity[]
  serviceStates: ServiceState[]
  warnings: string[]
}

let staticModelCache:
  | {
      expiresAt: number
      value: InternalModel
    }
  | undefined
let staticModelPromise: Promise<InternalModel> | undefined

let liveSnapshotCache:
  | {
      expiresAt: number
      value: LiveSnapshot
    }
  | undefined
let liveSnapshotPromise: Promise<LiveSnapshot> | undefined

const fallbackLiveSnapshot: LiveSnapshot = {
  createdAt: new Date(0).toISOString(),
  entities: [],
  serviceStates: [],
  warnings: [],
}

const PROJECT_ROOT = process.cwd()
const MODULE_DIRECTORY =
  typeof __dirname === 'string'
    ? __dirname
    : dirname(fileURLToPath(import.meta.url))
const SNAPSHOT_PATHS = Array.from(
  new Set([
    resolve(PROJECT_ROOT, 'generated/network-model.json'),
    resolve(MODULE_DIRECTORY, '../../../generated/network-model.json'),
    resolve(MODULE_DIRECTORY, '../../../../generated/network-model.json'),
  ]),
)
const PRIMARY_SNAPSHOT_PATH = SNAPSHOT_PATHS[0]

export async function getBootstrapData() {
  const model = await getInternalModel()
  model.bootstrap.styles = getStyleOptions()
  return model.bootstrap
}

export async function getTransitPlanningData() {
  const model = await getInternalModel()
  return {
    routesById: model.routesById,
    transitStopsById: model.transitStopsById,
    transitEdges: model.transitEdges,
  }
}

export async function prepareModelSnapshot(snapshotPath = PRIMARY_SNAPSHOT_PATH) {
  const model = await buildStaticModel()
  const serialized = serializeModel(model)

  await mkdir(dirname(snapshotPath), { recursive: true })
  await writeFile(snapshotPath, JSON.stringify(serialized))

  staticModelCache = {
    expiresAt: Date.now() + STATIC_CACHE_TTL_MS,
    value: model,
  }

  return snapshotPath
}

export async function searchNetwork(query: string) {
  const normalized = normalizeText(query)
  if (!normalized) {
    return []
  }

  const { bootstrap } = await getInternalModel()
  const matches = bootstrap.searchIndex
    .map((item) => {
      const label = normalizeText(item.label)
      const subtitle = normalizeText(item.subtitle)
      const haystack = `${label} ${subtitle}`.trim()
      const labelStartsWith = label.startsWith(normalized)
      const subtitleStartsWith = subtitle.startsWith(normalized)
      const includes = haystack.includes(normalized)

      let score = 999
      if (includes) {
        score = 3
      }

      if (subtitleStartsWith) {
        score = 1
      }

      if (labelStartsWith) {
        score = 0
      }

      if (label === normalized) {
        score = -1
      }

      return { item, score }
    })
    .filter((entry) => entry.score < 999)
    .sort((left, right) => left.score - right.score)
    .slice(0, 16)
    .map((entry) => entry.item)

  return matches
}

export async function getLiveData({
  modes,
  routeIds,
  stationId,
}: {
  modes: TransportMode[]
  routeIds?: string[]
  stationId?: string | null
}) {
  const model = await getInternalModel()
  const snapshot = await getLiveSnapshot(model)

  const effectiveModes = new Set(modes)
  const routeFilter = new Set(routeIds?.filter(Boolean) ?? [])
  const selectedStation = stationId
    ? model.stationsById.get(stationId) ?? null
    : null
  const selectedStationRoutes = new Set(selectedStation?.routeIds ?? [])
  const filteredEntities = snapshot.entities.filter((entity) => {
    if (!effectiveModes.has(entity.mode)) {
      return false
    }

    if (routeFilter.size > 0 && !routeFilter.has(entity.routeId)) {
      return false
    }

    if (!selectedStation) {
      return true
    }

    if (selectedStationRoutes.has(entity.routeId)) {
      return true
    }

    return haversineKm(
      entity.lat,
      entity.lon,
      selectedStation.lat,
      selectedStation.lon,
    ) <= 1.1
  })

  const filteredStates = snapshot.serviceStates.filter((state) => {
    if (!effectiveModes.has(state.mode)) {
      return false
    }

    if (routeFilter.size > 0) {
      return routeFilter.has(state.routeId)
    }

    if (selectedStation) {
      return selectedStationRoutes.has(state.routeId)
    }

    return state.status !== 'normal' || state.mode !== 'bus'
  })

  if (routeFilter.size > 0) {
    for (const routeId of routeFilter) {
      if (filteredStates.some((state) => state.routeId === routeId)) {
        continue
      }

      const route = model.routesById.get(routeId)
      if (!route) {
        continue
      }

      filteredStates.unshift({
        routeId,
        mode: route.mode,
        status: 'normal',
        message:
          route.mode === 'bus'
            ? 'Aucune perturbation publique signalée pour cette ligne.'
            : 'Service surveillé, sans alerte spécifique.',
        updatedAt: snapshot.createdAt,
      })
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    sourceTimestamp: snapshot.createdAt,
    entities: filteredEntities,
    serviceStates: filteredStates,
    stale:
      !liveSnapshotCache || Date.now() > liveSnapshotCache.expiresAt
        ? true
        : false,
    warnings: snapshot.warnings,
  } satisfies LiveResponse
}

async function getInternalModel(): Promise<InternalModel> {
  if (staticModelCache && Date.now() < staticModelCache.expiresAt) {
    return staticModelCache.value
  }

  if (staticModelPromise) {
    return staticModelPromise
  }

  staticModelPromise = loadSnapshotModel()
    .catch((error) => {
      if (shouldAvoidRuntimeModelBuild()) {
        throw error
      }

      return buildStaticModel()
    })
    .then((value) => {
      value.bootstrap.styles = getStyleOptions()
      staticModelCache = {
        expiresAt: Date.now() + STATIC_CACHE_TTL_MS,
        value,
      }
      staticModelPromise = undefined
      return value
    })
    .catch((error) => {
      staticModelPromise = undefined
      throw error
    })

  return staticModelPromise
}

async function loadSnapshotModel() {
  let lastError: unknown

  for (const snapshotPath of SNAPSHOT_PATHS) {
    try {
      const raw = await readFile(snapshotPath, 'utf8')
      const serialized = JSON.parse(raw) as SerializedModel
      const model = applyRuntimeBootstrapSettings(hydrateModel(serialized))
      if (model.transitStopsById.size === 0 || model.transitEdges.length === 0) {
        throw new Error('Transit planning snapshot missing enriched stop graph.')
      }

      return model
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error
    ? new Error(`Snapshot réseau introuvable: ${lastError.message}`)
    : new Error('Snapshot réseau introuvable.')
}

function shouldAvoidRuntimeModelBuild() {
  if (process.env.NETLIFY_LOCAL === 'true') {
    return false
  }

  return Boolean(process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME)
}

async function getLiveSnapshot(model: InternalModel): Promise<LiveSnapshot> {
  if (liveSnapshotCache && Date.now() < liveSnapshotCache.expiresAt) {
    return liveSnapshotCache.value
  }

  if (liveSnapshotPromise) {
    return liveSnapshotPromise
  }

  liveSnapshotPromise = buildLiveSnapshot(model)
    .then((value) => {
      liveSnapshotCache = {
        expiresAt: Date.now() + LIVE_CACHE_TTL_MS,
        value,
      }
      liveSnapshotPromise = undefined
      return value
    })
    .catch((error) => {
      liveSnapshotPromise = undefined
      if (liveSnapshotCache) {
        return {
          ...liveSnapshotCache.value,
          warnings: [
            ...liveSnapshotCache.value.warnings,
            `Dernière donnée servie après erreur live: ${stringifyError(error)}`,
          ],
        }
      }

      return {
        ...fallbackLiveSnapshot,
        createdAt: new Date().toISOString(),
        warnings: [`Aucune donnée live disponible: ${stringifyError(error)}`],
      }
    })

  return liveSnapshotPromise
}

async function buildStaticModel(): Promise<InternalModel> {
  const [stmZip, remZip] = await Promise.all([
    downloadZip(STM_GTFS_URL),
    downloadZip(REM_GTFS_URL),
  ])

  const [
    stmRoutesRows,
    stmTripsRows,
    stmShapesRows,
    stmStopsRows,
    stmStopTimesRows,
    remRoutesRows,
    remTripsRows,
    remShapesRows,
    remStopsRows,
    remStopTimesRows,
    remCalendars,
    remCalendarDates,
  ] = await Promise.all([
    readZipCsv(stmZip, 'routes.txt'),
    readZipCsv(stmZip, 'trips.txt'),
    readZipCsv(stmZip, 'shapes.txt'),
    readZipCsv(stmZip, 'stops.txt'),
    readZipCsv(stmZip, 'stop_times.txt'),
    readZipCsv(remZip, 'routes.txt'),
    readZipCsv(remZip, 'trips.txt'),
    readZipCsv(remZip, 'shapes.txt'),
    readZipCsv(remZip, 'stops.txt'),
    readZipCsv(remZip, 'stop_times.txt'),
    readZipCsv(remZip, 'calendar.txt'),
    readZipCsv(remZip, 'calendar_dates.txt'),
  ])

  const selectedShapeIds = new Set<string>()
  const routes = new Map<string, RouteSummary>()
  const routeModeById = new Map<string, TransportMode>()

  const stmShapeIdsByRoute = collectShapeIdsByRoute(
    stmTripsRows,
    stmRoutesRows,
    (mode) => (mode === 'bus' ? 2 : 4),
  )
  const remShapeIdsByRoute = collectShapeIdsByRoute(
    remTripsRows,
    remRoutesRows,
    () => 8,
  )

  for (const shapeIds of stmShapeIdsByRoute.values()) {
    for (const shapeId of shapeIds) {
      selectedShapeIds.add(shapeId)
    }
  }

  for (const shapeIds of remShapeIdsByRoute.values()) {
    for (const shapeId of shapeIds) {
      selectedShapeIds.add(shapeId)
    }
  }

  for (const row of stmRoutesRows) {
    const mode = stmModeFromRouteType(row.route_type)
    if (!mode) {
      continue
    }

    const shapeIds = stmShapeIdsByRoute.get(row.route_id) ?? []
    routes.set(row.route_id, {
      id: row.route_id,
      mode,
      shortName: row.route_short_name || row.route_id,
      longName: row.route_long_name || row.route_short_name || row.route_id,
      color: normalizeColor(row.route_color, mode),
      textColor: normalizeTextColor(row.route_text_color),
      center: [-73.58, 45.51],
      shapeIds,
      stationIds: [],
    })
    routeModeById.set(row.route_id, mode)
  }

  for (const row of remRoutesRows) {
    const shapeIds = remShapeIdsByRoute.get(row.route_id) ?? []
    routes.set(row.route_id, {
      id: row.route_id,
      mode: 'rem',
      shortName: row.route_short_name || row.route_id,
      longName: row.route_long_name || row.route_short_name || row.route_id,
      color: normalizeColor(row.route_color, 'rem'),
      textColor: normalizeTextColor(row.route_text_color),
      center: [-73.58, 45.51],
      shapeIds,
      stationIds: [],
    })
    routeModeById.set(row.route_id, 'rem')
  }

  const shapesById = buildShapeMap(
    [...stmShapesRows, ...remShapesRows],
    selectedShapeIds,
    routes,
  )

  for (const route of routes.values()) {
    const routeCoordinates = route.shapeIds.flatMap(
      (shapeId) => shapesById.get(shapeId)?.coordinates ?? [],
    )
    const routeBounds = computeBounds(routeCoordinates)

    route.center = [
      (routeBounds[0][0] + routeBounds[1][0]) / 2,
      (routeBounds[0][1] + routeBounds[1][1]) / 2,
    ]
  }

  const stations = new Map<string, StationSummary>()
  for (const station of extractMetroStations(stmStopsRows)) {
    stations.set(station.id, station)
  }

  for (const station of extractRemStations(remStopsRows)) {
    stations.set(station.id, station)
  }

  attachStationsToRoutes(stations, routes, shapesById)
  const { transitStopsById, transitEdges } = buildTransitPlanningModel({
    stations,
    routes,
    shapesById,
    stmTripsRows,
    stmStopsRows,
    stmStopTimesRows,
  })

  const searchIndex = buildSearchIndex(routes, stations)
  const bounds = computeBounds([
    ...Array.from(stations.values(), (station) => [station.lon, station.lat] as [
      number,
      number,
    ]),
    ...Array.from(routes.values(), (route) => route.center),
  ])

  const shapes = Array.from(shapesById.values()).map<ShapeFeature>((shape) => ({
    id: shape.id,
    routeId: shape.routeId,
    mode: shape.mode,
    color: shape.color,
    coordinates: shape.coordinates,
  }))

  const bootstrap: BootstrapResponse = {
    generatedAt: new Date().toISOString(),
    routes: Array.from(routes.values()).sort(sortRoutes),
    stations: Array.from(stations.values()).sort((left, right) =>
      left.name.localeCompare(right.name, 'fr'),
    ),
    shapes,
    searchIndex,
    styles: getStyleOptions(),
    warnings: [],
    bounds,
  }

  const remTrips = buildRemTrips(remTripsRows, remStopTimesRows, shapesById)

  return {
    bootstrap,
    routesById: routes,
    stationsById: stations,
    shapesById,
    transitStopsById,
    transitEdges,
    remTrips,
    remCalendars,
    remCalendarDates,
  }
}

function serializeModel(model: InternalModel): SerializedModel {
  return {
    bootstrap: model.bootstrap,
    routes: Array.from(model.routesById.values()),
    stations: Array.from(model.stationsById.values()),
    shapes: Array.from(model.shapesById.values()),
    transitStops: Array.from(model.transitStopsById.values()),
    transitEdges: model.transitEdges,
    remTrips: model.remTrips,
    remCalendars: model.remCalendars,
    remCalendarDates: model.remCalendarDates,
  }
}

function hydrateModel(serialized: SerializedModel): InternalModel {
  return {
    bootstrap: serialized.bootstrap,
    routesById: new Map(serialized.routes.map((route) => [route.id, route])),
    stationsById: new Map(
      serialized.stations.map((station) => [station.id, station]),
    ),
    shapesById: new Map(serialized.shapes.map((shape) => [shape.id, shape])),
    transitStopsById: new Map(
      (serialized.transitStops ?? []).map((stop) => [stop.id, stop]),
    ),
    transitEdges: serialized.transitEdges ?? [],
    remTrips: serialized.remTrips,
    remCalendars: serialized.remCalendars,
    remCalendarDates: serialized.remCalendarDates,
  }
}

function applyRuntimeBootstrapSettings(model: InternalModel) {
  model.bootstrap.styles = getStyleOptions()
  return model
}

async function buildLiveSnapshot(model: InternalModel): Promise<LiveSnapshot> {
  const warnings: string[] = []
  const [stmStatus, remStatus, busEntities] = await Promise.all([
    fetchStmStatus().catch((error) => {
      warnings.push(`Statut STM indisponible: ${stringifyError(error)}`)
      return null
    }),
    fetchRemStatus().catch((error) => {
      warnings.push(`Statut REM indisponible: ${stringifyError(error)}`)
      return {
        updatedAt: new Date().toISOString(),
        serviceStates: Array.from(model.routesById.values())
          .filter((route) => route.mode === 'rem')
          .map<ServiceState>((route) => ({
            routeId: route.id,
            mode: route.mode,
            status: 'unknown',
            message: 'État du service REM indisponible.',
            updatedAt: new Date().toISOString(),
          })),
        warnings: [],
      }
    }),
    fetchBusEntities(model).catch((error) => {
      warnings.push(`Bus temps réel indisponibles: ${stringifyError(error)}`)
      return []
    }),
  ])

  if (remStatus.warnings.length > 0) {
    warnings.push(...remStatus.warnings)
  }

  const metroStates = buildMetroServiceStates(model, stmStatus)
  const busStates = buildBusServiceStates(model, stmStatus)
  const remStates = remStatus.serviceStates
  const metroEntities = buildMetroEstimates(model, metroStates)
  const remEntities = buildRemEstimates(model, remStates)

  return {
    createdAt: new Date().toISOString(),
    entities: [...busEntities, ...metroEntities, ...remEntities],
    serviceStates: [...metroStates, ...remStates, ...busStates],
    warnings,
  }
}

async function downloadZip(url: string) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`)
  }

  const buffer = await response.arrayBuffer()
  return JSZip.loadAsync(buffer)
}

async function readZipCsv(zip: JSZip, fileName: string) {
  const file = zip.file(fileName)
  if (!file) {
    throw new Error(`Missing ${fileName} in GTFS archive`)
  }

  const text = (await file.async('text')).replace(/^\ufeff/, '')
  const parsed = Papa.parse<CsvRow>(text, {
    header: true,
    skipEmptyLines: true,
  })

  if (parsed.errors.length > 0) {
    throw new Error(`Failed parsing ${fileName}: ${parsed.errors[0].message}`)
  }

  return parsed.data
}

function collectShapeIdsByRoute(
  tripRows: CsvRow[],
  routeRows: CsvRow[],
  limitForMode: (mode: TransportMode) => number,
) {
  const routeModes = new Map<string, TransportMode>()
  for (const row of routeRows) {
    const mode =
      row.agency_id === 'REM' ? 'rem' : stmModeFromRouteType(row.route_type)
    if (mode) {
      routeModes.set(row.route_id, mode)
    }
  }

  const shapeCountsByRoute = new Map<string, Map<string, number>>()
  for (const row of tripRows) {
    const routeId = row.route_id
    const shapeId = row.shape_id
    if (!routeId || !shapeId) {
      continue
    }

    const bucket = shapeCountsByRoute.get(routeId) ?? new Map<string, number>()
    bucket.set(shapeId, (bucket.get(shapeId) ?? 0) + 1)
    shapeCountsByRoute.set(routeId, bucket)
  }

  const selected = new Map<string, string[]>()
  for (const [routeId, shapeCounts] of shapeCountsByRoute) {
    const mode = routeModes.get(routeId)
    if (!mode) {
      continue
    }

    const shapeIds = Array.from(shapeCounts.entries())
      .sort((left, right) => right[1] - left[1])
      .slice(0, limitForMode(mode))
      .map(([shapeId]) => shapeId)

    selected.set(routeId, shapeIds)
  }

  return selected
}

function stmModeFromRouteType(routeType: string) {
  if (routeType === '1') {
    return 'metro' as const
  }

  if (routeType === '3') {
    return 'bus' as const
  }

  return null
}

function normalizeColor(color: string, mode: TransportMode) {
  const fallback =
    mode === 'metro'
      ? '00B300'
      : mode === 'rem'
        ? '4F9D2F'
        : '009EE0'

  return `#${(color || fallback).replace('#', '')}`
}

function normalizeTextColor(color: string) {
  const value = (color || 'FFFFFF').replace('#', '')
  return `#${value}`
}

function buildShapeMap(
  shapeRows: CsvRow[],
  selectedShapeIds: Set<string>,
  routes: Map<string, RouteSummary>,
) {
  const shapePoints = new Map<
    string,
    Array<{ lon: number; lat: number; sequence: number }>
  >()

  const shapeRouteMap = new Map<string, RouteSummary>()
  for (const route of routes.values()) {
    for (const shapeId of route.shapeIds) {
      shapeRouteMap.set(shapeId, route)
    }
  }

  for (const row of shapeRows) {
    if (!selectedShapeIds.has(row.shape_id)) {
      continue
    }

    const bucket =
      shapePoints.get(row.shape_id) ??
      ([] as Array<{ lon: number; lat: number; sequence: number }>)
    bucket.push({
      lon: Number.parseFloat(row.shape_pt_lon),
      lat: Number.parseFloat(row.shape_pt_lat),
      sequence: Number.parseInt(row.shape_pt_sequence, 10),
    })
    shapePoints.set(row.shape_id, bucket)
  }

  const shapes = new Map<string, InternalShape>()

  for (const [shapeId, points] of shapePoints) {
    const route = shapeRouteMap.get(shapeId)
    if (!route) {
      continue
    }

    const ordered = points
      .sort((left, right) => left.sequence - right.sequence)
      .map<[number, number]>((point) => [point.lon, point.lat])
    const distances = cumulativePolylineDistances(ordered)
    const fullCoordinates: [number, number][] =
      ordered.length > 1
        ? ordered
        : [[route.center[0], route.center[1]] as [number, number]]

    shapes.set(shapeId, {
      id: shapeId,
      routeId: route.id,
      mode: route.mode,
      color: route.color,
      coordinates: simplifyCoordinates(
        fullCoordinates,
        route.mode === 'bus' ? 110 : 240,
      ),
      fullCoordinates,
      distances,
      lengthKm: polylineLengthKm(fullCoordinates),
    })
  }

  return shapes
}

function extractMetroStations(stopRows: CsvRow[]) {
  const stations: StationSummary[] = []

  for (const row of stopRows) {
    if (row.location_type !== '0' || !row.parent_station.startsWith('STATION_M')) {
      continue
    }

    stations.push({
      id: row.parent_station,
      mode: 'metro',
      name: tidyStationName(row.stop_name),
      lat: Number.parseFloat(row.stop_lat),
      lon: Number.parseFloat(row.stop_lon),
      routeIds: [],
    })
  }

  return stations
}

function extractRemStations(stopRows: CsvRow[]) {
  const grouped = new Map<
    string,
    { name: string; lats: number[]; lons: number[] }
  >()

  for (const row of stopRows) {
    if (row.location_type !== '0') {
      continue
    }

    const name = tidyStationName(
      row.stop_name.replace(/\s*-\s*Quai\s*\d+/i, '').trim(),
    )
    const groupId = row.parent_station || name
    const bucket =
      grouped.get(groupId) ?? {
        name,
        lats: [],
        lons: [],
      }
    bucket.lats.push(Number.parseFloat(row.stop_lat))
    bucket.lons.push(Number.parseFloat(row.stop_lon))
    grouped.set(groupId, bucket)
  }

  return Array.from(grouped.entries()).map<StationSummary>(([id, group]) => ({
    id,
    mode: 'rem',
    name: group.name,
    lat: average(group.lats),
    lon: average(group.lons),
    routeIds: [],
  }))
}

function attachStationsToRoutes(
  stations: Map<string, StationSummary>,
  routes: Map<string, RouteSummary>,
  shapesById: Map<string, InternalShape>,
) {
  for (const station of stations.values()) {
    const candidateRoutes = Array.from(routes.values()).filter(
      (route) => route.mode === station.mode,
    )
    const threshold =
      station.mode === 'metro'
        ? STATION_PROXIMITY_KM.metro
        : STATION_PROXIMITY_KM.rem
    let closestRouteId = ''
    let closestDistance = Number.POSITIVE_INFINITY

    for (const route of candidateRoutes) {
      let bestDistance = Number.POSITIVE_INFINITY

      for (const shapeId of route.shapeIds) {
        const shape = shapesById.get(shapeId)
        if (!shape) {
          continue
        }

        bestDistance = Math.min(
          bestDistance,
          pointToPolylineDistanceKm(
            [station.lon, station.lat],
            shape.fullCoordinates,
          ),
        )
      }

      if (bestDistance < closestDistance) {
        closestDistance = bestDistance
        closestRouteId = route.id
      }

      if (bestDistance <= threshold) {
        station.routeIds.push(route.id)
      }
    }

    if (station.routeIds.length === 0 && closestRouteId) {
      station.routeIds.push(closestRouteId)
    }

    station.routeIds = Array.from(new Set(station.routeIds)).sort((left, right) =>
      sortRoutes(
        routes.get(left) as RouteSummary,
        routes.get(right) as RouteSummary,
      ),
    )

    for (const routeId of station.routeIds) {
      const route = routes.get(routeId)
      if (!route) {
        continue
      }

      route.stationIds = Array.from(new Set([...route.stationIds, station.id]))
    }
  }
}

function buildSearchIndex(
  routes: Map<string, RouteSummary>,
  stations: Map<string, StationSummary>,
) {
  const routeItems = Array.from(routes.values()).map<SearchItem>((route) => ({
    type: 'route',
    id: route.id,
    mode: route.mode,
    label: route.shortName,
    subtitle:
      route.mode === 'bus'
        ? `Bus • ${route.longName}`
        : route.mode === 'metro'
          ? `Métro • ${route.longName}`
          : `REM • ${route.longName}`,
    lat: route.center[1],
    lon: route.center[0],
  }))

  const stationItems = Array.from(stations.values()).map<SearchItem>((station) => ({
    type: 'station',
    id: station.id,
    mode: station.mode,
    label: station.name,
    subtitle: station.mode === 'metro' ? 'Station de métro' : 'Station du REM',
    lat: station.lat,
    lon: station.lon,
  }))

  return [...routeItems, ...stationItems].sort((left, right) =>
    left.label.localeCompare(right.label, 'fr'),
  )
}

function buildTransitPlanningModel(input: {
  stations: Map<string, StationSummary>
  routes: Map<string, RouteSummary>
  shapesById: Map<string, InternalShape>
  stmTripsRows: CsvRow[]
  stmStopsRows: CsvRow[]
  stmStopTimesRows: CsvRow[]
}) {
  const transitStopsById = new Map<string, TransitStopSummary>(
    Array.from(input.stations.values()).map((station) => [
      station.id,
      {
        id: station.id,
        mode: station.mode,
        name: station.name,
        lat: station.lat,
        lon: station.lon,
        routeIds: [...station.routeIds],
      } satisfies TransitStopSummary,
    ]),
  )
  const edgeByKey = new Map<string, TransitEdgeSummary>()

  attachRailTransitEdges(
    input.routes,
    input.shapesById,
    transitStopsById,
    edgeByKey,
  )

  buildBusTransitNetwork(
    input.stmTripsRows,
    input.stmStopsRows,
    input.stmStopTimesRows,
    input.routes,
    transitStopsById,
    edgeByKey,
  )

  attachTransferEdges(transitStopsById, edgeByKey)

  return {
    transitStopsById,
    transitEdges: Array.from(edgeByKey.values()),
  }
}

function attachRailTransitEdges(
  routes: Map<string, RouteSummary>,
  shapesById: Map<string, InternalShape>,
  transitStopsById: Map<string, TransitStopSummary>,
  edgeByKey: Map<string, TransitEdgeSummary>,
) {
  for (const route of routes.values()) {
    if (route.mode === 'bus') {
      continue
    }

    for (const shapeId of route.shapeIds) {
      const shape = shapesById.get(shapeId)
      if (!shape) {
        continue
      }

      const orderedStops = route.stationIds
        .map((stationId) => transitStopsById.get(stationId))
        .filter((stop): stop is TransitStopSummary => Boolean(stop))
        .map((stop) => ({
          stop,
          projection: projectPointToPolyline([stop.lon, stop.lat], shape.fullCoordinates),
        }))
        .filter((entry) => Number.isFinite(entry.projection.distanceKm))
        .sort(
          (left, right) =>
            left.projection.distanceAlongKm - right.projection.distanceAlongKm,
        )

      for (let index = 1; index < orderedStops.length; index += 1) {
        const previous = orderedStops[index - 1]
        const current = orderedStops[index]
        const distanceKm = Math.max(
          current.projection.distanceAlongKm - previous.projection.distanceAlongKm,
          haversineKm(
            previous.stop.lat,
            previous.stop.lon,
            current.stop.lat,
            current.stop.lon,
          ),
        )

        if (distanceKm <= 0.05) {
          continue
        }

        const geometry = slicePolylineAlongDistances(
          shape.fullCoordinates,
          shape.distances,
          previous.projection.distanceAlongKm,
          current.projection.distanceAlongKm,
        )
        const durationMin = estimateTransitRideDuration(distanceKm, route.mode)

        storeTransitEdge(edgeByKey, {
          from: previous.stop.id,
          to: current.stop.id,
          kind: 'ride',
          mode: route.mode,
          routeId: route.id,
          distanceKm,
          durationMin,
          geometry,
        })

        storeTransitEdge(edgeByKey, {
          from: current.stop.id,
          to: previous.stop.id,
          kind: 'ride',
          mode: route.mode,
          routeId: route.id,
          distanceKm,
          durationMin,
          geometry: [...geometry].reverse() as [number, number][],
        })
      }
    }
  }
}

function buildBusTransitNetwork(
  stmTripsRows: CsvRow[],
  stmStopsRows: CsvRow[],
  stmStopTimesRows: CsvRow[],
  routes: Map<string, RouteSummary>,
  transitStopsById: Map<string, TransitStopSummary>,
  edgeByKey: Map<string, TransitEdgeSummary>,
) {
  const tripById = new Map(stmTripsRows.map((row) => [row.trip_id, row]))
  const stopById = new Map(
    stmStopsRows
      .filter(
        (row) =>
          row.location_type !== '1' &&
          row.stop_id &&
          Number.isFinite(Number.parseFloat(row.stop_lat)) &&
          Number.isFinite(Number.parseFloat(row.stop_lon)),
      )
      .map((row) => [row.stop_id, row]),
  )
  const stopTimesByTrip = new Map<string, CsvRow[]>()

  for (const row of stmStopTimesRows) {
    const trip = tripById.get(row.trip_id)
    if (!trip) {
      continue
    }

    const route = routes.get(trip.route_id)
    if (!route || route.mode !== 'bus') {
      continue
    }

    const bucket = stopTimesByTrip.get(row.trip_id) ?? []
    bucket.push(row)
    stopTimesByTrip.set(row.trip_id, bucket)
  }

  for (const [tripId, stopTimes] of stopTimesByTrip) {
    const trip = tripById.get(tripId)
    if (!trip) {
      continue
    }

    const route = routes.get(trip.route_id)
    if (!route || route.mode !== 'bus') {
      continue
    }

    const ordered = [...stopTimes].sort(
      (left, right) =>
        Number.parseInt(left.stop_sequence, 10) -
        Number.parseInt(right.stop_sequence, 10),
    )

    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1]
      const current = ordered[index]
      const previousStop = stopById.get(previous.stop_id)
      const currentStop = stopById.get(current.stop_id)
      if (!previousStop || !currentStop) {
        continue
      }

      const fromStop = upsertBusTransitStop(previousStop, route.id, transitStopsById)
      const toStop = upsertBusTransitStop(currentStop, route.id, transitStopsById)
      const distanceKm = Math.max(
        haversineKm(fromStop.lat, fromStop.lon, toStop.lat, toStop.lon),
        parseShapeDistanceDeltaKm(previous, current),
      )

      if (distanceKm <= 0.03) {
        continue
      }

      const durationMin = estimateBusSegmentDuration(previous, current, distanceKm)

      storeTransitEdge(edgeByKey, {
        from: fromStop.id,
        to: toStop.id,
        kind: 'ride',
        mode: 'bus',
        routeId: route.id,
        distanceKm,
        durationMin,
        geometry: [
          [fromStop.lon, fromStop.lat],
          [toStop.lon, toStop.lat],
        ],
      })
    }
  }
}

function upsertBusTransitStop(
  row: CsvRow,
  routeId: string,
  transitStopsById: Map<string, TransitStopSummary>,
) {
  const id = `bus:${row.stop_id}`
  const existing = transitStopsById.get(id)

  if (existing) {
    if (!existing.routeIds.includes(routeId)) {
      existing.routeIds.push(routeId)
      existing.routeIds.sort((left, right) =>
        left.localeCompare(right, 'fr', { numeric: true }),
      )
    }

    return existing
  }

  const stop = {
    id,
    mode: 'bus',
    name: row.stop_name?.trim() || row.stop_id,
    lat: Number.parseFloat(row.stop_lat),
    lon: Number.parseFloat(row.stop_lon),
    routeIds: [routeId],
  } satisfies TransitStopSummary

  transitStopsById.set(id, stop)
  return stop
}

function attachTransferEdges(
  transitStopsById: Map<string, TransitStopSummary>,
  edgeByKey: Map<string, TransitEdgeSummary>,
) {
  const cells = new Map<string, TransitStopSummary[]>()
  const stops = Array.from(transitStopsById.values())

  for (const stop of stops) {
    const key = gridKey(stop.lat, stop.lon)
    const bucket = cells.get(key) ?? []
    bucket.push(stop)
    cells.set(key, bucket)
  }

  for (const stop of stops) {
    const [gridLat, gridLon] = toGridCoords(stop.lat, stop.lon)
    const seen = new Set<string>()

    for (let latOffset = -1; latOffset <= 1; latOffset += 1) {
      for (let lonOffset = -1; lonOffset <= 1; lonOffset += 1) {
        const bucket = cells.get(`${gridLat + latOffset}:${gridLon + lonOffset}`) ?? []
        for (const candidate of bucket) {
          if (candidate.id === stop.id || seen.has(candidate.id)) {
            continue
          }

          seen.add(candidate.id)
          if (candidate.id < stop.id) {
            continue
          }

          const thresholdKm = transferThresholdKm(stop, candidate)
          if (thresholdKm <= 0) {
            continue
          }

          const distanceKm = haversineKm(stop.lat, stop.lon, candidate.lat, candidate.lon)
          if (distanceKm > thresholdKm) {
            continue
          }

          const effectiveDistanceKm = Math.max(distanceKm, 0.04)
          const durationMin =
            estimateWalkingDuration(effectiveDistanceKm) +
            (stop.mode === candidate.mode ? 0.7 : 1.4)
          const geometry = [
            [stop.lon, stop.lat],
            [candidate.lon, candidate.lat],
          ] as [number, number][]

          storeTransitEdge(edgeByKey, {
            from: stop.id,
            to: candidate.id,
            kind: 'walk',
            mode: 'walking',
            distanceKm: effectiveDistanceKm,
            durationMin,
            geometry,
          })

          storeTransitEdge(edgeByKey, {
            from: candidate.id,
            to: stop.id,
            kind: 'walk',
            mode: 'walking',
            distanceKm: effectiveDistanceKm,
            durationMin,
            geometry: [...geometry].reverse() as [number, number][],
          })
        }
      }
    }
  }
}

function transferThresholdKm(left: TransitStopSummary, right: TransitStopSummary) {
  const sameName = normalizeText(left.name) === normalizeText(right.name)

  if (sameName) {
    return 0.45
  }

  if (left.mode === 'bus' && right.mode === 'bus') {
    return 0
  }

  if (left.mode === 'bus' || right.mode === 'bus') {
    return 0.24
  }

  return 0.32
}

function storeTransitEdge(
  edgeByKey: Map<string, TransitEdgeSummary>,
  edge: TransitEdgeSummary,
) {
  const key = `${edge.from}:${edge.to}:${edge.kind}:${edge.routeId ?? edge.mode}`
  const existing = edgeByKey.get(key)

  if (!existing || edge.durationMin < existing.durationMin) {
    edgeByKey.set(key, edge)
  }
}

function parseShapeDistanceDeltaKm(previous: CsvRow, current: CsvRow) {
  const previousValue = Number.parseFloat(previous.shape_dist_traveled || '')
  const currentValue = Number.parseFloat(current.shape_dist_traveled || '')

  if (!Number.isFinite(previousValue) || !Number.isFinite(currentValue)) {
    return 0
  }

  const delta = currentValue - previousValue
  if (!Number.isFinite(delta) || delta <= 0) {
    return 0
  }

  return delta > 100 ? delta / 1000 : delta
}

function estimateBusSegmentDuration(
  previous: CsvRow,
  current: CsvRow,
  distanceKm: number,
) {
  const previousTime = parseStopTime(previous.departure_time || previous.arrival_time)
  const currentTime = parseStopTime(current.arrival_time || current.departure_time)
  const scheduledMinutes =
    previousTime !== null && currentTime !== null && currentTime > previousTime
      ? (currentTime - previousTime) / 60
      : null

  if (scheduledMinutes && Number.isFinite(scheduledMinutes)) {
    return Math.max(1.2, scheduledMinutes)
  }

  return estimateTransitRideDuration(distanceKm, 'bus')
}

function parseStopTime(value: string | undefined) {
  if (!value || !value.includes(':')) {
    return null
  }

  return parseGtfsTime(value)
}

function estimateTransitRideDuration(
  distanceKm: number,
  mode: TransportMode,
) {
  const speedKmH =
    mode === 'rem' ? 40 : mode === 'metro' ? 30 : 18
  const dwellMin =
    mode === 'rem' ? 0.7 : mode === 'metro' ? 1.1 : 0.45

  return (distanceKm / speedKmH) * 60 + dwellMin
}

function estimateWalkingDuration(distanceKm: number) {
  return (distanceKm / 4.8) * 60
}

function toGridCoords(lat: number, lon: number) {
  return [
    Math.floor(lat / TRANSFER_GRID_DEGREES),
    Math.floor(lon / TRANSFER_GRID_DEGREES),
  ] as const
}

function gridKey(lat: number, lon: number) {
  const [gridLat, gridLon] = toGridCoords(lat, lon)
  return `${gridLat}:${gridLon}`
}

function buildRemTrips(
  tripRows: CsvRow[],
  stopTimeRows: CsvRow[],
  shapesById: Map<string, InternalShape>,
) {
  const tripsById = new Map<string, CsvRow>()
  for (const row of tripRows) {
    tripsById.set(row.trip_id, row)
  }

  const checkpointsByTrip = new Map<
    string,
    Array<{ time: number; distanceKm: number }>
  >()

  for (const row of stopTimeRows) {
    const bucket =
      checkpointsByTrip.get(row.trip_id) ??
      ([] as Array<{ time: number; distanceKm: number }>)
    bucket.push({
      time: parseGtfsTime(row.departure_time),
      distanceKm: Number.parseFloat(row.shape_dist_traveled || '0'),
    })
    checkpointsByTrip.set(row.trip_id, bucket)
  }

  const remTrips: RemTripEstimate[] = []
  for (const [tripId, checkpoints] of checkpointsByTrip) {
    const trip = tripsById.get(tripId)
    if (!trip) {
      continue
    }

    const shape = shapesById.get(trip.shape_id)
    if (!shape) {
      continue
    }

    const orderedCheckpoints = checkpoints.sort((left, right) => left.time - right.time)
    remTrips.push({
      tripId,
      routeId: trip.route_id,
      shapeId: trip.shape_id,
      serviceId: trip.service_id,
      directionId: trip.direction_id,
      headsign: trip.trip_headsign || trip.route_id,
      departureTime: orderedCheckpoints[0]?.time ?? 0,
      arrivalTime: orderedCheckpoints.at(-1)?.time ?? 0,
      checkpoints: orderedCheckpoints,
    })
  }

  return remTrips
}

async function fetchStmStatus() {
  const response = await fetch(STM_STATUS_URL)
  if (!response.ok) {
    throw new Error(`STM status returned ${response.status}`)
  }

  return (await response.json()) as {
    metro?: Record<string, { data?: { text?: string } }>
    bus?: {
      types?: Record<string, { list?: number[]; text?: string }>
    }
  }
}

function buildMetroServiceStates(
  model: InternalModel,
  stmStatus:
    | {
        metro?: Record<string, { data?: { text?: string } }>
      }
    | null,
) {
  return Array.from(model.routesById.values())
    .filter((route) => route.mode === 'metro')
    .map<ServiceState>((route) => {
      const message =
        stmStatus?.metro?.[route.id]?.data?.text ?? 'État du service indisponible.'
      return {
        routeId: route.id,
        mode: route.mode,
        status: classifyServiceStatus(message),
        message,
        updatedAt: new Date().toISOString(),
      }
    })
}

function buildBusServiceStates(
  model: InternalModel,
  stmStatus:
    | {
        bus?: {
          types?: Record<string, { list?: number[]; text?: string }>
        }
      }
    | null,
) {
  const disturbedRoutes = new Set<string>()
  const serviceStates: ServiceState[] = []

  for (const bucket of Object.values(stmStatus?.bus?.types ?? {})) {
    for (const routeNumber of bucket.list ?? []) {
      disturbedRoutes.add(String(routeNumber))
    }
  }

  for (const routeId of disturbedRoutes) {
    const route = model.routesById.get(routeId)
    if (!route || route.mode !== 'bus') {
      continue
    }

    serviceStates.push({
      routeId: route.id,
      mode: 'bus',
      status: 'warning',
      message: 'Perturbations ou modifications du service signalées par la STM.',
      updatedAt: new Date().toISOString(),
    })
  }

  return serviceStates
}

async function fetchRemStatus() {
  const response = await fetch(REM_STATUS_URL)
  if (!response.ok) {
    throw new Error(`REM status returned ${response.status}`)
  }

  const html = await response.text()
  const $ = cheerio.load(html)
  const mainText = $('main').text().replace(/\s+/g, ' ').trim()
  const currentNormal =
    mainText.includes('Réseau service normal') ||
    mainText.includes('Service - Normal') ||
    mainText.includes('service normal')

  const warnings: string[] = []
  const interruptionMatch = mainText.match(/Interruptions à venir\s+(\d+)/i)
  if (interruptionMatch && Number.parseInt(interruptionMatch[1], 10) > 0) {
    warnings.push(
      `${interruptionMatch[1]} interruption(s) à venir repérées sur la page REM.`,
    )
  }

  const serviceStates: ServiceState[] = []

  for (const routeId of ['S1', 'S2']) {
    serviceStates.push({
      routeId,
      mode: 'rem',
      status: currentNormal ? 'normal' : 'warning',
      message: currentNormal
        ? 'Service normal du REM.'
        : 'Vérifiez la page REM pour les interruptions en cours.',
      updatedAt: new Date().toISOString(),
    })
  }

  return {
    updatedAt: new Date().toISOString(),
    serviceStates,
    warnings,
  }
}

async function fetchBusEntities(model: InternalModel) {
  const feedUrl = process.env.STM_BUS_VEHICLE_POSITIONS_URL
  if (!feedUrl) {
    return []
  }

  const url = new URL(feedUrl)
  if (process.env.STM_API_KEY && process.env.STM_API_KEY_QUERY_PARAM) {
    url.searchParams.set(
      process.env.STM_API_KEY_QUERY_PARAM,
      process.env.STM_API_KEY,
    )
  }

  const headers = new Headers()
  headers.set('accept', 'application/x-protobuf')

  if (process.env.STM_API_KEY && !process.env.STM_API_KEY_QUERY_PARAM) {
    headers.set(process.env.STM_API_KEY_HEADER || 'apikey', process.env.STM_API_KEY)
  }

  const response = await fetch(url, { headers })
  if (!response.ok) {
    throw new Error(`STM GTFS-RT returned ${response.status}`)
  }

  const buffer = await response.arrayBuffer()
  const feed = gtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
    new Uint8Array(buffer),
  )

  const entities: LiveEntity[] = []

  for (const entity of feed.entity ?? []) {
    const vehicle = entity.vehicle
    const position = vehicle?.position
    const routeId = vehicle?.trip?.routeId

    if (!position || !routeId) {
      continue
    }

    const route = model.routesById.get(routeId)
    if (!route || route.mode !== 'bus') {
      continue
    }

    entities.push({
      id: `bus:${vehicle.vehicle?.id ?? entity.id ?? Math.random().toString(36)}`,
      mode: 'bus',
      routeId,
      label: route.shortName,
      lat: position.latitude,
      lon: position.longitude,
      bearing:
        typeof position.bearing === 'number' ? position.bearing : undefined,
      updatedAt: new Date().toISOString(),
      positionSource: 'realtime',
    })
  }

  return entities
}

function buildMetroEstimates(model: InternalModel, metroStates: ServiceState[]) {
  const now = getLocalSecondsOfDay()
  const entities: LiveEntity[] = []

  for (const state of metroStates) {
    if (state.status !== 'normal') {
      continue
    }

    const route = model.routesById.get(state.routeId)
    if (!route) {
      continue
    }

    const shapes = route.shapeIds
      .map((shapeId) => model.shapesById.get(shapeId))
      .filter((shape): shape is InternalShape => Boolean(shape))

    for (const [shapeIndex, shape] of shapes.entries()) {
      const averageSpeedKmH = 34
      const travelSeconds = Math.max(
        480,
        Math.round((shape.lengthKm / averageSpeedKmH) * 3600),
      )
      const vehicleCount = Math.min(10, Math.max(2, Math.round(shape.lengthKm / 3.2)))
      const phaseBase = (now % travelSeconds) / travelSeconds

      for (let vehicleIndex = 0; vehicleIndex < vehicleCount; vehicleIndex += 1) {
        const phase = (phaseBase + vehicleIndex / vehicleCount) % 1
        const [lon, lat] = interpolateAlongPolyline(
          shape.fullCoordinates,
          shape.distances,
          shape.lengthKm * phase,
        )
        const previousPhase = (phase + 0.995) % 1
        const [previousLon, previousLat] = interpolateAlongPolyline(
          shape.fullCoordinates,
          shape.distances,
          shape.lengthKm * previousPhase,
        )

        entities.push({
          id: `metro:${route.id}:${shapeIndex}:${vehicleIndex}`,
          mode: 'metro',
          routeId: route.id,
          label: route.shortName,
          lat,
          lon,
          bearing: computeBearing(previousLat, previousLon, lat, lon),
          updatedAt: new Date().toISOString(),
          positionSource: 'estimated',
        })
      }
    }
  }

  return entities
}

function buildRemEstimates(model: InternalModel, remStates: ServiceState[]) {
  const activeServiceIds = getActiveServiceIds(
    model.remCalendars,
    model.remCalendarDates,
  )
  const now = getLocalSecondsOfDay()
  const routeStateById = new Map(
    remStates.map((state) => [state.routeId, state.status] as const),
  )

  return model.remTrips.flatMap<LiveEntity>((trip) => {
    if (!activeServiceIds.has(trip.serviceId)) {
      return []
    }

    if (routeStateById.get(trip.routeId) !== 'normal') {
      return []
    }

    if (now < trip.departureTime || now > trip.arrivalTime) {
      return []
    }

    const shape = model.shapesById.get(trip.shapeId)
    if (!shape) {
      return []
    }

    const distanceKm = interpolateTripDistance(trip.checkpoints, now)
    const [lon, lat] = interpolateAlongPolyline(
      shape.fullCoordinates,
      shape.distances,
      distanceKm,
    )
    const previousDistanceKm = Math.max(0, distanceKm - 0.1)
    const [previousLon, previousLat] = interpolateAlongPolyline(
      shape.fullCoordinates,
      shape.distances,
      previousDistanceKm,
    )
    const route = model.routesById.get(trip.routeId)

    return [
      {
        id: `rem:${trip.tripId}`,
        mode: 'rem',
        routeId: trip.routeId,
        label: route?.shortName ?? trip.headsign,
        lat,
        lon,
        bearing: computeBearing(previousLat, previousLon, lat, lon),
        updatedAt: new Date().toISOString(),
        positionSource: 'estimated',
      },
    ]
  })
}

function getActiveServiceIds(calendars: CsvRow[], calendarDates: CsvRow[]) {
  const now = getLocalDateParts()
  const dateKey = now.dateKey
  const weekday = now.weekday
  const activeServiceIds = new Set<string>()
  const weekdayField = [
    'sunday',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
  ][weekday]

  for (const row of calendars) {
    if (dateKey < row.start_date || dateKey > row.end_date) {
      continue
    }

    if (row[weekdayField] === '1') {
      activeServiceIds.add(row.service_id)
    }
  }

  for (const row of calendarDates) {
    if (row.date !== dateKey) {
      continue
    }

    if (row.exception_type === '1') {
      activeServiceIds.add(row.service_id)
    }

    if (row.exception_type === '2') {
      activeServiceIds.delete(row.service_id)
    }
  }

  return activeServiceIds
}

function interpolateTripDistance(
  checkpoints: Array<{ time: number; distanceKm: number }>,
  currentTime: number,
) {
  if (checkpoints.length === 0) {
    return 0
  }

  if (currentTime <= checkpoints[0].time) {
    return checkpoints[0].distanceKm
  }

  const lastCheckpoint = checkpoints.at(-1)
  if (lastCheckpoint && currentTime >= lastCheckpoint.time) {
    return lastCheckpoint.distanceKm
  }

  for (let index = 1; index < checkpoints.length; index += 1) {
    const previous = checkpoints[index - 1]
    const current = checkpoints[index]
    if (currentTime > current.time) {
      continue
    }

    const ratio =
      current.time === previous.time
        ? 0
        : (currentTime - previous.time) / (current.time - previous.time)

    return previous.distanceKm + (current.distanceKm - previous.distanceKm) * ratio
  }

  return checkpoints.at(-1)?.distanceKm ?? 0
}

function tidyStationName(name: string) {
  return name
    .replace(/^Station\s+/i, '')
    .replace(/^STATION\s+/i, '')
    .trim()
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1)
}

function parseGtfsTime(value: string) {
  const [hoursText, minutesText, secondsText] = value.split(':')
  return (
    Number.parseInt(hoursText, 10) * 3600 +
    Number.parseInt(minutesText, 10) * 60 +
    Number.parseInt(secondsText, 10)
  )
}

function getStyleOptions(): MapStyleOption[] {
  const hasMapTilerKey = Boolean(
    process.env.MAPTILER_API_KEY || process.env.VITE_MAPTILER_API_KEY,
  )

  return [
    { id: 'streets', label: '2D', available: true },
    { id: 'satellite', label: 'Aérien', available: hasMapTilerKey },
  ]
}

function normalizeText(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
}

function sortRoutes(left: RouteSummary, right: RouteSummary) {
  const order = { metro: 0, rem: 1, bus: 2 }
  const modeDiff = order[left.mode] - order[right.mode]
  if (modeDiff !== 0) {
    return modeDiff
  }

  return left.shortName.localeCompare(right.shortName, 'fr', {
    numeric: true,
  })
}

function classifyServiceStatus(message: string): ServiceStatus {
  const normalized = normalizeText(message)
  if (!normalized) {
    return 'unknown'
  }

  if (normalized.includes('service normal')) {
    return 'normal'
  }

  if (
    normalized.includes('interruption') ||
    normalized.includes('fermeture') ||
    normalized.includes('panne')
  ) {
    return 'interruption'
  }

  return 'warning'
}

function getLocalDateParts() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  })

  const parts = formatter.formatToParts(new Date())
  const valueByType = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  }

  return {
    dateKey: `${valueByType.year}${valueByType.month}${valueByType.day}`,
    weekday: weekdayMap[valueByType.weekday] ?? 0,
  }
}

function getLocalSecondsOfDay() {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Toronto',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })

  const [hours, minutes, seconds] = formatter
    .format(new Date())
    .split(':')
    .map((value) => Number.parseInt(value, 10))

  return hours * 3600 + minutes * 60 + seconds
}

function computeBearing(
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
) {
  const startLat = (fromLat * Math.PI) / 180
  const endLat = (toLat * Math.PI) / 180
  const deltaLon = ((toLon - fromLon) * Math.PI) / 180

  const y = Math.sin(deltaLon) * Math.cos(endLat)
  const x =
    Math.cos(startLat) * Math.sin(endLat) -
    Math.sin(startLat) * Math.cos(endLat) * Math.cos(deltaLon)

  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

function stringifyError(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}
