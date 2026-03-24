const EARTH_RADIUS_KM = 6371

export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
) {
  const toRadians = (value: number) => (value * Math.PI) / 180
  const dLat = toRadians(lat2 - lat1)
  const dLon = toRadians(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2)

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a))
}

export function polylineLengthKm(coordinates: [number, number][]) {
  let length = 0

  for (let index = 1; index < coordinates.length; index += 1) {
    const [previousLon, previousLat] = coordinates[index - 1]
    const [currentLon, currentLat] = coordinates[index]

    length += haversineKm(previousLat, previousLon, currentLat, currentLon)
  }

  return length
}

export function cumulativePolylineDistances(coordinates: [number, number][]) {
  const distances = [0]

  for (let index = 1; index < coordinates.length; index += 1) {
    const [previousLon, previousLat] = coordinates[index - 1]
    const [currentLon, currentLat] = coordinates[index]
    const segment = haversineKm(previousLat, previousLon, currentLat, currentLon)

    distances.push(distances[index - 1] + segment)
  }

  return distances
}

export function interpolateAlongPolyline(
  coordinates: [number, number][],
  distances: number[],
  targetDistanceKm: number,
) {
  if (coordinates.length === 0) {
    return [0, 0] as [number, number]
  }

  if (targetDistanceKm <= 0) {
    return coordinates[0]
  }

  const maxDistance = distances.at(-1) ?? 0
  if (targetDistanceKm >= maxDistance) {
    return coordinates.at(-1) ?? coordinates[0]
  }

  for (let index = 1; index < distances.length; index += 1) {
    const previousDistance = distances[index - 1]
    const currentDistance = distances[index]
    if (targetDistanceKm > currentDistance) {
      continue
    }

    const segmentProgress =
      currentDistance === previousDistance
        ? 0
        : (targetDistanceKm - previousDistance) /
          (currentDistance - previousDistance)

    const [previousLon, previousLat] = coordinates[index - 1]
    const [currentLon, currentLat] = coordinates[index]

    return [
      previousLon + (currentLon - previousLon) * segmentProgress,
      previousLat + (currentLat - previousLat) * segmentProgress,
    ] as [number, number]
  }

  return coordinates.at(-1) ?? coordinates[0]
}

export function simplifyCoordinates(
  coordinates: [number, number][],
  maxPoints: number,
) {
  if (coordinates.length <= maxPoints) {
    return coordinates
  }

  const step = Math.ceil(coordinates.length / maxPoints)
  const simplified: [number, number][] = []

  for (let index = 0; index < coordinates.length; index += step) {
    simplified.push(coordinates[index])
  }

  const lastPoint = coordinates.at(-1)
  if (lastPoint && simplified.at(-1) !== lastPoint) {
    simplified.push(lastPoint)
  }

  return simplified
}

export function computeBounds(points: [number, number][]) {
  if (points.length === 0) {
    return [
      [-73.9, 45.35],
      [-73.35, 45.7],
    ] as [[number, number], [number, number]]
  }

  let minLon = Number.POSITIVE_INFINITY
  let minLat = Number.POSITIVE_INFINITY
  let maxLon = Number.NEGATIVE_INFINITY
  let maxLat = Number.NEGATIVE_INFINITY

  for (const [lon, lat] of points) {
    minLon = Math.min(minLon, lon)
    minLat = Math.min(minLat, lat)
    maxLon = Math.max(maxLon, lon)
    maxLat = Math.max(maxLat, lat)
  }

  return [
    [minLon, minLat],
    [maxLon, maxLat],
  ] as [[number, number], [number, number]]
}

export function pointToSegmentDistanceKm(
  point: [number, number],
  start: [number, number],
  end: [number, number],
) {
  const [pointLon, pointLat] = point
  const [startLon, startLat] = start
  const [endLon, endLat] = end
  const scale = Math.cos((pointLat * Math.PI) / 180)

  const px = pointLon * scale
  const py = pointLat
  const sx = startLon * scale
  const sy = startLat
  const ex = endLon * scale
  const ey = endLat

  const dx = ex - sx
  const dy = ey - sy
  const denominator = dx * dx + dy * dy

  if (denominator === 0) {
    return haversineKm(pointLat, pointLon, startLat, startLon)
  }

  const projection = Math.max(
    0,
    Math.min(1, ((px - sx) * dx + (py - sy) * dy) / denominator),
  )

  const closestLon = (sx + projection * dx) / scale
  const closestLat = sy + projection * dy

  return haversineKm(pointLat, pointLon, closestLat, closestLon)
}

export function pointToPolylineDistanceKm(
  point: [number, number],
  coordinates: [number, number][],
) {
  if (coordinates.length === 0) {
    return Number.POSITIVE_INFINITY
  }

  if (coordinates.length === 1) {
    const [lon, lat] = coordinates[0]
    return haversineKm(point[1], point[0], lat, lon)
  }

  let minimum = Number.POSITIVE_INFINITY

  for (let index = 1; index < coordinates.length; index += 1) {
    const distance = pointToSegmentDistanceKm(
      point,
      coordinates[index - 1],
      coordinates[index],
    )

    minimum = Math.min(minimum, distance)
  }

  return minimum
}

export function projectPointToPolyline(
  point: [number, number],
  coordinates: [number, number][],
) {
  if (coordinates.length === 0) {
    return {
      distanceKm: Number.POSITIVE_INFINITY,
      distanceAlongKm: 0,
      coordinate: [0, 0] as [number, number],
    }
  }

  if (coordinates.length === 1) {
    const [lon, lat] = coordinates[0]
    return {
      distanceKm: haversineKm(point[1], point[0], lat, lon),
      distanceAlongKm: 0,
      coordinate: coordinates[0],
    }
  }

  const scale = Math.cos((point[1] * Math.PI) / 180)
  let minimum = Number.POSITIVE_INFINITY
  let distanceAlongKm = 0
  let traveledKm = 0
  let bestCoordinate = coordinates[0]

  for (let index = 1; index < coordinates.length; index += 1) {
    const start = coordinates[index - 1]
    const end = coordinates[index]
    const [startLon, startLat] = start
    const [endLon, endLat] = end
    const [pointLon, pointLat] = point

    const px = pointLon * scale
    const py = pointLat
    const sx = startLon * scale
    const sy = startLat
    const ex = endLon * scale
    const ey = endLat

    const dx = ex - sx
    const dy = ey - sy
    const denominator = dx * dx + dy * dy
    const projection =
      denominator === 0
        ? 0
        : Math.max(
            0,
            Math.min(1, ((px - sx) * dx + (py - sy) * dy) / denominator),
          )

    const closestLon = (sx + projection * dx) / scale
    const closestLat = sy + projection * dy
    const distanceKm = haversineKm(pointLat, pointLon, closestLat, closestLon)
    const segmentLengthKm = haversineKm(startLat, startLon, endLat, endLon)

    if (distanceKm < minimum) {
      minimum = distanceKm
      distanceAlongKm = traveledKm + segmentLengthKm * projection
      bestCoordinate = [closestLon, closestLat]
    }

    traveledKm += segmentLengthKm
  }

  return {
    distanceKm: minimum,
    distanceAlongKm,
    coordinate: bestCoordinate,
  }
}
