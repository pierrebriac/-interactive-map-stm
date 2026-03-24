import { useEffect, useRef } from 'react'
import type {
  Feature,
  FeatureCollection,
  LineString,
  Point,
} from 'geojson'
import maplibregl, {
  type GeoJSONSource,
  type GeoJSONSourceSpecification,
  type Map,
} from 'maplibre-gl'
import type {
  BootstrapResponse,
  FavoriteItem,
  Itinerary,
  LiveEntity,
  LiveResponse,
  MapStyle,
  ResolvedPlace,
  RouteSummary,
  SearchItem,
  ShapeFeature,
  StationSummary,
  ViewMode,
} from '../shared/types.ts'
import { getMapStyle } from '../lib/map-style.ts'

export type MapCameraRequest =
  | {
      id: string
      kind: 'bounds'
      points: [number, number][]
      padding?: number
      duration?: number
    }
  | {
      id: string
      kind: 'center'
      center: [number, number]
      zoom: number
      duration?: number
    }

interface MapViewProps {
  bootstrap: BootstrapResponse | null
  live: LiveResponse | null
  selectedItem: SearchItem | FavoriteItem | null
  selectedPlace: ResolvedPlace | null
  itinerary: Itinerary | null
  viewMode: ViewMode
  mapStyle: MapStyle
  routeFocusIds: string[]
  cameraRequest: MapCameraRequest | null
  onSelectItem: (item: SearchItem) => void
}

const EMPTY_COLLECTION = {
  type: 'FeatureCollection',
  features: [],
} satisfies FeatureCollection

export function MapView({
  bootstrap,
  live,
  selectedItem,
  selectedPlace,
  itinerary,
  viewMode,
  mapStyle,
  routeFocusIds,
  cameraRequest,
  onSelectItem,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<Map | null>(null)
  const initialStyleRef = useRef<MapStyle>(mapStyle)
  const activeStyleRef = useRef<MapStyle>(mapStyle)
  const latestRef = useRef({
    bootstrap,
    live,
    selectedItem,
    selectedPlace,
    itinerary,
    viewMode,
    routeFocusIds,
    onSelectItem,
  })

  useEffect(() => {
    latestRef.current = {
      bootstrap,
      live,
      selectedItem,
      selectedPlace,
      itinerary,
      viewMode,
      routeFocusIds,
      onSelectItem,
    }
  }, [bootstrap, live, onSelectItem, itinerary, routeFocusIds, selectedItem, selectedPlace, viewMode])

  useEffect(() => {
    if (!containerRef.current || mapRef.current) {
      return
    }

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: getMapStyle(initialStyleRef.current),
      center: [-73.58, 45.52],
      zoom: 10.4,
      attributionControl: false,
    })

    const syncMapData = () => {
      const current = latestRef.current
      const routeSource = map.getSource('routes') as GeoJSONSource | undefined
      const stationSource = map.getSource('stations') as GeoJSONSource | undefined
      const busSource = map.getSource('buses') as GeoJSONSource | undefined
      const railSource = map.getSource('rail-vehicles') as GeoJSONSource | undefined
      const itinerarySource = map.getSource('itinerary-lines') as GeoJSONSource | undefined
      const itineraryPointSource = map.getSource('itinerary-points') as GeoJSONSource | undefined
      const placeSource = map.getSource('selected-place') as GeoJSONSource | undefined

      if (!routeSource || !stationSource || !busSource || !railSource || !itinerarySource || !itineraryPointSource || !placeSource) {
        return
      }

      routeSource.setData(
        buildRouteCollection(
          current.bootstrap,
          current.viewMode,
          current.selectedItem,
          current.routeFocusIds,
        ),
      )
      stationSource.setData(
        buildStationCollection(current.bootstrap, current.viewMode, current.selectedItem),
      )
      busSource.setData(
        buildBusCollection(current.live, current.selectedItem, current.routeFocusIds),
      )
      railSource.setData(
        buildRailCollection(current.live, current.selectedItem, current.routeFocusIds),
      )
      itinerarySource.setData(buildItineraryCollection(current.itinerary))
      itineraryPointSource.setData(buildItineraryPointCollection(current.itinerary))
      placeSource.setData(buildSelectedPlaceCollection(current.selectedPlace))
    }

    const selectRouteById = (routeId: string) => {
      const route = latestRef.current.bootstrap?.routes.find((entry) => entry.id === routeId)
      if (!route) {
        return
      }

      latestRef.current.onSelectItem(toRouteSearchItem(route))
    }

    const selectStationById = (stationId: string) => {
      const station = latestRef.current.bootstrap?.stations.find((entry) => entry.id === stationId)
      if (!station) {
        return
      }

      latestRef.current.onSelectItem(toStationSearchItem(station))
    }

    const handleClusterClick = (event: maplibregl.MapLayerMouseEvent) => {
      const feature = event.features?.[0]
      const clusterId = feature?.properties?.cluster_id
      const source = map.getSource('buses') as GeoJSONSource | undefined

      if (!source || clusterId === undefined) {
        return
      }

      void source.getClusterExpansionZoom(Number(clusterId)).then((zoom) => {
        const [lon, lat] = (feature?.geometry as Point).coordinates
        map.easeTo({
          center: [lon, lat],
          zoom,
          duration: 500,
        })
      })
    }

    const handleRouteClick = (event: maplibregl.MapLayerMouseEvent) => {
      const routeId = `${event.features?.[0]?.properties?.routeId ?? ''}`
      if (routeId) {
        selectRouteById(routeId)
      }
    }

    const handleStationClick = (event: maplibregl.MapLayerMouseEvent) => {
      const stationId = `${event.features?.[0]?.properties?.id ?? ''}`
      if (stationId) {
        selectStationById(stationId)
      }
    }

    const setPointer = () => {
      map.getCanvas().style.cursor = 'pointer'
    }

    const clearPointer = () => {
      map.getCanvas().style.cursor = ''
    }

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right')

    map.on('load', () => {
      ensureLayers(map)
      syncMapData()
    })

    map.on('style.load', () => {
      ensureLayers(map)
      syncMapData()
    })

    map.on('click', 'bus-clusters', handleClusterClick)
    map.on('click', 'bus-points', handleRouteClick)
    map.on('click', 'rail-points', handleRouteClick)
    map.on('click', 'route-lines', handleRouteClick)
    map.on('click', 'stations', handleStationClick)

    for (const layerId of ['bus-clusters', 'bus-points', 'rail-points', 'route-lines', 'stations']) {
      map.on('mouseenter', layerId, setPointer)
      map.on('mouseleave', layerId, clearPointer)
    }

    mapRef.current = map
    activeStyleRef.current = initialStyleRef.current

    return () => {
      map.off('click', 'bus-clusters', handleClusterClick)
      map.off('click', 'bus-points', handleRouteClick)
      map.off('click', 'rail-points', handleRouteClick)
      map.off('click', 'route-lines', handleRouteClick)
      map.off('click', 'stations', handleStationClick)

      for (const layerId of ['bus-clusters', 'bus-points', 'rail-points', 'route-lines', 'stations']) {
        map.off('mouseenter', layerId, setPointer)
        map.off('mouseleave', layerId, clearPointer)
      }

      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || activeStyleRef.current === mapStyle) {
      return
    }

    activeStyleRef.current = mapStyle
    map.setStyle(getMapStyle(mapStyle))
  }, [mapStyle])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded()) {
      return
    }

    const routeSource = map.getSource('routes') as GeoJSONSource | undefined
    const stationSource = map.getSource('stations') as GeoJSONSource | undefined
    const busSource = map.getSource('buses') as GeoJSONSource | undefined
    const railSource = map.getSource('rail-vehicles') as GeoJSONSource | undefined
    const itinerarySource = map.getSource('itinerary-lines') as GeoJSONSource | undefined
    const itineraryPointSource = map.getSource('itinerary-points') as GeoJSONSource | undefined
    const placeSource = map.getSource('selected-place') as GeoJSONSource | undefined

    if (!routeSource || !stationSource || !busSource || !railSource || !itinerarySource || !itineraryPointSource || !placeSource) {
      return
    }

    routeSource.setData(buildRouteCollection(bootstrap, viewMode, selectedItem, routeFocusIds))
    stationSource.setData(buildStationCollection(bootstrap, viewMode, selectedItem))
    busSource.setData(buildBusCollection(live, selectedItem, routeFocusIds))
    railSource.setData(buildRailCollection(live, selectedItem, routeFocusIds))
    itinerarySource.setData(buildItineraryCollection(itinerary))
    itineraryPointSource.setData(buildItineraryPointCollection(itinerary))
    placeSource.setData(buildSelectedPlaceCollection(selectedPlace))
  }, [bootstrap, itinerary, live, routeFocusIds, selectedItem, selectedPlace, viewMode])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !cameraRequest) {
      return
    }

    if (cameraRequest.kind === 'center') {
      map.easeTo({
        center: cameraRequest.center,
        zoom: cameraRequest.zoom,
        duration: cameraRequest.duration ?? 700,
      })
      return
    }

    if (cameraRequest.points.length === 0) {
      return
    }

    let minLon = Number.POSITIVE_INFINITY
    let minLat = Number.POSITIVE_INFINITY
    let maxLon = Number.NEGATIVE_INFINITY
    let maxLat = Number.NEGATIVE_INFINITY

    for (const [lon, lat] of cameraRequest.points) {
      minLon = Math.min(minLon, lon)
      minLat = Math.min(minLat, lat)
      maxLon = Math.max(maxLon, lon)
      maxLat = Math.max(maxLat, lat)
    }

    map.fitBounds(
      [
        [minLon, minLat],
        [maxLon, maxLat],
      ],
      {
        padding: cameraRequest.padding ?? 96,
        duration: cameraRequest.duration ?? 750,
      },
    )
  }, [cameraRequest])

  return <div className="map-shell" ref={containerRef} />
}

function ensureLayers(map: Map) {
  addGeoJsonSource(map, 'routes', { ...EMPTY_COLLECTION })
  addGeoJsonSource(map, 'stations', { ...EMPTY_COLLECTION })
  addGeoJsonSource(
    map,
    'buses',
    { ...EMPTY_COLLECTION },
    { cluster: true, clusterRadius: 38, clusterMaxZoom: 11 },
  )
  addGeoJsonSource(map, 'rail-vehicles', { ...EMPTY_COLLECTION })
  addGeoJsonSource(map, 'itinerary-lines', { ...EMPTY_COLLECTION })
  addGeoJsonSource(map, 'itinerary-points', { ...EMPTY_COLLECTION })
  addGeoJsonSource(map, 'selected-place', { ...EMPTY_COLLECTION })

  addLayerIfMissing(map, {
    id: 'route-lines',
    type: 'line',
    source: 'routes',
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['coalesce', ['get', 'lineWidth'], 3.2],
      'line-opacity': ['coalesce', ['get', 'opacity'], 0.88],
    },
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
    },
  })

  addLayerIfMissing(map, {
    id: 'route-labels',
    type: 'symbol',
    source: 'routes',
    layout: {
      'symbol-placement': 'line-center',
      'text-field': ['get', 'label'],
      'text-font': ['Open Sans Semibold'],
      'text-size': 11,
      'symbol-spacing': 280,
    },
    paint: {
      'text-color': '#f7f7f2',
      'text-halo-color': '#12202a',
      'text-halo-width': 1,
      'text-opacity': ['coalesce', ['get', 'textOpacity'], 0.86],
    },
  })

  addLayerIfMissing(map, {
    id: 'stations',
    type: 'circle',
    source: 'stations',
    paint: {
      'circle-radius': ['coalesce', ['get', 'radius'], 4.2],
      'circle-color': ['get', 'color'],
      'circle-stroke-width': 1.6,
      'circle-stroke-color': '#fffdf8',
    },
  })

  addLayerIfMissing(map, {
    id: 'station-labels',
    type: 'symbol',
    source: 'stations',
    minzoom: 11,
    layout: {
      'text-field': ['get', 'label'],
      'text-font': ['Open Sans Regular'],
      'text-size': 11,
      'text-offset': [0, 1.15],
    },
    paint: {
      'text-color': '#1c2c35',
      'text-halo-color': '#f8f5ef',
      'text-halo-width': 1.1,
    },
  })

  addLayerIfMissing(map, {
    id: 'bus-clusters',
    type: 'circle',
    source: 'buses',
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': '#1468ff',
      'circle-radius': ['step', ['get', 'point_count'], 18, 30, 22, 100, 26],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#f7f4ee',
    },
  })

  addLayerIfMissing(map, {
    id: 'bus-cluster-count',
    type: 'symbol',
    source: 'buses',
    filter: ['has', 'point_count'],
    layout: {
      'text-field': ['get', 'point_count_abbreviated'],
      'text-font': ['Open Sans Bold'],
      'text-size': 12,
    },
    paint: {
      'text-color': '#fffefb',
    },
  })

  addLayerIfMissing(map, {
    id: 'bus-points',
    type: 'circle',
    source: 'buses',
    filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-radius': ['coalesce', ['get', 'radius'], 7.3],
      'circle-color': ['coalesce', ['get', 'color'], '#1468ff'],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#fffef7',
      'circle-opacity': ['coalesce', ['get', 'opacity'], 0.9],
    },
  })

  addLayerIfMissing(map, {
    id: 'bus-labels',
    type: 'symbol',
    source: 'buses',
    filter: ['!', ['has', 'point_count']],
    minzoom: 11,
    layout: {
      'text-field': ['get', 'label'],
      'text-font': ['Open Sans Bold'],
      'text-size': 10,
      'text-allow-overlap': true,
    },
    paint: {
      'text-color': '#fffef8',
      'text-halo-color': '#152027',
      'text-halo-width': 0.8,
      'text-opacity': ['coalesce', ['get', 'textOpacity'], 0.88],
    },
  })

  addLayerIfMissing(map, {
    id: 'rail-points',
    type: 'circle',
    source: 'rail-vehicles',
    paint: {
      'circle-radius': ['coalesce', ['get', 'radius'], 8.6],
      'circle-color': ['get', 'color'],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#fffef8',
      'circle-opacity': ['coalesce', ['get', 'opacity'], 0.94],
    },
  })

  addLayerIfMissing(map, {
    id: 'rail-labels',
    type: 'symbol',
    source: 'rail-vehicles',
    layout: {
      'text-field': ['get', 'label'],
      'text-font': ['Open Sans Bold'],
      'text-size': 10,
      'text-allow-overlap': true,
    },
    paint: {
      'text-color': '#fffef8',
      'text-halo-color': '#13222d',
      'text-halo-width': 0.7,
      'text-opacity': ['coalesce', ['get', 'textOpacity'], 0.88],
    },
  })

  addLayerIfMissing(map, {
    id: 'itinerary-lines',
    type: 'line',
    source: 'itinerary-lines',
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['coalesce', ['get', 'lineWidth'], 4.6],
      'line-opacity': 0.95,
    },
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
    },
  })

  addLayerIfMissing(map, {
    id: 'itinerary-points',
    type: 'circle',
    source: 'itinerary-points',
    paint: {
      'circle-radius': ['coalesce', ['get', 'radius'], 6.4],
      'circle-color': ['get', 'color'],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#fffef8',
    },
  })

  addLayerIfMissing(map, {
    id: 'selected-place',
    type: 'circle',
    source: 'selected-place',
    paint: {
      'circle-radius': 9,
      'circle-color': '#111318',
      'circle-stroke-width': 3,
      'circle-stroke-color': '#f7f4ef',
    },
  })
}

function addGeoJsonSource(
  map: Map,
  id: string,
  data: FeatureCollection,
  options: Partial<GeoJSONSourceSpecification> = {},
) {
  if (map.getSource(id)) {
    return
  }

  map.addSource(id, {
    type: 'geojson',
    data,
    ...options,
  })
}

function addLayerIfMissing(map: Map, layer: Parameters<Map['addLayer']>[0]) {
  if (!map.getLayer(layer.id)) {
    map.addLayer(layer)
  }
}

function visibleModes(viewMode: ViewMode) {
  return new Set(viewMode === 'combined' ? ['bus', 'metro', 'rem'] : [viewMode])
}

function buildRouteCollection(
  bootstrap: BootstrapResponse | null,
  viewMode: ViewMode,
  selectedItem: SearchItem | FavoriteItem | null,
  routeFocusIds: string[],
): FeatureCollection<LineString> {
  if (!bootstrap) {
    return EMPTY_COLLECTION
  }

  const modes = visibleModes(viewMode)
  const focusSet = new Set(routeFocusIds)
  const selectedRouteId = selectedItem?.type === 'route' ? selectedItem.id : null
  const selectedStationId = selectedItem?.type === 'station' ? selectedItem.id : null
  const selectedStationRoutes = new Set(
    bootstrap.stations.find((station) => station.id === selectedStationId)?.routeIds ?? [],
  )

  const shapes = bootstrap.shapes.filter((shape) => {
    if (selectedRouteId) {
      return shape.routeId === selectedRouteId || focusSet.has(shape.routeId)
    }

    if (selectedStationId) {
      return selectedStationRoutes.has(shape.routeId) || focusSet.has(shape.routeId)
    }

    if (focusSet.size > 0) {
      return focusSet.has(shape.routeId)
    }

    if (!modes.has(shape.mode)) {
      return false
    }

    return shape.mode !== 'bus'
  })

  return {
    type: 'FeatureCollection',
    features: shapes.map((shape) => {
      const route = bootstrap.routes.find((entry) => entry.id === shape.routeId)
      return routeToFeature(shape, route ?? null, {
        selectedRouteId,
        focusSet,
        selectedStationRoutes,
      })
    }),
  }
}

function buildStationCollection(
  bootstrap: BootstrapResponse | null,
  viewMode: ViewMode,
  selectedItem: SearchItem | FavoriteItem | null,
): FeatureCollection<Point> {
  if (!bootstrap) {
    return EMPTY_COLLECTION
  }

  const modes = visibleModes(viewMode)
  const selectedRouteId = selectedItem?.type === 'route' ? selectedItem.id : null
  const selectedStationId = selectedItem?.type === 'station' ? selectedItem.id : null

  const stations = bootstrap.stations.filter((station) => {
    if (!modes.has(station.mode)) {
      return false
    }

    if (selectedRouteId) {
      return station.routeIds.includes(selectedRouteId)
    }

    return station.mode !== 'metro' || station.routeIds.length > 0
  })

  return {
    type: 'FeatureCollection',
    features: stations.map((station) =>
      stationToFeature(station, selectedStationId === station.id),
    ),
  }
}

function buildBusCollection(
  live: LiveResponse | null,
  selectedItem: SearchItem | FavoriteItem | null,
  routeFocusIds: string[],
): FeatureCollection<Point> {
  const selectedRouteId = selectedItem?.type === 'route' ? selectedItem.id : null
  const focusSet = new Set(routeFocusIds)
  const entities = live?.entities.filter((entity) => entity.mode === 'bus') ?? []

  return {
    type: 'FeatureCollection',
    features: entities.map((entity) => {
      const isSelected = selectedRouteId === entity.routeId
      const isFocused = focusSet.size === 0 || focusSet.has(entity.routeId)

      return {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [entity.lon, entity.lat],
        },
        properties: {
          id: entity.id,
          routeId: entity.routeId,
          label: entity.label,
          color: isSelected ? '#0f1720' : '#1468ff',
          radius: isSelected ? 9.5 : isFocused ? 7.6 : 5.8,
          opacity: isSelected ? 0.98 : isFocused ? 0.9 : 0.16,
          textOpacity: isSelected ? 0.9 : isFocused ? 0.82 : 0.1,
        },
      }
    }),
  }
}

function buildRailCollection(
  live: LiveResponse | null,
  selectedItem: SearchItem | FavoriteItem | null,
  routeFocusIds: string[],
): FeatureCollection<Point> {
  const selectedRouteId = selectedItem?.type === 'route' ? selectedItem.id : null
  const focusSet = new Set(routeFocusIds)
  const entities =
    live?.entities.filter(
      (entity): entity is LiveEntity & { mode: 'metro' | 'rem' } =>
        entity.mode === 'metro' || entity.mode === 'rem',
    ) ?? []

  return {
    type: 'FeatureCollection',
    features: entities.map((entity) => {
      const isSelected = selectedRouteId === entity.routeId
      const isFocused = focusSet.size === 0 || focusSet.has(entity.routeId)

      return {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [entity.lon, entity.lat],
        },
        properties: {
          id: entity.id,
          routeId: entity.routeId,
          label: entity.label,
          color: routeColorForMode(entity.routeId, entity.mode),
          radius: isSelected ? 10 : 8,
          opacity: isFocused ? 0.95 : 0.22,
          textOpacity: isFocused ? 0.88 : 0.14,
        },
      }
    }),
  }
}

function buildItineraryCollection(
  itinerary: Itinerary | null,
): FeatureCollection<LineString> {
  if (!itinerary) {
    return EMPTY_COLLECTION
  }

  return {
    type: 'FeatureCollection',
    features: itinerary.segments.map((segment) => ({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: segment.geometry,
      },
      properties: {
        id: segment.id,
        color: itineraryColor(segment.mode),
        lineWidth: segment.kind === 'walk' ? 3.6 : 4.9,
      },
    })),
  }
}

function buildItineraryPointCollection(
  itinerary: Itinerary | null,
): FeatureCollection<Point> {
  if (!itinerary || itinerary.segments.length === 0) {
    return EMPTY_COLLECTION
  }

  const firstSegment = itinerary.segments[0]
  const lastSegment = itinerary.segments.at(-1)

  if (!firstSegment || !lastSegment) {
    return EMPTY_COLLECTION
  }

  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [firstSegment.from.lon, firstSegment.from.lat],
        },
        properties: {
          color: '#111318',
          radius: 7,
        },
      },
      {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [lastSegment.to.lon, lastSegment.to.lat],
        },
        properties: {
          color: '#f25f4c',
          radius: 7,
        },
      },
    ],
  }
}

function buildSelectedPlaceCollection(
  selectedPlace: ResolvedPlace | null,
): FeatureCollection<Point> {
  if (!selectedPlace) {
    return EMPTY_COLLECTION
  }

  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [selectedPlace.lon, selectedPlace.lat],
        },
        properties: {},
      },
    ],
  }
}

function routeToFeature(
  shape: ShapeFeature,
  route: RouteSummary | null,
  input: {
    selectedRouteId: string | null
    focusSet: Set<string>
    selectedStationRoutes: Set<string>
  },
): Feature<LineString> {
  const isSelected = input.selectedRouteId === shape.routeId
  const isFocused = input.focusSet.has(shape.routeId)
  const isStationContext = input.selectedStationRoutes.has(shape.routeId)
  const lineOpacity =
    isSelected ? 0.98 : isFocused ? 0.88 : isStationContext ? 0.72 : 0.34
  const textOpacity = isSelected || isFocused || isStationContext ? 0.88 : 0.18

  return {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: shape.coordinates,
    },
    properties: {
      routeId: shape.routeId,
      color: isSelected ? '#111318' : shape.color,
      label:
        shape.mode === 'bus'
          ? route?.shortName ?? ''
          : route?.shortName?.replace(/^S/, 'A') ?? shape.routeId.replace(/^S/, 'A'),
      lineWidth: isSelected ? 5.8 : isFocused ? 4.4 : shape.mode === 'bus' ? 3 : 3.2,
      opacity: lineOpacity,
      textOpacity,
    },
  }
}

function stationToFeature(
  station: StationSummary,
  selected: boolean,
): Feature<Point> {
  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [station.lon, station.lat],
    },
    properties: {
      id: station.id,
      label: station.name,
      color: station.mode === 'metro' ? '#0f9d58' : '#4f9d2f',
      radius: selected ? 6 : 4.4,
    },
  }
}

function routeColorForMode(routeId: string, mode: 'metro' | 'rem') {
  if (mode === 'metro') {
    if (routeId === '1') return '#f59e0b'
    if (routeId === '2') return '#ef4444'
    if (routeId === '4') return '#22c55e'
    return '#fbbf24'
  }

  return '#4f9d2f'
}

function itineraryColor(mode: Itinerary['segments'][number]['mode']) {
  if (mode === 'bus') return '#1468ff'
  if (mode === 'metro') return '#0f9d58'
  if (mode === 'rem') return '#4f9d2f'
  if (mode === 'cycling' || mode === 'bixi') return '#111318'
  return '#69717d'
}

function toRouteSearchItem(route: RouteSummary): SearchItem {
  return {
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
  }
}

function toStationSearchItem(station: StationSummary): SearchItem {
  return {
    type: 'station',
    id: station.id,
    mode: station.mode,
    label: station.name,
    subtitle: station.mode === 'metro' ? 'Station de métro' : 'Station du REM',
    lat: station.lat,
    lon: station.lon,
  }
}
