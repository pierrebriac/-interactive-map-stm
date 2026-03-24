export type TransportMode = 'bus' | 'metro' | 'rem'
export type PositionSource = 'realtime' | 'estimated' | 'status_only'
export type MapStyle = 'streets' | 'satellite'
export type ViewMode = 'combined' | 'bixi' | TransportMode
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

export interface GeoPoint {
  lat: number
  lon: number
}

export interface ResolvedPlace extends GeoPoint {
  id: string
  label: string
  address: string
  placeType: string
  relevance: number
}

export interface GeocodeResponse {
  generatedAt: string
  query: string
  features: ResolvedPlace[]
  warnings: string[]
}

export interface BixiStation {
  id: string
  name: string
  lat: number
  lon: number
  capacity: number
  bikesAvailable: number
  ebikesAvailable: number
  docksAvailable: number
  isInstalled: boolean
  isRenting: boolean
  isReturning: boolean
  lastReportedAt: string | null
}

export interface BixiAlert {
  id: string
  title: string
  description: string
  url: string | null
  startAt: string | null
  endAt: string | null
}

export interface BixiResponse {
  generatedAt: string
  sourceTimestamp: string
  stations: BixiStation[]
  alerts: BixiAlert[]
  stale: boolean
  warnings: string[]
}

export type ItineraryMode = 'walking' | 'transit' | 'bixi'
export type ItinerarySegmentMode =
  | 'walking'
  | 'cycling'
  | 'metro'
  | 'rem'
  | 'bixi'

export interface ItineraryPlace extends GeoPoint {
  label: string
}

export interface ItinerarySegment {
  id: string
  kind: 'walk' | 'ride' | 'bike'
  mode: ItinerarySegmentMode
  label: string
  from: ItineraryPlace
  to: ItineraryPlace
  durationMin: number
  distanceKm: number
  routeId?: string
  stationId?: string
  stationName?: string
  bikesAvailable?: number
  docksAvailable?: number
  geometry: [number, number][]
}

export interface Itinerary {
  id: string
  mode: ItineraryMode
  summary: string
  durationMin: number
  distanceKm: number
  transfers: number
  segments: ItinerarySegment[]
  warnings: string[]
}

export interface PlanResponse {
  generatedAt: string
  origin: ResolvedPlace
  destination: ResolvedPlace
  itineraries: Itinerary[]
  warnings: string[]
}
