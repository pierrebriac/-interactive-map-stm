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
import { computeBounds } from '../shared/geo.ts'
import type {
  BootstrapResponse,
  FavoriteItem,
  LiveResponse,
  MapStyle,
  SearchItem,
  ShapeFeature,
  StationSummary,
  ViewMode,
} from '../shared/types.ts'
import { getMapStyle } from '../lib/map-style.ts'

interface MapViewProps {
  bootstrap: BootstrapResponse | null
  live: LiveResponse | null
  selectedItem: SearchItem | FavoriteItem | null
  viewMode: ViewMode
  mapStyle: MapStyle
  favoritesFocus: FavoriteItem[]
}

const EMPTY_COLLECTION = {
  type: 'FeatureCollection',
  features: [],
} satisfies FeatureCollection

export function MapView({
  bootstrap,
  live,
  selectedItem,
  viewMode,
  mapStyle,
  favoritesFocus,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<Map | null>(null)
  const fittedInitialBoundsRef = useRef(false)
  const activeStyleRef = useRef<MapStyle>(mapStyle)

  useEffect(() => {
    if (!containerRef.current || mapRef.current) {
      return
    }

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: getMapStyle(mapStyle),
      center: [-73.58, 45.52],
      zoom: 10.4,
      attributionControl: false,
    })

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right')

    map.on('load', () => {
      ensureLayers(map)
    })

    map.on('style.load', () => {
      ensureLayers(map)
    })

    map.on('click', 'bus-clusters', (event) => {
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
          duration: 600,
        })
      })
    })

    mapRef.current = map
    activeStyleRef.current = mapStyle

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [mapStyle])

  useEffect(() => {
    const map = mapRef.current
    if (!map) {
      return
    }

    if (activeStyleRef.current === mapStyle) {
      return
    }

    activeStyleRef.current = mapStyle
    map.setStyle(getMapStyle(mapStyle))
  }, [mapStyle])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !bootstrap) {
      return
    }

    const routeSource = map.getSource('routes') as GeoJSONSource | undefined
    const stationSource = map.getSource('stations') as GeoJSONSource | undefined
    const busSource = map.getSource('buses') as GeoJSONSource | undefined
    const railSource = map.getSource('rail-vehicles') as GeoJSONSource | undefined

    if (!routeSource || !stationSource || !busSource || !railSource) {
      return
    }

    routeSource.setData(buildRouteCollection(bootstrap, viewMode, selectedItem))
    stationSource.setData(buildStationCollection(bootstrap, viewMode, selectedItem))
    busSource.setData(buildBusCollection(live, selectedItem))
    railSource.setData(buildRailCollection(live, selectedItem))
  }, [bootstrap, live, selectedItem, viewMode])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !bootstrap) {
      return
    }

    if (selectedItem) {
      map.easeTo({
        center: [selectedItem.lon, selectedItem.lat],
        zoom: selectedItem.type === 'station' ? 13.4 : 11.8,
        duration: 700,
      })
      return
    }

    if (favoritesFocus.length > 0) {
      const bounds = computeBounds(
        favoritesFocus.map((favorite) => [favorite.lon, favorite.lat]),
      )
      map.fitBounds(bounds, { padding: 84, duration: 700 })
      return
    }

    if (!fittedInitialBoundsRef.current) {
      map.fitBounds(bootstrap.bounds, { padding: 52, duration: 0 })
      fittedInitialBoundsRef.current = true
    }
  }, [bootstrap, favoritesFocus, selectedItem])

  return <div className="map-shell" ref={containerRef} />
}

function ensureLayers(map: Map) {
  addGeoJsonSource(map, 'routes', {
    ...EMPTY_COLLECTION,
  })
  addGeoJsonSource(map, 'stations', {
    ...EMPTY_COLLECTION,
  })
  addGeoJsonSource(
    map,
    'buses',
    {
      ...EMPTY_COLLECTION,
    },
    { cluster: true, clusterRadius: 38, clusterMaxZoom: 11 },
  )
  addGeoJsonSource(map, 'rail-vehicles', {
    ...EMPTY_COLLECTION,
  })

  addLayerIfMissing(map, {
    id: 'route-lines',
    type: 'line',
    source: 'routes',
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['coalesce', ['get', 'lineWidth'], 3.25],
      'line-opacity': ['coalesce', ['get', 'opacity'], 0.9],
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
      'symbol-spacing': 260,
    },
    paint: {
      'text-color': '#f8f8f1',
      'text-halo-color': '#13222d',
      'text-halo-width': 1,
      'text-opacity': 0.85,
    },
  })

  addLayerIfMissing(map, {
    id: 'stations',
    type: 'circle',
    source: 'stations',
    paint: {
      'circle-radius': ['coalesce', ['get', 'radius'], 4.4],
      'circle-color': ['get', 'color'],
      'circle-stroke-width': 1.5,
      'circle-stroke-color': '#fffdf6',
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
      'text-color': '#1d2f36',
      'text-halo-color': '#fff9ef',
      'text-halo-width': 1.1,
    },
  })

  addLayerIfMissing(map, {
    id: 'bus-clusters',
    type: 'circle',
    source: 'buses',
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': '#ff6c37',
      'circle-radius': [
        'step',
        ['get', 'point_count'],
        18,
        30,
        22,
        100,
        26,
      ],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#fff3e3',
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
      'text-color': '#fffdf9',
    },
  })

  addLayerIfMissing(map, {
    id: 'bus-points',
    type: 'circle',
    source: 'buses',
    filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-radius': ['coalesce', ['get', 'radius'], 7.5],
      'circle-color': ['coalesce', ['get', 'color'], '#ff6c37'],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#fffaf1',
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
      'text-color': '#fffaf1',
      'text-halo-color': '#152027',
      'text-halo-width': 0.8,
    },
  })

  addLayerIfMissing(map, {
    id: 'rail-points',
    type: 'circle',
    source: 'rail-vehicles',
    paint: {
      'circle-radius': ['coalesce', ['get', 'radius'], 9],
      'circle-color': ['get', 'color'],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#fffdf7',
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
      'text-color': '#fffdf7',
      'text-halo-color': '#13222d',
      'text-halo-width': 0.7,
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
  bootstrap: BootstrapResponse,
  viewMode: ViewMode,
  selectedItem: SearchItem | FavoriteItem | null,
): FeatureCollection<LineString> {
  const modes = visibleModes(viewMode)
  const selectedRouteId = selectedItem?.type === 'route' ? selectedItem.id : null
  const selectedStation = selectedItem?.type === 'station' ? selectedItem.id : null
  const selectedStationRoutes = new Set(
    bootstrap.stations.find((station) => station.id === selectedStation)?.routeIds ?? [],
  )

  const shapes = bootstrap.shapes.filter((shape) => {
    if (!modes.has(shape.mode)) {
      return false
    }

    if (shape.mode === 'bus' && !selectedRouteId) {
      return false
    }

    if (selectedRouteId) {
      return shape.routeId === selectedRouteId
    }

    if (selectedStation) {
      return selectedStationRoutes.has(shape.routeId)
    }

    return true
  })

  return {
    type: 'FeatureCollection',
    features: shapes.map((shape) => routeToFeature(shape, selectedRouteId)),
  }
}

function buildStationCollection(
  bootstrap: BootstrapResponse,
  viewMode: ViewMode,
  selectedItem: SearchItem | FavoriteItem | null,
): FeatureCollection<Point> {
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
): FeatureCollection<Point> {
  const selectedRouteId = selectedItem?.type === 'route' ? selectedItem.id : null
  const entities = live?.entities.filter((entity) => entity.mode === 'bus') ?? []

  return {
    type: 'FeatureCollection',
    features: entities.map((entity) => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [entity.lon, entity.lat],
      },
      properties: {
        id: entity.id,
        label: entity.label,
        color: selectedRouteId === entity.routeId ? '#ff6c37' : '#f58c49',
        radius: selectedRouteId === entity.routeId ? 9 : 7,
      },
    })),
  }
}

function buildRailCollection(
  live: LiveResponse | null,
  selectedItem: SearchItem | FavoriteItem | null,
): FeatureCollection<Point> {
  const selectedRouteId = selectedItem?.type === 'route' ? selectedItem.id : null
  const entities = live?.entities.filter((entity) => entity.mode !== 'bus') ?? []

  return {
    type: 'FeatureCollection',
    features: entities.map((entity) => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [entity.lon, entity.lat],
      },
      properties: {
        id: entity.id,
        label: entity.label,
        color: routeColorForMode(entity.routeId, entity.mode),
        radius: selectedRouteId === entity.routeId ? 10 : 8,
      },
    })),
  }
}

function routeToFeature(
  shape: ShapeFeature,
  selectedRouteId: string | null,
): Feature<LineString> {
  return {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: shape.coordinates,
    },
    properties: {
      routeId: shape.routeId,
      color: shape.color,
      label: shape.mode === 'bus' ? '' : shape.routeId.replace(/^S/, 'A'),
      lineWidth: selectedRouteId === shape.routeId ? 5.2 : shape.mode === 'bus' ? 2.4 : 3.3,
      opacity: selectedRouteId && selectedRouteId !== shape.routeId ? 0.25 : 0.88,
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
      color: station.mode === 'metro' ? '#0d89d3' : '#52ad43',
      radius: selected ? 7.6 : 4.8,
    },
  }
}

function routeColorForMode(routeId: string, mode: ShapeFeature['mode']) {
  if (mode === 'metro') {
    if (routeId === '1') return '#17b059'
    if (routeId === '2') return '#f47f30'
    if (routeId === '4') return '#f5d31f'
    return '#147bd1'
  }

  return '#52ad43'
}
