import {
  haversineKm,
  projectPointToPolyline,
} from '../shared/geo.ts'
import type {
  BootstrapResponse,
  SearchItem,
  ShapeFeature,
  StationSummary,
  TransportMode,
} from '../shared/types.ts'

export type PlannerMode = 'walking' | 'transit' | 'bixi'

export interface PlannerStation {
  id: string
  mode: TransportMode
  name: string
  lat: number
  lon: number
}

export interface PlannerSegment {
  kind: 'walk' | 'ride'
  mode: 'walking' | TransportMode
  label: string
  from: string
  to: string
  durationMin: number
  distanceKm: number
  routeId?: string
  stops?: number
}

export interface PlannerResult {
  mode: PlannerMode
  durationMin: number
  distanceKm: number
  transfers: number
  segments: PlannerSegment[]
  warnings: string[]
}

interface TransitEdge {
  to: string
  kind: PlannerSegment['kind']
  mode: PlannerSegment['mode']
  routeId?: string
  durationMin: number
  distanceKm: number
}

interface QueueEntry {
  stationId: string
  durationMin: number
}

const TRANSFER_DISTANCE_KM = 0.45
const MIN_TRANSFER_DISTANCE_KM = 0.06

export function toPlannerStation(item: SearchItem | StationSummary | null) {
  if (!item) {
    return null
  }

  if ('type' in item && item.type !== 'station') {
    return null
  }

  if ('type' in item) {
    return {
      id: item.id,
      mode: item.mode,
      name: item.label,
      lat: item.lat,
      lon: item.lon,
    } satisfies PlannerStation
  }

  return {
    id: item.id,
    mode: item.mode,
    name: item.name,
    lat: item.lat,
    lon: item.lon,
  } satisfies PlannerStation
}

export function buildPlanner(
  bootstrap: BootstrapResponse,
  origin: PlannerStation | null,
  destination: PlannerStation | null,
  mode: PlannerMode,
) {
  if (!origin || !destination) {
    return null
  }

  if (mode === 'walking') {
    return buildWalkingPlan(origin, destination)
  }

  if (mode === 'bixi') {
    return null
  }

  return buildTransitPlan(bootstrap, origin, destination)
}

function buildWalkingPlan(origin: PlannerStation, destination: PlannerStation) {
  const directKm = haversineKm(origin.lat, origin.lon, destination.lat, destination.lon)
  const networkKm = directKm * 1.24
  const durationMin = Math.round((networkKm / 4.8) * 60)

  return {
    mode: 'walking',
    durationMin,
    distanceKm: networkKm,
    transfers: 0,
    segments: [
      {
        kind: 'walk',
        mode: 'walking',
        label: 'Marche estimée',
        from: origin.name,
        to: destination.name,
        durationMin,
        distanceKm: networkKm,
      },
    ],
    warnings: [
      'Temps de marche estimé à partir de la distance réseau approximée, pas d’un itinéraire piéton détaillé.',
    ],
  } satisfies PlannerResult
}

function buildTransitPlan(
  bootstrap: BootstrapResponse,
  origin: PlannerStation,
  destination: PlannerStation,
) {
  if (origin.id === destination.id) {
    return {
      mode: 'transit',
      durationMin: 0,
      distanceKm: 0,
      transfers: 0,
      segments: [],
      warnings: [],
    } satisfies PlannerResult
  }

  const graph = buildTransitGraph(bootstrap)
  const path = shortestPath(graph, origin.id, destination.id)

  if (!path) {
    return null
  }

  const stationsById = new Map(bootstrap.stations.map((station) => [station.id, station]))
  const routesById = new Map(bootstrap.routes.map((route) => [route.id, route]))
  const segments = collapseTransitPath(path, stationsById, routesById)
  const distanceKm = segments.reduce((sum, segment) => sum + segment.distanceKm, 0)
  const durationMin = Math.round(
    segments.reduce((sum, segment) => sum + segment.durationMin, 0),
  )
  const rideSegments = segments.filter((segment) => segment.kind === 'ride')

  return {
    mode: 'transit',
    durationMin,
    distanceKm,
    transfers: Math.max(rideSegments.length - 1, 0),
    segments,
    warnings: [
      'Planificateur V1 basé sur les stations métro et REM avec des temps estimés.',
    ],
  } satisfies PlannerResult
}

function buildTransitGraph(bootstrap: BootstrapResponse) {
  const graph = new Map<string, TransitEdge[]>()
  const stationsById = new Map(bootstrap.stations.map((station) => [station.id, station]))
  const shapesById = new Map(bootstrap.shapes.map((shape) => [shape.id, shape]))

  for (const station of bootstrap.stations) {
    graph.set(station.id, [])
  }

  for (const route of bootstrap.routes) {
    if (route.mode === 'bus') {
      continue
    }

    const shape = route.shapeIds
      .map((shapeId) => shapesById.get(shapeId))
      .find((candidate): candidate is ShapeFeature => Boolean(candidate))

    if (!shape) {
      continue
    }

    const orderedStations = route.stationIds
      .map((stationId) => stationsById.get(stationId))
      .filter((station): station is StationSummary => Boolean(station))
      .map((station) => ({
        station,
        projection: projectPointToPolyline([station.lon, station.lat], shape.coordinates),
      }))
      .sort((left, right) => left.projection.distanceAlongKm - right.projection.distanceAlongKm)

    for (let index = 1; index < orderedStations.length; index += 1) {
      const previous = orderedStations[index - 1]
      const current = orderedStations[index]
      const distanceKm = Math.max(
        current.projection.distanceAlongKm - previous.projection.distanceAlongKm,
        haversineKm(
          previous.station.lat,
          previous.station.lon,
          current.station.lat,
          current.station.lon,
        ),
      )

      addEdge(graph, previous.station.id, {
        to: current.station.id,
        kind: 'ride',
        mode: route.mode,
        routeId: route.id,
        distanceKm,
        durationMin: estimateRideDuration(distanceKm, route.mode),
      })

      addEdge(graph, current.station.id, {
        to: previous.station.id,
        kind: 'ride',
        mode: route.mode,
        routeId: route.id,
        distanceKm,
        durationMin: estimateRideDuration(distanceKm, route.mode),
      })
    }
  }

  for (let leftIndex = 0; leftIndex < bootstrap.stations.length; leftIndex += 1) {
    const left = bootstrap.stations[leftIndex]

    for (let rightIndex = leftIndex + 1; rightIndex < bootstrap.stations.length; rightIndex += 1) {
      const right = bootstrap.stations[rightIndex]
      const distanceKm = haversineKm(left.lat, left.lon, right.lat, right.lon)
      const sameStation = normalizeStationName(left.name) === normalizeStationName(right.name)

      if (!sameStation && distanceKm > TRANSFER_DISTANCE_KM) {
        continue
      }

      const effectiveDistance = Math.max(distanceKm, MIN_TRANSFER_DISTANCE_KM)
      const durationMin = estimateWalkDuration(effectiveDistance) + 2

      addEdge(graph, left.id, {
        to: right.id,
        kind: 'walk',
        mode: 'walking',
        distanceKm: effectiveDistance,
        durationMin,
      })

      addEdge(graph, right.id, {
        to: left.id,
        kind: 'walk',
        mode: 'walking',
        distanceKm: effectiveDistance,
        durationMin,
      })
    }
  }

  return graph
}

function shortestPath(
  graph: Map<string, TransitEdge[]>,
  originId: string,
  destinationId: string,
) {
  const queue: QueueEntry[] = [{ stationId: originId, durationMin: 0 }]
  const durations = new Map<string, number>([[originId, 0]])
  const previous = new Map<string, { stationId: string; edge: TransitEdge }>()
  const visited = new Set<string>()

  while (queue.length > 0) {
    queue.sort((left, right) => left.durationMin - right.durationMin)
    const current = queue.shift()

    if (!current || visited.has(current.stationId)) {
      continue
    }

    visited.add(current.stationId)

    if (current.stationId === destinationId) {
      break
    }

    for (const edge of graph.get(current.stationId) ?? []) {
      const nextDuration = current.durationMin + edge.durationMin
      if (nextDuration >= (durations.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
        continue
      }

      durations.set(edge.to, nextDuration)
      previous.set(edge.to, { stationId: current.stationId, edge })
      queue.push({ stationId: edge.to, durationMin: nextDuration })
    }
  }

  if (!previous.has(destinationId)) {
    return null
  }

  const path: Array<{ from: string; to: string; edge: TransitEdge }> = []
  let cursor = destinationId

  while (cursor !== originId) {
    const step = previous.get(cursor)
    if (!step) {
      return null
    }

    path.unshift({
      from: step.stationId,
      to: cursor,
      edge: step.edge,
    })
    cursor = step.stationId
  }

  return path
}

function collapseTransitPath(
  path: Array<{ from: string; to: string; edge: TransitEdge }>,
  stationsById: Map<string, StationSummary>,
  routesById: Map<string, BootstrapResponse['routes'][number]>,
) {
  const segments: PlannerSegment[] = []

  for (const step of path) {
    const fromStation = stationsById.get(step.from)
    const toStation = stationsById.get(step.to)
    if (!fromStation || !toStation) {
      continue
    }

    const route = step.edge.routeId ? routesById.get(step.edge.routeId) : null
    const label =
      step.edge.kind === 'walk'
        ? 'Correspondance à pied'
        : route?.mode === 'metro'
          ? `Ligne ${route.shortName}`
          : `REM ${route?.shortName ?? step.edge.routeId ?? ''}`.trim()

    const previousSegment = segments.at(-1)
    if (
      previousSegment &&
      previousSegment.kind === 'ride' &&
      step.edge.kind === 'ride' &&
      previousSegment.routeId === step.edge.routeId
    ) {
      previousSegment.to = toStation.name
      previousSegment.durationMin += step.edge.durationMin
      previousSegment.distanceKm += step.edge.distanceKm
      previousSegment.stops = (previousSegment.stops ?? 1) + 1
      continue
    }

    segments.push({
      kind: step.edge.kind,
      mode: step.edge.mode,
      label,
      from: fromStation.name,
      to: toStation.name,
      durationMin: step.edge.durationMin,
      distanceKm: step.edge.distanceKm,
      routeId: step.edge.routeId,
      stops: step.edge.kind === 'ride' ? 1 : undefined,
    })
  }

  return segments.map((segment) => ({
    ...segment,
    durationMin: Math.round(segment.durationMin),
    distanceKm: Number(segment.distanceKm.toFixed(1)),
  }))
}

function addEdge(graph: Map<string, TransitEdge[]>, from: string, edge: TransitEdge) {
  const bucket = graph.get(from) ?? []
  bucket.push(edge)
  graph.set(from, bucket)
}

function normalizeStationName(name: string) {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
}

function estimateWalkDuration(distanceKm: number) {
  return (distanceKm / 4.8) * 60
}

function estimateRideDuration(distanceKm: number, mode: TransportMode) {
  const speedKmH = mode === 'rem' ? 42 : 31
  const dwellMin = mode === 'rem' ? 0.8 : 1.1
  return (distanceKm / speedKmH) * 60 + dwellMin
}
