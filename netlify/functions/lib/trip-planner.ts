import { haversineKm } from '../../../src/shared/geo.ts'
import type {
  BixiStation,
  GeoPoint,
  Itinerary,
  ItineraryMode,
  ItineraryPlace,
  ItinerarySegment,
  PlanResponse,
  ResolvedPlace,
  RouteSummary,
} from '../../../src/shared/types.ts'
import { getBixiData } from './bixi.ts'
import {
  getTransitPlanningData,
  type TransitEdgeSummary,
  type TransitStopSummary,
} from './data.ts'
import {
  estimateSurfacePath,
  resolvePlace,
  routeSurfacePath,
} from './places.ts'

interface GraphCandidate {
  stop: TransitStopSummary
  access: number
}

interface PathStep {
  from: string
  to: string
  edge: TransitEdgeSummary
}

interface TransitGraph {
  graph: Map<string, TransitEdgeSummary[]>
  transitStopsById: Map<string, TransitStopSummary>
  routesById: Map<string, RouteSummary>
}

const BIXI_ACCESS_LIMIT_KM = 1.8
const BUS_ACCESS_LIMIT_KM = 1.1
const RAIL_ACCESS_LIMIT_KM = 3.2

let transitGraphCache:
  | {
      key: string
      value: TransitGraph
    }
  | undefined

export async function buildPlan(input: {
  from?: string | null
  to?: string | null
  fromLat?: number | null
  fromLon?: number | null
  toLat?: number | null
  toLon?: number | null
  modes?: ItineraryMode[]
}) {
  const [origin, destination] = await Promise.all([
    resolvePlace({
      query: input.from,
      lat: input.fromLat,
      lon: input.fromLon,
      label: input.from,
    }),
    resolvePlace({
      query: input.to,
      lat: input.toLat,
      lon: input.toLon,
      label: input.to,
    }),
  ])
  const modes = input.modes && input.modes.length > 0
    ? Array.from(new Set(input.modes))
    : (['walking', 'transit', 'cycling', 'bixi'] as const)

  const results = await Promise.all(
    modes.map(async (mode) => {
      try {
        if (mode === 'walking') {
          return {
            itineraries: [await buildWalkingItinerary(origin, destination)],
            warnings: [] as string[],
          }
        }

        if (mode === 'transit') {
          const itinerary = await buildTransitItinerary(origin, destination)
          return itinerary
            ? {
                itineraries: [itinerary],
                warnings: [] as string[],
              }
            : {
                itineraries: [] as Itinerary[],
                warnings: ['Aucun itinéraire transit viable trouvé entre ces adresses.'],
              }
        }

        if (mode === 'cycling') {
          return {
            itineraries: [await buildCyclingItinerary(origin, destination)],
            warnings: [] as string[],
          }
        }

        const itinerary = await buildBixiItinerary(origin, destination)
        return itinerary
          ? {
              itineraries: [itinerary],
              warnings: [] as string[],
            }
          : {
              itineraries: [] as Itinerary[],
              warnings: ['Aucun itinéraire BIXI viable trouvé entre ces adresses.'],
            }
      } catch (error) {
        return {
          itineraries: [] as Itinerary[],
          warnings: [
            `${modeLabel(mode)} indisponible: ${error instanceof Error ? error.message : String(error)}`,
          ],
        }
      }
    }),
  )

  const warnings = results.flatMap((result) => result.warnings)
  const itineraries = results.flatMap((result) => result.itineraries)

  itineraries.sort((left, right) => left.durationMin - right.durationMin)

  return {
    generatedAt: new Date().toISOString(),
    origin,
    destination,
    itineraries,
    warnings,
  } satisfies PlanResponse
}

async function buildWalkingItinerary(origin: ResolvedPlace, destination: ResolvedPlace) {
  const route = await routeSurfacePath(origin, destination, 'walking')

  return {
    id: 'walking',
    mode: 'walking',
    summary: 'À pied',
    durationMin: Math.round(route.durationMin),
    distanceKm: round1(route.distanceKm),
    transfers: 0,
    segments: [
      buildSurfaceSegment({
        id: 'walking:direct',
        kind: 'walk',
        mode: 'walking',
        label: 'Marche',
        from: toItineraryPlace(origin),
        to: toItineraryPlace(destination),
        distanceKm: route.distanceKm,
        durationMin: route.durationMin,
        geometry: route.geometry,
      }),
    ],
    warnings:
      route.provider === 'estimated'
        ? ['Temps et tracé de marche estimés, faute de moteur de routage externe.']
        : [],
  } satisfies Itinerary
}

async function buildCyclingItinerary(origin: ResolvedPlace, destination: ResolvedPlace) {
  const route = await routeSurfacePath(origin, destination, 'cycling')

  return {
    id: 'cycling',
    mode: 'cycling',
    summary: 'Vélo personnel',
    durationMin: Math.round(route.durationMin),
    distanceKm: round1(route.distanceKm),
    transfers: 0,
    segments: [
      buildSurfaceSegment({
        id: 'cycling:direct',
        kind: 'bike',
        mode: 'cycling',
        label: 'Vélo personnel',
        from: toItineraryPlace(origin),
        to: toItineraryPlace(destination),
        distanceKm: route.distanceKm,
        durationMin: route.durationMin,
        geometry: route.geometry,
      }),
    ],
    warnings:
      route.provider === 'estimated'
        ? ['Temps et tracé vélo estimés, faute de moteur de routage externe.']
        : [],
  } satisfies Itinerary
}

async function buildTransitItinerary(
  origin: ResolvedPlace,
  destination: ResolvedPlace,
) {
  const graph = await getTransitGraph()
  const stops = Array.from(graph.transitStopsById.values())
  const originCandidates = pickTransitCandidates(origin, stops)
  const destinationCandidates = pickTransitCandidates(destination, stops)

  if (originCandidates.length === 0 || destinationCandidates.length === 0) {
    return null
  }

  let best:
    | {
        originCandidate: GraphCandidate
        destinationCandidate: GraphCandidate
        path: PathStep[]
        durationMin: number
      }
    | undefined

  for (const originCandidate of originCandidates) {
    for (const destinationCandidate of destinationCandidates) {
      const path = shortestTransitPath(
        graph.graph,
        originCandidate.stop.id,
        destinationCandidate.stop.id,
      )

      if (!path) {
        continue
      }

      const transitDurationMin = path.reduce(
        (sum, step) => sum + step.edge.durationMin,
        0,
      )
      const totalDurationMin =
        originCandidate.access + transitDurationMin + destinationCandidate.access

      if (!best || totalDurationMin < best.durationMin) {
        best = {
          originCandidate,
          destinationCandidate,
          path,
          durationMin: totalDurationMin,
        }
      }
    }
  }

  if (!best) {
    return null
  }

  const accessRoute = await routeSurfacePath(
    origin,
    best.originCandidate.stop,
    'walking',
  )
  const egressRoute = await routeSurfacePath(
    best.destinationCandidate.stop,
    destination,
    'walking',
  )
  const rideSegments = collapseTransitPath(
    best.path,
    graph.transitStopsById,
    graph.routesById,
  )

  const segments: ItinerarySegment[] = [
    buildSurfaceSegment({
      id: 'transit:walk:start',
      kind: 'walk',
      mode: 'walking',
      label: `Marcher jusqu’à ${best.originCandidate.stop.name}`,
      from: toItineraryPlace(origin),
      to: toItineraryPlace(best.originCandidate.stop),
      distanceKm: accessRoute.distanceKm,
      durationMin: accessRoute.durationMin,
      geometry: accessRoute.geometry,
      stationId: best.originCandidate.stop.id,
      stationName: best.originCandidate.stop.name,
    }),
    ...rideSegments,
    buildSurfaceSegment({
      id: 'transit:walk:end',
      kind: 'walk',
      mode: 'walking',
      label: `Marcher jusqu’à ${destination.label}`,
      from: toItineraryPlace(best.destinationCandidate.stop),
      to: toItineraryPlace(destination),
      distanceKm: egressRoute.distanceKm,
      durationMin: egressRoute.durationMin,
      geometry: egressRoute.geometry,
      stationId: best.destinationCandidate.stop.id,
      stationName: best.destinationCandidate.stop.name,
    }),
  ].filter((segment) => segment.durationMin > 0)

  const warnings: string[] = []
  if (accessRoute.provider === 'estimated' || egressRoute.provider === 'estimated') {
    warnings.push('Les tronçons à pied autour du réseau transit sont estimés.')
  }

  const transferCount = Math.max(
    segments.filter((segment) => segment.kind === 'ride').length - 1,
    0,
  )

  return {
    id: 'transit',
    mode: 'transit',
    summary: buildTransitSummary(segments),
    durationMin: Math.round(segments.reduce((sum, segment) => sum + segment.durationMin, 0)),
    distanceKm: round1(segments.reduce((sum, segment) => sum + segment.distanceKm, 0)),
    transfers: transferCount,
    segments,
    warnings,
  } satisfies Itinerary
}

async function buildBixiItinerary(
  origin: ResolvedPlace,
  destination: ResolvedPlace,
) {
  const bixi = await getBixiData({ availableOnly: true })
  const originStations = pickBixiOriginCandidates(origin, bixi.stations)
  const destinationStations = pickBixiDestinationCandidates(
    destination,
    bixi.stations,
  )

  if (originStations.length === 0 || destinationStations.length === 0) {
    return null
  }

  let best:
    | {
        originStation: BixiStation
        destinationStation: BixiStation
        walkInMin: number
        rideMin: number
        walkOutMin: number
      }
    | undefined

  for (const originStation of originStations) {
    for (const destinationStation of destinationStations) {
      if (originStation.id === destinationStation.id) {
        continue
      }

      const walkIn = estimateSurfacePath(origin, originStation, 'walking')
      const ride = estimateSurfacePath(originStation, destinationStation, 'cycling')
      const walkOut = estimateSurfacePath(destinationStation, destination, 'walking')
      const total = walkIn.durationMin + ride.durationMin + walkOut.durationMin

      if (
        !best ||
        total < best.walkInMin + best.rideMin + best.walkOutMin
      ) {
        best = {
          originStation,
          destinationStation,
          walkInMin: walkIn.durationMin,
          rideMin: ride.durationMin,
          walkOutMin: walkOut.durationMin,
        }
      }
    }
  }

  if (!best) {
    return null
  }

  const walkInRoute = await routeSurfacePath(origin, best.originStation, 'walking')
  const rideRoute = await routeSurfacePath(
    best.originStation,
    best.destinationStation,
    'cycling',
  )
  const walkOutRoute = await routeSurfacePath(
    best.destinationStation,
    destination,
    'walking',
  )

  const segments: ItinerarySegment[] = [
    buildSurfaceSegment({
      id: 'bixi:walk:start',
      kind: 'walk',
      mode: 'walking',
      label: `Marcher jusqu’à ${best.originStation.name}`,
      from: toItineraryPlace(origin),
      to: toItineraryPlace(best.originStation),
      distanceKm: walkInRoute.distanceKm,
      durationMin: walkInRoute.durationMin,
      geometry: walkInRoute.geometry,
      stationId: best.originStation.id,
      stationName: best.originStation.name,
      bikesAvailable: best.originStation.bikesAvailable,
      docksAvailable: best.originStation.docksAvailable,
    }),
    buildBixiRideSegment({
      id: 'bixi:ride',
      label: `BIXI ${best.originStation.name} → ${best.destinationStation.name}`,
      from: toItineraryPlace(best.originStation),
      to: toItineraryPlace(best.destinationStation),
      distanceKm: rideRoute.distanceKm,
      durationMin: rideRoute.durationMin,
      geometry: rideRoute.geometry,
      stationId: best.originStation.id,
      stationName: best.originStation.name,
      bikesAvailable: best.originStation.bikesAvailable,
      docksAvailable: best.destinationStation.docksAvailable,
    }),
    buildSurfaceSegment({
      id: 'bixi:walk:end',
      kind: 'walk',
      mode: 'walking',
      label: `Marcher jusqu’à ${destination.label}`,
      from: toItineraryPlace(best.destinationStation),
      to: toItineraryPlace(destination),
      distanceKm: walkOutRoute.distanceKm,
      durationMin: walkOutRoute.durationMin,
      geometry: walkOutRoute.geometry,
      stationId: best.destinationStation.id,
      stationName: best.destinationStation.name,
      bikesAvailable: best.destinationStation.bikesAvailable,
      docksAvailable: best.destinationStation.docksAvailable,
    }),
  ].filter((segment) => segment.durationMin > 0)

  const warnings: string[] = []
  if (
    walkInRoute.provider === 'estimated' ||
    rideRoute.provider === 'estimated' ||
    walkOutRoute.provider === 'estimated'
  ) {
    warnings.push('Les tronçons marche/vélo sont estimés sans clé ORS.')
  }

  return {
    id: 'bixi',
    mode: 'bixi',
    summary: 'Marche + BIXI + marche',
    durationMin: Math.round(segments.reduce((sum, segment) => sum + segment.durationMin, 0)),
    distanceKm: round1(segments.reduce((sum, segment) => sum + segment.distanceKm, 0)),
    transfers: 0,
    segments,
    warnings,
  } satisfies Itinerary
}

async function getTransitGraph() {
  const planning = await getTransitPlanningData()
  const cacheKey = [
    planning.routesById.size,
    planning.transitStopsById.size,
    planning.transitEdges.length,
  ].join(':')

  if (transitGraphCache?.key === cacheKey) {
    return transitGraphCache.value
  }

  const graph = new Map<string, TransitEdgeSummary[]>()
  for (const stopId of planning.transitStopsById.keys()) {
    graph.set(stopId, [])
  }

  for (const edge of planning.transitEdges) {
    const bucket = graph.get(edge.from) ?? []
    bucket.push(edge)
    graph.set(edge.from, bucket)
  }

  const value = {
    graph,
    transitStopsById: planning.transitStopsById,
    routesById: planning.routesById,
  } satisfies TransitGraph

  transitGraphCache = {
    key: cacheKey,
    value,
  }

  return value
}

function pickTransitCandidates(place: GeoPoint, stops: TransitStopSummary[]) {
  return stops
    .map((stop) => ({
      stop,
      distanceKm: haversineKm(place.lat, place.lon, stop.lat, stop.lon),
    }))
    .filter((entry) => entry.distanceKm <= transitAccessLimit(entry.stop.mode))
    .sort((left, right) => {
      const leftScore = left.distanceKm + transitCandidateBias(left.stop.mode)
      const rightScore = right.distanceKm + transitCandidateBias(right.stop.mode)
      return leftScore - rightScore
    })
    .slice(0, 12)
    .map<GraphCandidate>((entry) => ({
      stop: entry.stop,
      access: estimateWalkingDuration(
        entry.distanceKm * (entry.stop.mode === 'bus' ? 1.08 : 1.18),
      ),
    }))
}

function transitAccessLimit(mode: TransitStopSummary['mode']) {
  return mode === 'bus' ? BUS_ACCESS_LIMIT_KM : RAIL_ACCESS_LIMIT_KM
}

function transitCandidateBias(mode: TransitStopSummary['mode']) {
  return mode === 'bus' ? 0 : 0.15
}

function pickBixiOriginCandidates(place: GeoPoint, stations: BixiStation[]) {
  return stations
    .filter(
      (station) =>
        station.isInstalled &&
        station.isRenting &&
        station.bikesAvailable > 0,
    )
    .map((station) => ({
      station,
      distanceKm: haversineKm(place.lat, place.lon, station.lat, station.lon),
    }))
    .filter((entry) => entry.distanceKm <= BIXI_ACCESS_LIMIT_KM)
    .sort((left, right) => left.distanceKm - right.distanceKm)
    .slice(0, 5)
    .map((entry) => entry.station)
}

function pickBixiDestinationCandidates(place: GeoPoint, stations: BixiStation[]) {
  return stations
    .filter(
      (station) =>
        station.isInstalled &&
        station.isReturning &&
        station.docksAvailable > 0,
    )
    .map((station) => ({
      station,
      distanceKm: haversineKm(place.lat, place.lon, station.lat, station.lon),
    }))
    .filter((entry) => entry.distanceKm <= BIXI_ACCESS_LIMIT_KM)
    .sort((left, right) => left.distanceKm - right.distanceKm)
    .slice(0, 5)
    .map((entry) => entry.station)
}

function shortestTransitPath(
  graph: Map<string, TransitEdgeSummary[]>,
  originId: string,
  destinationId: string,
) {
  const queue = [{ stationId: originId, durationMin: 0 }]
  const bestDuration = new Map<string, number>([[originId, 0]])
  const previous = new Map<string, { stationId: string; edge: TransitEdgeSummary }>()
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
      if (nextDuration >= (bestDuration.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
        continue
      }

      bestDuration.set(edge.to, nextDuration)
      previous.set(edge.to, { stationId: current.stationId, edge })
      queue.push({ stationId: edge.to, durationMin: nextDuration })
    }
  }

  if (!previous.has(destinationId)) {
    return null
  }

  const path: PathStep[] = []
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
  path: PathStep[],
  transitStopsById: Map<string, TransitStopSummary>,
  routesById: Map<string, RouteSummary>,
) {
  const segments: ItinerarySegment[] = []

  for (const step of path) {
    const fromStop = transitStopsById.get(step.from)
    const toStop = transitStopsById.get(step.to)
    if (!fromStop || !toStop) {
      continue
    }

    if (step.edge.kind === 'ride') {
      const route = step.edge.routeId ? routesById.get(step.edge.routeId) : undefined
      const label = transitRideLabel(route, step.edge.routeId, step.edge.mode)
      const previousSegment = segments.at(-1)

      if (
        previousSegment &&
        previousSegment.kind === 'ride' &&
        previousSegment.routeId === step.edge.routeId
      ) {
        previousSegment.to = toItineraryPlace(toStop)
        previousSegment.durationMin = Math.round(
          previousSegment.durationMin + step.edge.durationMin,
        )
        previousSegment.distanceKm = round1(
          previousSegment.distanceKm + step.edge.distanceKm,
        )
        previousSegment.geometry = mergeGeometries(
          previousSegment.geometry,
          step.edge.geometry,
        )
        continue
      }

      segments.push({
        id: `ride:${step.edge.routeId ?? step.from}:${step.to}`,
        kind: 'ride',
        mode: step.edge.mode,
        label,
        from: toItineraryPlace(fromStop),
        to: toItineraryPlace(toStop),
        durationMin: Math.round(step.edge.durationMin),
        distanceKm: round1(step.edge.distanceKm),
        routeId: step.edge.routeId,
        geometry: step.edge.geometry,
      })
      continue
    }

    segments.push({
      id: `walk:${step.from}:${step.to}`,
      kind: 'walk',
      mode: 'walking',
      label: 'Correspondance à pied',
      from: toItineraryPlace(fromStop),
      to: toItineraryPlace(toStop),
      durationMin: Math.round(step.edge.durationMin),
      distanceKm: round1(step.edge.distanceKm),
      geometry: step.edge.geometry,
    })
  }

  return segments
}

function transitRideLabel(
  route: RouteSummary | undefined,
  routeId: string | undefined,
  mode: TransitEdgeSummary['mode'],
) {
  if (mode === 'bus') {
    return `Bus ${route?.shortName ?? routeId ?? ''}`.trim()
  }

  if (mode === 'metro') {
    return `Métro ligne ${route?.shortName ?? routeId ?? ''}`.trim()
  }

  return `REM ${route?.shortName?.replace(/^S/, 'A') ?? routeId?.replace(/^S/, 'A') ?? ''}`.trim()
}

function buildTransitSummary(segments: ItinerarySegment[]) {
  const rideLabels = segments
    .filter((segment) => segment.kind === 'ride')
    .map((segment) => segment.label)

  if (rideLabels.length === 0) {
    return 'Transit'
  }

  return `Marche + ${rideLabels.join(' + ')} + marche`
}

function buildSurfaceSegment(input: {
  id: string
  kind: 'walk' | 'bike'
  mode: 'walking' | 'cycling' | 'bixi'
  label: string
  from: ItineraryPlace
  to: ItineraryPlace
  durationMin: number
  distanceKm: number
  geometry: [number, number][]
  stationId?: string
  stationName?: string
  bikesAvailable?: number
  docksAvailable?: number
}) {
  return {
    ...input,
    durationMin: Math.round(input.durationMin),
    distanceKm: round1(input.distanceKm),
  } satisfies ItinerarySegment
}

function buildBixiRideSegment(input: {
  id: string
  label: string
  from: ItineraryPlace
  to: ItineraryPlace
  durationMin: number
  distanceKm: number
  geometry: [number, number][]
  stationId?: string
  stationName?: string
  bikesAvailable?: number
  docksAvailable?: number
}) {
  return {
    ...input,
    kind: 'bike',
    mode: 'bixi',
    durationMin: Math.round(input.durationMin),
    distanceKm: round1(input.distanceKm),
  } satisfies ItinerarySegment
}

function estimateWalkingDuration(distanceKm: number) {
  return (distanceKm / 4.8) * 60
}

function toItineraryPlace(place: {
  label?: string
  name?: string
  address?: string
  lat: number
  lon: number
}) {
  return {
    label: place.label || place.name || place.address || 'Point',
    lat: place.lat,
    lon: place.lon,
  } satisfies ItineraryPlace
}

function mergeGeometries(
  first: [number, number][],
  second: [number, number][],
) {
  if (first.length === 0) {
    return second
  }

  if (second.length === 0) {
    return first
  }

  const lastFirst = first.at(-1)
  const firstSecond = second[0]
  if (
    lastFirst &&
    firstSecond &&
    lastFirst[0] === firstSecond[0] &&
    lastFirst[1] === firstSecond[1]
  ) {
    return [...first, ...second.slice(1)]
  }

  return [...first, ...second]
}

function round1(value: number) {
  return Number(value.toFixed(1))
}

function modeLabel(mode: ItineraryMode) {
  if (mode === 'walking') return 'Marche'
  if (mode === 'transit') return 'Transit'
  if (mode === 'cycling') return 'Vélo'
  return 'BIXI'
}
