import {
  cumulativePolylineDistances,
  haversineKm,
  projectPointToPolyline,
  slicePolylineAlongDistances,
} from '../../../src/shared/geo.ts'
import type {
  BixiStation,
  BootstrapResponse,
  GeoPoint,
  Itinerary,
  ItineraryPlace,
  ItinerarySegment,
  PlanResponse,
  ResolvedPlace,
  RouteSummary,
  ShapeFeature,
  StationSummary,
} from '../../../src/shared/types.ts'
import { getBixiData } from './bixi.ts'
import { getBootstrapData } from './data.ts'
import {
  estimateSurfacePath,
  resolvePlace,
  routeSurfacePath,
} from './places.ts'

interface TransitEdge {
  to: string
  kind: 'ride' | 'walk'
  mode: 'metro' | 'rem' | 'walking'
  routeId?: string
  distanceKm: number
  durationMin: number
  geometry: [number, number][]
}

interface GraphCandidate {
  station: StationSummary
  access: number
}

interface PathStep {
  from: string
  to: string
  edge: TransitEdge
}

interface TransitGraph {
  bootstrap: BootstrapResponse
  graph: Map<string, TransitEdge[]>
  stationsById: Map<string, StationSummary>
  routesById: Map<string, RouteSummary>
}

const TRANSFER_DISTANCE_KM = 0.4
const TRANSIT_ACCESS_LIMIT_KM = 3.2
const BIXI_ACCESS_LIMIT_KM = 1.8

let transitGraphCache:
  | {
      generatedAt: string
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
  modes?: Array<'walking' | 'transit' | 'bixi'>
}) {
  const origin = await resolvePlace({
    query: input.from,
    lat: input.fromLat,
    lon: input.fromLon,
    label: input.from,
  })
  const destination = await resolvePlace({
    query: input.to,
    lat: input.toLat,
    lon: input.toLon,
    label: input.to,
  })
  const modes = input.modes && input.modes.length > 0
    ? Array.from(new Set(input.modes))
    : (['walking', 'transit', 'bixi'] as const)

  const warnings: string[] = []
  const itineraries: Itinerary[] = []

  for (const mode of modes) {
    try {
      if (mode === 'walking') {
        itineraries.push(await buildWalkingItinerary(origin, destination))
      } else if (mode === 'transit') {
        const itinerary = await buildTransitItinerary(origin, destination)
        if (itinerary) {
          itineraries.push(itinerary)
        } else {
          warnings.push('Aucun itinéraire transit viable trouvé entre ces adresses.')
        }
      } else {
        const itinerary = await buildBixiItinerary(origin, destination)
        if (itinerary) {
          itineraries.push(itinerary)
        } else {
          warnings.push('Aucun itinéraire BIXI viable trouvé entre ces adresses.')
        }
      }
    } catch (error) {
      warnings.push(
        `${modeLabel(mode)} indisponible: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

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

async function buildTransitItinerary(
  origin: ResolvedPlace,
  destination: ResolvedPlace,
) {
  const graph = await getTransitGraph()
  const originCandidates = pickTransitCandidates(origin, graph.bootstrap.stations)
  const destinationCandidates = pickTransitCandidates(
    destination,
    graph.bootstrap.stations,
  )

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
        originCandidate.station.id,
        destinationCandidate.station.id,
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

  const accessRoute = await routeSurfacePath(origin, best.originCandidate.station, 'walking')
  const egressRoute = await routeSurfacePath(
    best.destinationCandidate.station,
    destination,
    'walking',
  )
  const rideSegments = collapseTransitPath(
    best.path,
    graph.stationsById,
    graph.routesById,
  )

  const segments: ItinerarySegment[] = [
    buildSurfaceSegment({
      id: 'transit:walk:start',
      kind: 'walk',
      mode: 'walking',
      label: `Marcher jusqu’à ${best.originCandidate.station.name}`,
      from: toItineraryPlace(origin),
      to: toItineraryPlace(best.originCandidate.station),
      distanceKm: accessRoute.distanceKm,
      durationMin: accessRoute.durationMin,
      geometry: accessRoute.geometry,
      stationId: best.originCandidate.station.id,
      stationName: best.originCandidate.station.name,
    }),
    ...rideSegments,
    buildSurfaceSegment({
      id: 'transit:walk:end',
      kind: 'walk',
      mode: 'walking',
      label: `Marcher jusqu’à ${destination.label}`,
      from: toItineraryPlace(best.destinationCandidate.station),
      to: toItineraryPlace(destination),
      distanceKm: egressRoute.distanceKm,
      durationMin: egressRoute.durationMin,
      geometry: egressRoute.geometry,
      stationId: best.destinationCandidate.station.id,
      stationName: best.destinationCandidate.station.name,
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
  const bootstrap = await getBootstrapData()
  if (transitGraphCache?.generatedAt === bootstrap.generatedAt) {
    return transitGraphCache.value
  }

  const graph = new Map<string, TransitEdge[]>()
  const stationsById = new Map(bootstrap.stations.map((station) => [station.id, station]))
  const routesById = new Map(bootstrap.routes.map((route) => [route.id, route]))
  const shapesById = new Map(bootstrap.shapes.map((shape) => [shape.id, shape]))

  for (const station of bootstrap.stations) {
    graph.set(station.id, [])
  }

  for (const route of bootstrap.routes) {
    if (route.mode === 'bus') {
      continue
    }

    const railRoute = route as RouteSummary & { mode: 'metro' | 'rem' }

    for (const shapeId of railRoute.shapeIds) {
      const shape = shapesById.get(shapeId)
      if (!shape) {
        continue
      }

      attachRouteShapeEdges(graph, railRoute, shape, stationsById)
    }
  }

  attachTransferEdges(graph, bootstrap.stations)

  const value = {
    bootstrap,
    graph,
    stationsById,
    routesById,
  } satisfies TransitGraph

  transitGraphCache = {
    generatedAt: bootstrap.generatedAt,
    value,
  }

  return value
}

function attachRouteShapeEdges(
  graph: Map<string, TransitEdge[]>,
  route: RouteSummary & { mode: 'metro' | 'rem' },
  shape: ShapeFeature,
  stationsById: Map<string, StationSummary>,
) {
  const distances = cumulativePolylineDistances(shape.coordinates)
  const orderedStations = route.stationIds
    .map((stationId) => stationsById.get(stationId))
    .filter((station): station is StationSummary => Boolean(station))
    .map((station) => ({
      station,
      projection: projectPointToPolyline([station.lon, station.lat], shape.coordinates),
    }))
    .filter((entry) => Number.isFinite(entry.projection.distanceKm))
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

    if (distanceKm <= 0.05) {
      continue
    }

    const geometry = slicePolylineAlongDistances(
      shape.coordinates,
      distances,
      previous.projection.distanceAlongKm,
      current.projection.distanceAlongKm,
    )
    const durationMin = estimateRideDuration(distanceKm, route.mode)

    addTransitEdge(graph, previous.station.id, {
      to: current.station.id,
      kind: 'ride',
      mode: route.mode,
      routeId: route.id,
      distanceKm,
      durationMin,
      geometry,
    })

    addTransitEdge(graph, current.station.id, {
      to: previous.station.id,
      kind: 'ride',
      mode: route.mode,
      routeId: route.id,
      distanceKm,
      durationMin,
      geometry: [...geometry].reverse() as [number, number][],
    })
  }
}

function attachTransferEdges(
  graph: Map<string, TransitEdge[]>,
  stations: StationSummary[],
) {
  for (let leftIndex = 0; leftIndex < stations.length; leftIndex += 1) {
    const left = stations[leftIndex]
    for (let rightIndex = leftIndex + 1; rightIndex < stations.length; rightIndex += 1) {
      const right = stations[rightIndex]
      const distanceKm = haversineKm(left.lat, left.lon, right.lat, right.lon)
      const sameName = normalizeName(left.name) === normalizeName(right.name)

      if (!sameName && distanceKm > TRANSFER_DISTANCE_KM) {
        continue
      }

      const effectiveDistanceKm = Math.max(distanceKm, 0.05)
      const durationMin = estimateWalkingDuration(effectiveDistanceKm) + 2
      const geometry = [
        [left.lon, left.lat],
        [right.lon, right.lat],
      ] as [number, number][]

      addTransitEdge(graph, left.id, {
        to: right.id,
        kind: 'walk',
        mode: 'walking',
        distanceKm: effectiveDistanceKm,
        durationMin,
        geometry,
      })

      addTransitEdge(graph, right.id, {
        to: left.id,
        kind: 'walk',
        mode: 'walking',
        distanceKm: effectiveDistanceKm,
        durationMin,
        geometry: [...geometry].reverse() as [number, number][],
      })
    }
  }
}

function pickTransitCandidates(place: GeoPoint, stations: StationSummary[]) {
  return stations
    .map((station) => ({
      station,
      distanceKm: haversineKm(place.lat, place.lon, station.lat, station.lon),
    }))
    .filter((entry) => entry.distanceKm <= TRANSIT_ACCESS_LIMIT_KM)
    .sort((left, right) => left.distanceKm - right.distanceKm)
    .slice(0, 5)
    .map<GraphCandidate>((entry) => ({
      station: entry.station,
      access: estimateWalkingDuration(entry.distanceKm * 1.18),
    }))
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
  graph: Map<string, TransitEdge[]>,
  originId: string,
  destinationId: string,
) {
  const queue = [{ stationId: originId, durationMin: 0 }]
  const bestDuration = new Map<string, number>([[originId, 0]])
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
  stationsById: Map<string, StationSummary>,
  routesById: Map<string, RouteSummary>,
) {
  const segments: ItinerarySegment[] = []

  for (const step of path) {
    const fromStation = stationsById.get(step.from)
    const toStation = stationsById.get(step.to)
    if (!fromStation || !toStation) {
      continue
    }

    if (step.edge.kind === 'ride') {
      const route = step.edge.routeId ? routesById.get(step.edge.routeId) : null
      const label =
        route?.mode === 'metro'
          ? `Métro ligne ${route.shortName}`
          : `REM ${route?.shortName?.replace(/^S/, 'A') ?? step.edge.routeId ?? ''}`.trim()

      const previousSegment = segments.at(-1)
      if (
        previousSegment &&
        previousSegment.kind === 'ride' &&
        previousSegment.routeId === step.edge.routeId
      ) {
        previousSegment.to = toItineraryPlace(toStation)
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
        id: `ride:${step.edge.routeId}:${step.from}:${step.to}`,
        kind: 'ride',
        mode: step.edge.mode,
        label,
        from: toItineraryPlace(fromStation),
        to: toItineraryPlace(toStation),
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
      from: toItineraryPlace(fromStation),
      to: toItineraryPlace(toStation),
      durationMin: Math.round(step.edge.durationMin),
      distanceKm: round1(step.edge.distanceKm),
      geometry: step.edge.geometry,
    })
  }

  return segments
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

function addTransitEdge(graph: Map<string, TransitEdge[]>, from: string, edge: TransitEdge) {
  const bucket = graph.get(from) ?? []
  const duplicate = bucket.some(
    (candidate) =>
      candidate.to === edge.to &&
      candidate.routeId === edge.routeId &&
      candidate.kind === edge.kind &&
      Math.abs(candidate.distanceKm - edge.distanceKm) < 0.02,
  )

  if (!duplicate) {
    bucket.push(edge)
    graph.set(from, bucket)
  }
}

function buildSurfaceSegment(input: {
  id: string
  kind: 'walk' | 'bike'
  mode: 'walking' | 'bixi'
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

function estimateRideDuration(distanceKm: number, mode: 'metro' | 'rem') {
  const speedKmH = mode === 'rem' ? 40 : 30
  const dwellMin = mode === 'rem' ? 0.7 : 1.1
  return (distanceKm / speedKmH) * 60 + dwellMin
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

function normalizeName(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
}

function round1(value: number) {
  return Number(value.toFixed(1))
}

function modeLabel(mode: 'walking' | 'transit' | 'bixi') {
  if (mode === 'walking') return 'Marche'
  if (mode === 'transit') return 'Transit'
  return 'BIXI'
}
