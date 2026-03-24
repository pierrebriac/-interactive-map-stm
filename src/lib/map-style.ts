import type { StyleSpecification } from 'maplibre-gl'
import type { MapStyle } from '../shared/types.ts'

const OSM_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [
    {
      id: 'osm',
      type: 'raster',
      source: 'osm',
    },
  ],
}

export function getMapStyle(style: MapStyle) {
  const mapTilerKey = import.meta.env.VITE_MAPTILER_API_KEY?.trim()
  if (mapTilerKey) {
    const styleName = style === 'satellite' ? 'hybrid' : 'streets-v2'
    return `https://api.maptiler.com/maps/${styleName}/style.json?key=${mapTilerKey}`
  }

  return OSM_STYLE
}
