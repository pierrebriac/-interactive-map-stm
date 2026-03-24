export type TransportMode = 'bus' | 'metro' | 'rem'
export type PositionSource = 'realtime' | 'estimated' | 'status_only'
export type MapStyle = 'streets' | 'satellite'
export type ViewMode = 'combined' | TransportMode
export type SearchItemType = 'route' | 'station'
export type FavoriteType = 'route' | 'station'
export type ServiceStatus = 'normal' | 'warning' | 'interruption' | 'unknown'

export interface RouteSummary {
  id: string
  mode: TransportMode
  shortName: string
  longName: string
  color: string
  textColor: string
  center: [number, number]
  shapeIds: string[]
  stationIds: string[]
}

export interface StationSummary {
  id: string
  mode: TransportMode
  name: string
  lat: number
  lon: number
  routeIds: string[]
}

export interface ShapeFeature {
  id: string
  routeId: string
  mode: TransportMode
  color: string
  coordinates: [number, number][]
}

export interface SearchItem {
  type: SearchItemType
  id: string
  mode: TransportMode
  label: string
  subtitle: string
  lat: number
  lon: number
}

export interface MapStyleOption {
  id: MapStyle
  label: string
  available: boolean
}

export interface BootstrapResponse {
  generatedAt: string
  routes: RouteSummary[]
  stations: StationSummary[]
  shapes: ShapeFeature[]
  searchIndex: SearchItem[]
  styles: MapStyleOption[]
  warnings: string[]
  bounds: [[number, number], [number, number]]
}

export interface LiveEntity {
  id: string
  mode: TransportMode
  routeId: string
  label: string
  lat: number
  lon: number
  bearing?: number
  updatedAt: string
  positionSource: PositionSource
}

export interface ServiceState {
  routeId: string
  mode: TransportMode
  status: ServiceStatus
  message: string
  updatedAt: string
}

export interface LiveResponse {
  generatedAt: string
  sourceTimestamp: string
  entities: LiveEntity[]
  serviceStates: ServiceState[]
  stale: boolean
  warnings: string[]
}

export interface FavoriteItem {
  type: FavoriteType
  id: string
  mode: TransportMode
  label: string
  subtitle: string
  lat: number
  lon: number
}

export interface FavoritesResponse {
  favorites: FavoriteItem[]
  user: {
    id: string
    email: string | null
  } | null
}

export interface IdentitySession {
  id: string
  email: string | null
  token: string | null
}
