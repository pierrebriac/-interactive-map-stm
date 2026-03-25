import {
  type ReactNode,
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import './App.css'
import { MapView, type MapCameraRequest } from './components/MapView.tsx'
import {
  fetchBootstrap,
  fetchFavorites,
  fetchGeocode,
  fetchLiveData,
  fetchPlan,
  fetchProfile,
  saveFavorites,
  saveProfile,
} from './lib/api.ts'
import {
  getIdentitySession,
  initIdentity,
  logoutIdentity,
  openIdentity,
  subscribeToIdentity,
} from './lib/auth.ts'
import { haversineKm } from './shared/geo.ts'
import { searchItems } from './lib/search.ts'
import type {
  BootstrapResponse,
  FavoriteItem,
  IdentitySession,
  Itinerary,
  ItineraryMode,
  LiveEntity,
  LiveResponse,
  LocationPreference,
  MapStyle,
  ResolvedPlace,
  SavedPlace,
  SearchItem,
  ServiceState,
  TransportMode,
  UserProfile,
  ViewMode,
} from './shared/types.ts'

type SurfaceMode = 'home' | 'explore' | 'route'
type RoutePanelMode = 'transit' | 'walking' | 'cycling'
type RouteField = 'origin' | 'destination'
type LiveMapScope = 'network' | 'focus'

const DEFAULT_PROFILE: UserProfile = {
  displayName: '',
  savedPlaces: [],
  locationPreference: 'unknown',
}

const CURRENT_LOCATION_PLACEHOLDER = 'Ma position'
const ACCOUNT_CACHE_PREFIX = 'transit-atlas-account'

function App() {
  const initialMobile =
    typeof window !== 'undefined'
      ? window.matchMedia('(max-width: 960px)').matches
      : false

  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null)
  const [live, setLive] = useState<LiveResponse | null>(null)
  const [session, setSession] = useState<IdentitySession | null>(null)
  const [favorites, setFavorites] = useState<FavoriteItem[]>([])
  const [profile, setProfile] = useState<UserProfile>(DEFAULT_PROFILE)
  const [selectedItem, setSelectedItem] = useState<SearchItem | FavoriteItem | null>(
    null,
  )
  const [selectedPlace, setSelectedPlace] = useState<ResolvedPlace | null>(null)
  const [surfaceMode, setSurfaceMode] = useState<SurfaceMode>('home')
  const [viewMode, setViewMode] = useState<ViewMode>('combined')
  const [mapLiveScope, setMapLiveScope] = useState<LiveMapScope>(
    initialMobile ? 'focus' : 'network',
  )
  const [mapStyle, setMapStyle] = useState<MapStyle>('streets')
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') return 'light'
    const stored = localStorage.getItem('transit-atlas-theme')
    if (stored === 'dark' || stored === 'light') return stored
    return 'light'
  })
  const [searchQuery, setSearchQuery] = useState('')
  const [searchPlaces, setSearchPlaces] = useState<ResolvedPlace[]>([])
  const [isSearchingPlaces, setIsSearchingPlaces] = useState(false)
  const [routeMode, setRouteMode] = useState<RoutePanelMode>('transit')
  const [routeOriginQuery, setRouteOriginQuery] = useState('')
  const [routeDestinationQuery, setRouteDestinationQuery] = useState('')
  const [routeOrigin, setRouteOrigin] = useState<ResolvedPlace | null>(null)
  const [routeDestination, setRouteDestination] = useState<ResolvedPlace | null>(null)
  const [activeRouteField, setActiveRouteField] = useState<RouteField>('destination')
  const [routeSuggestions, setRouteSuggestions] = useState<ResolvedPlace[]>([])
  const [planItineraries, setPlanItineraries] = useState<Itinerary[]>([])
  const [planWarnings, setPlanWarnings] = useState<string[]>([])
  const [selectedItineraryId, setSelectedItineraryId] = useState<string | null>(null)
  const [planRequestNonce, setPlanRequestNonce] = useState(0)
  const [isPlanning, setIsPlanning] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)
  const [appError, setAppError] = useState<string | null>(null)
  const [isFetchingLive, setIsFetchingLive] = useState(false)
  const [isSavingFavorite, setIsSavingFavorite] = useState(false)
  const [isSavingProfile, setIsSavingProfile] = useState(false)
  const [isMobileViewport, setIsMobileViewport] = useState(initialMobile)
  const [isSidebarOpen, setIsSidebarOpen] = useState(!initialMobile)
  const [isSearchExpanded, setIsSearchExpanded] = useState(false)
  const [cameraRequest, setCameraRequest] = useState<MapCameraRequest | null>(null)
  const [currentLocation, setCurrentLocation] = useState<ResolvedPlace | null>(null)
  const [isLocating, setIsLocating] = useState(false)
  const [locationHint, setLocationHint] = useState<string | null>(null)
  const [hasRequestedLocation, setHasRequestedLocation] = useState(false)
  const [browserLocationPreference, setBrowserLocationPreference] =
    useState<LocationPreference>('unknown')
  const [isSavePlaceOpen, setIsSavePlaceOpen] = useState(false)
  const [savePlaceKind, setSavePlaceKind] = useState<SavedPlace['kind']>('saved')
  const [savePlaceName, setSavePlaceName] = useState('')
  const [savePlaceError, setSavePlaceError] = useState<string | null>(null)
  const [editingSavedPlaceId, setEditingSavedPlaceId] = useState<string | null>(null)
  const [editingSavedPlaceName, setEditingSavedPlaceName] = useState('')
  const [editingSavedPlaceError, setEditingSavedPlaceError] = useState<string | null>(null)
  const hasInitializedCameraRef = useRef(false)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('transit-atlas-theme', theme)
  }, [theme])

  const deferredSearchQuery = useDeferredValue(searchQuery)
  const deferredRouteOriginQuery = useDeferredValue(routeOriginQuery)
  const deferredRouteDestinationQuery = useDeferredValue(routeDestinationQuery)

  useEffect(() => {
    let cancelled = false

    const loadBootstrap = async () => {
      try {
        const data = await fetchBootstrap()
        if (!cancelled) {
          setBootstrap(data)
          setAppError(null)
        }
      } catch (error) {
        if (!cancelled) {
          setAppError(
            error instanceof Error
              ? error.message
              : 'Impossible de charger la carte réseau.',
          )
        }
      }
    }

    void loadBootstrap()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    initIdentity()

    const syncIdentity = async () => {
      const nextSession = await getIdentitySession()
      setSession(nextSession)
    }

    void syncIdentity()
    return subscribeToIdentity(syncIdentity)
  }, [])

  useEffect(() => {
    if (!session?.token) {
      setFavorites([])
      setProfile(DEFAULT_PROFILE)
      return
    }

    let cancelled = false

    const loadAccountSurface = async () => {
      const token = session.token
      if (!token) {
        return
      }

      const cachedAccount = readAccountCache(session.id)
      if (cachedAccount) {
        setFavorites(cachedAccount.favorites)
        setProfile(cachedAccount.profile)
      }

      try {
        const [favoritesResult, profileResult] = await Promise.allSettled([
          fetchFavorites(token),
          fetchProfile(token),
        ])

        if (cancelled) {
          return
        }

        const nextFavorites =
          favoritesResult.status === 'fulfilled'
            ? favoritesResult.value.favorites
            : cachedAccount?.favorites ?? []
        const nextProfile =
          profileResult.status === 'fulfilled'
            ? profileResult.value.profile
            : cachedAccount?.profile ?? DEFAULT_PROFILE

        setFavorites(nextFavorites)
        setProfile(nextProfile)

        if (
          favoritesResult.status === 'fulfilled' ||
          profileResult.status === 'fulfilled'
        ) {
          writeAccountCache(session.id, {
            favorites: nextFavorites,
            profile: nextProfile,
          })
          setAppError((value) =>
            value === 'Impossible de charger le profil utilisateur.' ? null : value,
          )
          return
        }

        setAppError(
          favoritesResult.reason instanceof Error
            ? favoritesResult.reason.message
            : profileResult.status === 'rejected' && profileResult.reason instanceof Error
              ? profileResult.reason.message
              : 'Impossible de charger le profil utilisateur.',
        )
      } catch (error) {
        if (!cancelled) {
          setAppError(
            error instanceof Error
              ? error.message
              : 'Impossible de charger le profil utilisateur.',
          )
        }
      }
    }

    void loadAccountSurface()

    return () => {
      cancelled = true
    }
  }, [session?.id, session?.token])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const media = window.matchMedia('(max-width: 960px)')
    const syncViewport = (event?: MediaQueryListEvent) => {
      const matches = event?.matches ?? media.matches
      setIsMobileViewport(matches)
      if (!matches) {
        setIsSidebarOpen(true)
      }
    }

    syncViewport()
    media.addEventListener('change', syncViewport)

    return () => media.removeEventListener('change', syncViewport)
  }, [])

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) {
      return
    }

    let cancelled = false

    const syncPermission = async () => {
      try {
        const status = await navigator.permissions.query({
          name: 'geolocation',
        } as PermissionDescriptor)

        if (!cancelled) {
          setBrowserLocationPreference(permissionStateToPreference(status.state))
        }

        status.onchange = () => {
          setBrowserLocationPreference(permissionStateToPreference(status.state))
        }
      } catch {
        if (!cancelled) {
          setBrowserLocationPreference('unknown')
        }
      }
    }

    void syncPermission()

    return () => {
      cancelled = true
    }
  }, [])

  const selectedRouteId = selectedItem?.type === 'route' ? selectedItem.id : null
  const selectedStationId = selectedItem?.type === 'station' ? selectedItem.id : null
  const selectedRoute = bootstrap?.routes.find((route) => route.id === selectedRouteId) ?? null
  const selectedStation =
    bootstrap?.stations.find((station) => station.id === selectedStationId) ?? null
  const selectedFavorite =
    selectedItem &&
    favorites.some(
      (favorite) =>
        favorite.type === selectedItem.type && favorite.id === selectedItem.id,
    )

  const pinnedRouteFavorites = useMemo(
    () =>
      favorites.filter(
        (favorite) => favorite.type === 'route' && favorite.pinnedToMap,
      ),
    [favorites],
  )
  const pinnedRouteIds = useMemo(
    () => pinnedRouteFavorites.map((favorite) => favorite.id),
    [pinnedRouteFavorites],
  )
  const selectedStationRouteIds = useMemo(
    () => selectedStation?.routeIds ?? [],
    [selectedStation],
  )
  const itineraryModes = useMemo(
    () =>
      Array.from(
        new Set(
          planItineraries.flatMap((itinerary) =>
            itinerary.segments
              .filter((segment) => segment.kind === 'ride')
              .map((segment) => segment.routeId)
              .filter((routeId): routeId is string => Boolean(routeId)),
          ),
        ),
      ),
    [planItineraries],
  )

  const routeFocusIds = useMemo(() => {
    if (selectedRouteId) {
      return uniqueStrings([selectedRouteId, ...pinnedRouteIds])
    }

    if (selectedStationRouteIds.length > 0) {
      return uniqueStrings([...selectedStationRouteIds, ...pinnedRouteIds])
    }

    if (itineraryModes.length > 0) {
      return uniqueStrings([...itineraryModes, ...pinnedRouteIds])
    }

    return pinnedRouteIds
  }, [itineraryModes, pinnedRouteIds, selectedRouteId, selectedStationRouteIds])

  const selectedItinerary =
    planItineraries.find((itinerary) => itinerary.id === selectedItineraryId) ??
    planItineraries[0] ??
    null

  useEffect(() => {
    if (!selectedPlace) {
      setIsSavePlaceOpen(false)
      setSavePlaceError(null)
      return
    }

    setSavePlaceKind('saved')
    setSavePlaceName(defaultSavedPlaceName(selectedPlace))
    setSavePlaceError(null)
  }, [selectedPlace])

  useEffect(() => {
    if (
      editingSavedPlaceId &&
      !profile.savedPlaces.some((place) => place.id === editingSavedPlaceId)
    ) {
      setEditingSavedPlaceId(null)
      setEditingSavedPlaceName('')
      setEditingSavedPlaceError(null)
    }
  }, [editingSavedPlaceId, profile.savedPlaces])

  useEffect(() => {
    if (!bootstrap) {
      return
    }

    let cancelled = false
    let intervalId = 0

    const loadLive = async () => {
      setIsFetchingLive(true)

      try {
        const data = await fetchLiveData({
          modes: ['bus', 'metro', 'rem'],
        })

        if (!cancelled) {
          setLive((previous) => stabilizeLiveResponse(previous, data))
          setAppError((value) =>
            value === 'Impossible de rafraîchir les données live.'
              ? null
              : value,
          )
        }
      } catch (error) {
        if (!cancelled) {
          console.error(error)
          setAppError('Impossible de rafraîchir les données live.')
        }
      } finally {
        if (!cancelled) {
          setIsFetchingLive(false)
        }
      }
    }

    void loadLive()
    intervalId = window.setInterval(() => {
      void loadLive()
    }, 8000)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [bootstrap])

  const networkSearchResults = useMemo(
    () =>
      bootstrap
        ? searchItems(bootstrap.searchIndex, deferredSearchQuery, { limit: 10 })
        : [],
    [bootstrap, deferredSearchQuery],
  )

  const routeSuggestionQuery =
    activeRouteField === 'origin'
      ? deferredRouteOriginQuery
      : deferredRouteDestinationQuery

  useEffect(() => {
    const query = deferredSearchQuery.trim()
    if (surfaceMode === 'route' || query.length < 3) {
      setSearchPlaces([])
      return
    }

    let cancelled = false
    setIsSearchingPlaces(true)

    void fetchGeocode(query, 6)
      .then((response) => {
        if (!cancelled) {
          setSearchPlaces(response.features)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.error(error)
          setSearchPlaces([])
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsSearchingPlaces(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [deferredSearchQuery, surfaceMode])

  useEffect(() => {
    const query = routeSuggestionQuery.trim()
    if (surfaceMode !== 'route' || query.length < 2) {
      setRouteSuggestions([])
      return
    }

    let cancelled = false

    void fetchGeocode(query, 6)
      .then((response) => {
        if (!cancelled) {
          setRouteSuggestions(response.features)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.error(error)
          setRouteSuggestions([])
        }
      })

    return () => {
      cancelled = true
    }
  }, [routeSuggestionQuery, surfaceMode])

  const routeStationSuggestions = useMemo(() => {
    if (!bootstrap || surfaceMode !== 'route') {
      return []
    }

    return searchItems(bootstrap.searchIndex, routeSuggestionQuery, {
      limit: 5,
      types: ['station'],
    }).map(toResolvedPlace)
  }, [bootstrap, routeSuggestionQuery, surfaceMode])

  const routeSavedPlaceSuggestions = useMemo(() => {
    if (surfaceMode !== 'route') {
      return []
    }

    return searchSavedPlaces(profile.savedPlaces, routeSuggestionQuery)
      .slice(0, 5)
      .map(toResolvedPlace)
  }, [profile.savedPlaces, routeSuggestionQuery, surfaceMode])

  const effectiveRouteSuggestions = useMemo(() => {
    const deduped = new Map<string, ResolvedPlace>()

    for (const suggestion of [
      ...routeSavedPlaceSuggestions,
      ...routeSuggestions,
      ...routeStationSuggestions,
    ]) {
      deduped.set(`${suggestion.id}:${suggestion.address}`, suggestion)
    }

    return Array.from(deduped.values()).slice(0, 8)
  }, [routeSavedPlaceSuggestions, routeStationSuggestions, routeSuggestions])

  useEffect(() => {
    if (!routeOrigin || !routeDestination || surfaceMode !== 'route') {
      setPlanItineraries([])
      setPlanWarnings([])
      setPlanError(null)
      return
    }

    if (planRequestNonce === 0) {
      return
    }

    let cancelled = false
    setIsPlanning(true)
    setPlanError(null)

    const modes =
      routeMode === 'transit'
        ? (['transit'] satisfies ItineraryMode[])
        : routeMode === 'walking'
          ? (['walking'] satisfies ItineraryMode[])
          : (['cycling', 'bixi'] satisfies ItineraryMode[])

    void fetchPlan({
      from: routeOrigin.address,
      to: routeDestination.address,
      fromLat: routeOrigin.lat,
      fromLon: routeOrigin.lon,
      toLat: routeDestination.lat,
      toLon: routeDestination.lon,
      modes,
    })
      .then((response) => {
        if (cancelled) {
          return
        }

        setPlanItineraries(response.itineraries)
        setPlanWarnings(
          uniqueStrings([
            ...response.warnings,
            ...response.itineraries.flatMap((itinerary) => itinerary.warnings),
          ]),
        )
        setSelectedItineraryId(response.itineraries[0]?.id ?? null)
      })
      .catch((error) => {
        if (!cancelled) {
          setPlanItineraries([])
          setPlanWarnings([])
          setPlanError(
            error instanceof Error
              ? error.message
              : 'Impossible de calculer cet itinéraire.',
          )
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsPlanning(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [planRequestNonce, routeDestination, routeMode, routeOrigin, surfaceMode])

  useEffect(() => {
    if (!bootstrap || hasInitializedCameraRef.current) {
      return
    }

    hasInitializedCameraRef.current = true

    if (pinnedRouteFavorites.length > 0) {
      setCameraRequest(
        buildRouteCameraRequest(bootstrap, pinnedRouteFavorites.map((favorite) => favorite.id)),
      )
      return
    }

    setCameraRequest({
      id: createRequestId('bootstrap'),
      kind: 'bounds',
      points: bootstrap.shapes.flatMap((shape) => shape.coordinates),
      padding: 52,
      duration: 0,
    })
  }, [bootstrap, pinnedRouteFavorites])

  useEffect(() => {
    if (!selectedRoute || !bootstrap) {
      return
    }

    setCameraRequest(buildRouteCameraRequest(bootstrap, [selectedRoute.id]))
  }, [bootstrap, selectedRoute])

  useEffect(() => {
    if (!selectedStation) {
      return
    }

    setCameraRequest({
      id: createRequestId('station'),
      kind: 'center',
      center: [selectedStation.lon, selectedStation.lat],
      zoom: 13.8,
      duration: 700,
    })
  }, [selectedStation])

  useEffect(() => {
    if (!selectedPlace) {
      return
    }

    setCameraRequest({
      id: createRequestId('place'),
      kind: 'center',
      center: [selectedPlace.lon, selectedPlace.lat],
      zoom: 14.2,
      duration: 700,
    })
  }, [selectedPlace])

  useEffect(() => {
    if (!selectedItinerary) {
      return
    }

    const points = selectedItinerary.segments.flatMap((segment) => segment.geometry)
    if (points.length === 0) {
      return
    }

    setCameraRequest({
      id: createRequestId('itinerary'),
      kind: 'bounds',
      points,
      padding: isMobileViewport ? 96 : 132,
      duration: 760,
    })
  }, [isMobileViewport, selectedItinerary])

  const searchSections = useMemo(
    () => ({
      savedPlaces: searchSavedPlaces(profile.savedPlaces, deferredSearchQuery).slice(0, 6),
      routes: networkSearchResults.filter((item) => item.type === 'route'),
      stations: networkSearchResults.filter((item) => item.type === 'station'),
      places: searchPlaces,
    }),
    [deferredSearchQuery, networkSearchResults, profile.savedPlaces, searchPlaces],
  )

  const contextualLive = useMemo(
    () =>
      filterLiveResponse(live, bootstrap, {
        modes: deriveModes(viewMode, selectedItem, selectedItinerary),
        routeIds: routeFocusIds,
        selectedStation,
      }),
    [bootstrap, live, routeFocusIds, selectedItem, selectedItinerary, selectedStation, viewMode],
  )
  const networkLive = useMemo(
    () =>
      filterLiveResponse(live, bootstrap, {
        modes: modesFromViewMode(viewMode),
      }),
    [bootstrap, live, viewMode],
  )
  const mapLive = mapLiveScope === 'network' ? networkLive : contextualLive
  const serviceStatusSummary = summarizeServiceStates(mapLive?.serviceStates ?? [])
  const liveSummary = summarizeLiveEntities(live?.entities ?? [])
  const mapLiveSummary = summarizeLiveEntities(mapLive?.entities ?? [])
  const styleOptions = bootstrap?.styles ?? [
    { id: 'streets' as const, label: '2D', available: true },
    { id: 'satellite' as const, label: 'Aérien', available: false },
  ]
  const homePlace = profile.savedPlaces.find((place) => place.kind === 'home') ?? null
  const workPlace = profile.savedPlaces.find((place) => place.kind === 'work') ?? null
  const extraPlaces = profile.savedPlaces.filter((place) => place.kind === 'saved')
  const effectiveLocationPreference =
    currentLocation
      ? 'granted'
      : browserLocationPreference === 'granted'
      ? 'granted'
      : profile.locationPreference !== 'unknown'
        ? profile.locationPreference
        : browserLocationPreference

  const selectionCard = selectedRoute
    ? {
        title: selectedRoute.shortName,
        subtitle:
          selectedRoute.mode === 'bus'
            ? `Bus • ${selectedRoute.longName}`
            : selectedRoute.mode === 'metro'
              ? `Métro • ${selectedRoute.longName}`
              : `REM • ${selectedRoute.longName}`,
        note:
          selectedRoute.mode === 'bus'
            ? 'Ligne complète affichée avec les véhicules en circulation.'
            : 'Ligne et véhicules actifs isolés sur la carte.',
      }
    : selectedStation
      ? {
          title: selectedStation.name,
          subtitle:
            selectedStation.mode === 'metro' ? 'Station de métro' : 'Station du REM',
          note:
            selectedStation.routeIds.length > 0
              ? `Correspondances: ${selectedStation.routeIds.join(', ')}`
              : 'Véhicules proches visibles.',
        }
      : selectedPlace
        ? {
            title: selectedPlace.label,
            subtitle: selectedPlace.address,
            note: 'Lieu sélectionné. Tu peux l’enregistrer ou lancer un itinéraire.',
          }
        : null

  const handleSelectItem = (item: SearchItem | FavoriteItem) => {
    startTransition(() => {
      setSelectedItem(item)
      setSelectedPlace(null)
      setSurfaceMode('explore')
      setSearchQuery(item.label)
      setIsSearchExpanded(false)
      if (item.type === 'route') {
        setViewMode(item.mode)
      }
      if (isMobileViewport) {
        setIsSidebarOpen(false)
      }
    })
  }

  const handleSelectPlace = (place: ResolvedPlace) => {
    startTransition(() => {
      setSelectedPlace(place)
      setSelectedItem(null)
      setSurfaceMode('explore')
      setSearchQuery(routeInputDisplay(place))
      setIsSearchExpanded(false)
      if (isMobileViewport) {
        setIsSidebarOpen(false)
      }
    })
  }

  const handleSelectSavedSearchPlace = async (place: SavedPlace) => {
    setSearchQuery(place.name)
    setIsSearchExpanded(false)
    await handleRouteToSavedPlace(place)
  }

  const handleFocusSavedPlace = (place: SavedPlace) => {
    const resolved = toResolvedPlace(place)

    startTransition(() => {
      setSelectedPlace(resolved)
      setSelectedItem(null)
      setSurfaceMode('explore')
      setSearchQuery(place.name)
      setIsSearchExpanded(false)
      if (isMobileViewport) {
        setIsSidebarOpen(false)
      }
    })
  }

  const handleOpenRoute = (destination?: ResolvedPlace | SavedPlace | SearchItem) => {
    startTransition(() => {
      setSurfaceMode('route')
      setSelectedItem(null)
      setIsSearchExpanded(true)
      setIsSidebarOpen(true)
      if (destination) {
        const place = toResolvedPlace(destination)
        setRouteDestination(place)
        setRouteDestinationQuery(routeInputDisplay(place))
        setActiveRouteField('origin')
      } else if (searchQuery.trim()) {
        setRouteDestination(null)
        setRouteDestinationQuery(searchQuery.trim())
        setActiveRouteField('origin')
      } else {
        setActiveRouteField(routeDestination ? 'origin' : 'destination')
      }
    })
  }

  const handleClearSelection = () => {
    startTransition(() => {
      setSelectedItem(null)
      setSelectedPlace(null)
      setSearchQuery('')
      setSurfaceMode(session ? 'home' : 'explore')
      if (bootstrap) {
        setCameraRequest(
          pinnedRouteFavorites.length > 0
            ? buildRouteCameraRequest(
                bootstrap,
                pinnedRouteFavorites.map((favorite) => favorite.id),
              )
            : {
                id: createRequestId('reset'),
                kind: 'bounds',
                points: bootstrap.shapes.flatMap((shape) => shape.coordinates),
                padding: 52,
                duration: 700,
              },
        )
      }
    })
  }

  const handleToggleFavorite = async () => {
    if (!selectedItem) {
      return
    }

    if (!session?.token) {
      openIdentity('signup')
      return
    }

    const nextFavorite = toFavoriteItem(selectedItem)
    const exists = favorites.some(
      (favorite) =>
        favorite.type === nextFavorite.type && favorite.id === nextFavorite.id,
    )
    const nextFavorites = exists
      ? favorites.filter(
          (favorite) =>
            !(favorite.type === nextFavorite.type && favorite.id === nextFavorite.id),
        )
      : [nextFavorite, ...favorites].slice(0, 36)

    await persistFavorites(nextFavorites)
  }

  const handleToggleFavoritePin = async (favorite: FavoriteItem) => {
    if (!session?.token) {
      openIdentity('login')
      return
    }

    const nextFavorites = favorites.map((entry) =>
      entry.type === favorite.type && entry.id === favorite.id
        ? { ...entry, pinnedToMap: !entry.pinnedToMap }
        : entry,
    )
    await persistFavorites(nextFavorites)
  }

  const handleRemoveFavorite = async (favorite: FavoriteItem) => {
    if (!session?.token) {
      openIdentity('login')
      return
    }

    await persistFavorites(
      favorites.filter(
        (entry) => !(entry.type === favorite.type && entry.id === favorite.id),
      ),
    )
  }

  const persistFavorites = async (nextFavorites: FavoriteItem[]) => {
    if (!session?.token) {
      return
    }

    const previousFavorites = favorites
    setFavorites(nextFavorites)
    setIsSavingFavorite(true)

    try {
      const response = await saveFavorites(session.token, nextFavorites)
      setFavorites(response.favorites)
      writeAccountCache(session.id, {
        favorites: response.favorites,
      })
    } catch (error) {
      setFavorites(previousFavorites)
      setAppError(
        error instanceof Error
          ? error.message
          : 'Impossible de mettre à jour les favoris.',
      )
    } finally {
      setIsSavingFavorite(false)
    }
  }

  const persistProfile = async (nextProfile: UserProfile) => {
    if (!session?.token) {
      return
    }

    const previousProfile = profile
    setProfile(nextProfile)
    setIsSavingProfile(true)

    try {
      const response = await saveProfile(session.token, nextProfile)
      setProfile(response.profile)
      writeAccountCache(session.id, {
        profile: response.profile,
      })
    } catch (error) {
      setProfile(previousProfile)
      setAppError(
        error instanceof Error
          ? error.message
          : 'Impossible de mettre à jour le profil.',
      )
    } finally {
      setIsSavingProfile(false)
    }
  }

  const handleSaveDisplayName = async (value: string) => {
    if (!session?.token) {
      return
    }

    const trimmed = value.trim()
    if (trimmed === profile.displayName) {
      return
    }

    await persistProfile({
      ...profile,
      displayName: trimmed,
    })
  }

  const handleStartSaveSelectedPlace = (kind: SavedPlace['kind'] = 'saved') => {
    if (!session?.token) {
      openIdentity('signup')
      return
    }

    if (!selectedPlace) {
      return
    }

    setSavePlaceKind(kind)
    setSavePlaceName(defaultSavedPlaceName(selectedPlace, kind))
    setSavePlaceError(null)
    setIsSavePlaceOpen(true)
  }

  const handleSaveSelectedPlace = async () => {
    if (!session?.token) {
      openIdentity('signup')
      return
    }

    if (!selectedPlace) {
      return
    }

    const trimmedName = savePlaceName.trim()
    if (savePlaceKind === 'saved' && !trimmedName) {
      setSavePlaceError('Donne un nom court à cette adresse pour la retrouver ensuite.')
      return
    }

    const nextPlace = toSavedPlace(
      selectedPlace,
      savePlaceKind,
      trimmedName || defaultSavedPlaceName(selectedPlace, savePlaceKind),
    )
    const basePlaces = profile.savedPlaces.filter((place) =>
      savePlaceKind === 'saved' ? place.id !== nextPlace.id : place.kind !== savePlaceKind,
    )

    await persistProfile({
      ...profile,
      savedPlaces:
        savePlaceKind === 'saved'
          ? [nextPlace, ...basePlaces].slice(0, 22)
          : [nextPlace, ...basePlaces],
    })

    setIsSavePlaceOpen(false)
    setSavePlaceError(null)
  }

  const handleDeleteSavedPlace = async (placeId: string) => {
    if (!session?.token) {
      return
    }

    await persistProfile({
      ...profile,
      savedPlaces: profile.savedPlaces.filter((place) => place.id !== placeId),
    })
  }

  const handleStartEditSavedPlace = (place: SavedPlace) => {
    setEditingSavedPlaceId(place.id)
    setEditingSavedPlaceName(place.name)
    setEditingSavedPlaceError(null)
  }

  const handleCancelEditSavedPlace = () => {
    setEditingSavedPlaceId(null)
    setEditingSavedPlaceName('')
    setEditingSavedPlaceError(null)
  }

  const handleSaveEditedSavedPlace = async (place: SavedPlace) => {
    if (!session?.token) {
      return
    }

    const trimmed = editingSavedPlaceName.trim()
    if (!trimmed) {
      setEditingSavedPlaceError('Le nom ne peut pas être vide.')
      return
    }

    await persistProfile({
      ...profile,
      savedPlaces: profile.savedPlaces.map((entry) =>
        entry.id === place.id ? { ...entry, name: trimmed.slice(0, 60) } : entry,
      ),
    })

    handleCancelEditSavedPlace()
  }

  const syncLocationPreference = async (preference: LocationPreference) => {
    if (!session?.token) {
      return
    }

    if (profile.locationPreference === preference) {
      return
    }

    await persistProfile({
      ...profile,
      locationPreference: preference,
    })
  }

  const requestCurrentLocation = async () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setLocationHint('La géolocalisation n’est pas disponible sur cet appareil.')
      return null
    }

    if (typeof window !== 'undefined' && !window.isSecureContext) {
      setLocationHint('La localisation nécessite une connexion sécurisée en https.')
      return null
    }

    setHasRequestedLocation(true)

    if (browserLocationPreference === 'denied' && !currentLocation) {
      setLocationHint(
        'La localisation est déjà bloquée par le navigateur. Autorise-la dans les réglages du site puis réessaie.',
      )
      return null
    }

    setIsLocating(true)
    setLocationHint(null)

    return new Promise<ResolvedPlace | null>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        async (position) => {
          const place = {
            id: `coord:${position.coords.latitude.toFixed(6)},${position.coords.longitude.toFixed(6)}`,
            label: CURRENT_LOCATION_PLACEHOLDER,
            address: CURRENT_LOCATION_PLACEHOLDER,
            placeType: 'coordinate',
            relevance: 1,
            lat: position.coords.latitude,
            lon: position.coords.longitude,
          } satisfies ResolvedPlace

          setCurrentLocation(place)
          setBrowserLocationPreference('granted')
          setLocationHint('Position actuelle prête.')
          await syncLocationPreference('granted')
          setIsLocating(false)
          resolve(place)
        },
        async (error) => {
          const nextPreference =
            error.code === error.PERMISSION_DENIED
              ? 'denied'
              : 'prompt-dismissed'
          setBrowserLocationPreference(nextPreference)
          setLocationHint(
            nextPreference === 'denied'
              ? 'La localisation est bloquée par le navigateur. Autorise-la dans les réglages du site puis réessaie.'
              : 'La demande de localisation a été fermée ou interrompue.',
          )
          await syncLocationPreference(nextPreference)
          setIsLocating(false)
          resolve(null)
        },
        {
          enableHighAccuracy: true,
          timeout: 8000,
          maximumAge: 30_000,
        },
      )
    })
  }

  const handleUseCurrentLocationAsOrigin = async () => {
    const place = currentLocation ?? (await requestCurrentLocation())
    if (!place) {
      return
    }

    setRouteOrigin(place)
    setRouteOriginQuery(CURRENT_LOCATION_PLACEHOLDER)
    setActiveRouteField('destination')

    if (routeDestination) {
      setPlanRequestNonce((value) => value + 1)
    }
  }

  const handleLocateFromSidebar = async () => {
    const place = currentLocation ?? (await requestCurrentLocation())
    if (!place) {
      return
    }

    setSelectedPlace(place)
    setSelectedItem(null)
    setSearchQuery(CURRENT_LOCATION_PLACEHOLDER)
    if (surfaceMode !== 'route') {
      setSurfaceMode('explore')
    }

    if (surfaceMode === 'route' && !routeOrigin) {
      setRouteOrigin(place)
      setRouteOriginQuery(CURRENT_LOCATION_PLACEHOLDER)
      setActiveRouteField('destination')
    }
  }

  const handleRouteToSavedPlace = async (place: SavedPlace) => {
    handleOpenRoute(place)
    const location = currentLocation ?? (await requestCurrentLocation())
    if (location) {
      setRouteOrigin(location)
      setRouteOriginQuery(CURRENT_LOCATION_PLACEHOLDER)
      setRouteDestination(toResolvedPlace(place))
      setRouteDestinationQuery(place.address)
      setPlanRequestNonce((value) => value + 1)
    }
  }

  const handleRoutePick = (field: RouteField, place: ResolvedPlace) => {
    const displayValue = routeInputDisplay(place)

    if (field === 'origin') {
      setRouteOrigin(place)
      setRouteOriginQuery(displayValue)
      setActiveRouteField('destination')
      if (routeDestination) {
        setPlanRequestNonce((value) => value + 1)
      }
      return
    }

    setRouteDestination(place)
    setRouteDestinationQuery(displayValue)
    setActiveRouteField('origin')
    if (routeOrigin) {
      setPlanRequestNonce((value) => value + 1)
    }
  }

  const handleRouteSwap = () => {
    setRouteOrigin(routeDestination)
    setRouteDestination(routeOrigin)
    setRouteOriginQuery(routeDestinationQuery)
    setRouteDestinationQuery(routeOriginQuery)
    if (routeOrigin && routeDestination) {
      setPlanRequestNonce((value) => value + 1)
    }
  }

  const handleResolveRouteInputs = async () => {
    setPlanError(null)

    const resolvedOrigin = routeOrigin ?? (await resolveRouteField('origin'))
    const resolvedDestination =
      routeDestination ?? (await resolveRouteField('destination'))

    if (!resolvedOrigin || !resolvedDestination) {
      setPlanError('Entre un départ et une arrivée valides dans Montréal.')
      return
    }

    setPlanRequestNonce((value) => value + 1)
  }

  const handleUseTypedRouteQuery = async () => {
    const resolved = await resolveRouteField(activeRouteField)
    if (!resolved) {
      setPlanError('Cette adresse n’a pas pu être résolue dans Montréal.')
      return
    }

    if (
      (activeRouteField === 'origin' && routeDestination) ||
      (activeRouteField === 'destination' && routeOrigin)
    ) {
      setPlanRequestNonce((value) => value + 1)
    }
  }

  async function resolveRouteField(field: RouteField) {
    const query =
      field === 'origin' ? routeOriginQuery.trim() : routeDestinationQuery.trim()
    if (!query) {
      return null
    }

    if (query === CURRENT_LOCATION_PLACEHOLDER) {
      if (currentLocation) {
        setResolvedRouteField(field, currentLocation, CURRENT_LOCATION_PLACEHOLDER)
        return currentLocation
      }

      const place = await requestCurrentLocation()
      if (place) {
        setResolvedRouteField(field, place, CURRENT_LOCATION_PLACEHOLDER)
      }
      return place
    }

    const matchingSavedPlace = profile.savedPlaces.find((place) =>
      [place.name, place.label, place.address].some(
        (candidate) => normalizeRouteText(candidate) === normalizeRouteText(query),
      ),
    )

    if (matchingSavedPlace) {
      const resolved = toResolvedPlace(matchingSavedPlace)
      setResolvedRouteField(field, resolved, matchingSavedPlace.address)
      return resolved
    }

    try {
      const geocoded = await fetchGeocode(query, 1)
      const bestPlace = geocoded.features[0]
      if (bestPlace) {
        setResolvedRouteField(field, bestPlace, query)
        return bestPlace
      }
    } catch (error) {
      setPlanError(
        error instanceof Error
          ? error.message
          : 'Impossible de géocoder cette adresse.',
      )
    }

    const stationFallback = bootstrap
      ? searchItems(bootstrap.searchIndex, query, {
          limit: 1,
          types: ['station'],
        })[0]
      : null

    if (stationFallback) {
      const resolved = toResolvedPlace(stationFallback)
      setResolvedRouteField(field, resolved, resolved.label)
      return resolved
    }

    return null
  }

  function setResolvedRouteField(
    field: RouteField,
    place: ResolvedPlace,
    displayValue = routeInputDisplay(place),
  ) {
    if (field === 'origin') {
      setRouteOrigin(place)
      setRouteOriginQuery(displayValue)
      setActiveRouteField('destination')
      return
    }

    setRouteDestination(place)
    setRouteDestinationQuery(displayValue)
    setActiveRouteField('origin')
  }

  const handleSelectItinerary = (itineraryId: string) => {
    setSelectedItineraryId(itineraryId)
  }

  const handlePreviewSelectedItinerary = () => {
    if (!selectedItinerary) {
      return
    }

    const points = selectedItinerary.segments.flatMap((segment) => segment.geometry)
    if (points.length === 0) {
      return
    }

    setCameraRequest({
      id: createRequestId('preview-itinerary'),
      kind: 'bounds',
      points,
      padding: isMobileViewport ? 96 : 132,
      duration: 760,
    })

    if (isMobileViewport) {
      setIsSidebarOpen(false)
    }
  }

  const searchPopoverVisible =
    isSearchExpanded ||
    surfaceMode === 'route' ||
    Boolean(searchQuery.trim()) ||
    searchSections.routes.length > 0 ||
    searchSections.stations.length > 0 ||
    searchSections.savedPlaces.length > 0 ||
    searchSections.places.length > 0

  return (
    <div className={`app-shell ${isSidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}>
      <main className="map-panel">
        <MapView
          bootstrap={bootstrap}
          live={mapLive}
          selectedItem={selectedItem}
          selectedPlace={selectedPlace}
          savedPlaces={profile.savedPlaces}
          currentLocation={currentLocation}
          itinerary={selectedItinerary}
          viewMode={viewMode}
          liveScope={mapLiveScope}
          mapStyle={mapStyle}
          routeFocusIds={routeFocusIds}
          cameraRequest={cameraRequest}
          onSelectItem={handleSelectItem}
        />

        <div className={`floating-search ${searchPopoverVisible ? 'expanded' : ''}`}>
          <div className="omnibox-row">
            {isMobileViewport || !isSidebarOpen ? (
              <button
                className="chrome-button icon"
                onClick={() => setIsSidebarOpen((open) => !open)}
                aria-label={isSidebarOpen ? 'Fermer le panneau' : 'Ouvrir le panneau'}
              >
                {isSidebarOpen ? '✕' : '☰'}
              </button>
            ) : null}

            {surfaceMode === 'route' ? (
              <button
                className="chrome-button icon"
                onClick={() => {
                  setSurfaceMode(selectedItem || selectedPlace ? 'explore' : session ? 'home' : 'explore')
                  setIsSearchExpanded(false)
                }}
                aria-label="Fermer le mode itinéraire"
              >
                ←
              </button>
            ) : (
              <span className="search-leading brand-mark-badge" aria-hidden="true">
                <img src="/brand-mark.svg" alt="" />
              </span>
            )}

            {surfaceMode === 'route' ? (
              <div className="route-inline-summary">
                <strong>Itinéraire</strong>
                <small>
                  {routeOrigin ? routeOrigin.label : 'Départ'} →{' '}
                  {routeDestination ? routeDestination.label : 'Arrivée'}
                </small>
              </div>
            ) : (
              <input
                className="omnibox-input"
                value={searchQuery}
                onFocus={() => {
                  setIsSearchExpanded(true)
                  setSurfaceMode(selectedItem || selectedPlace ? 'explore' : session ? 'home' : 'explore')
                }}
                onChange={(event) => {
                  setSearchQuery(event.target.value)
                  setIsSearchExpanded(true)
                }}
                placeholder="Ligne 80, Jean-Talon, 425 rue..."
              />
            )}

            {surfaceMode !== 'route' && searchQuery ? (
              <button
                className="chrome-button icon subtle"
                onClick={() => setSearchQuery('')}
                aria-label="Effacer"
              >
                ✕
              </button>
            ) : null}

            <button
              className={`chrome-button ${surfaceMode === 'route' ? 'active' : ''}`}
              onClick={() => handleOpenRoute(selectedPlace ?? undefined)}
            >
              Itinéraire
            </button>

            <button
              className="chrome-button icon subtle"
              onClick={() => setMapStyle(mapStyle === 'streets' ? 'satellite' : 'streets')}
              disabled={!styleOptions.find((option) => option.id === 'satellite')?.available}
              aria-label="Changer le style de carte"
            >
              {mapStyle === 'streets' ? '🛰' : '🗺'}
            </button>
          </div>

          {surfaceMode === 'route' ? (
            <div className="search-panel route-panel">
              <div className="route-fields">
                <label className="route-field">
                  <span>Départ</span>
                  <input
                    value={routeOriginQuery}
                    onFocus={() => setActiveRouteField('origin')}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void handleResolveRouteInputs()
                      }
                    }}
                    onChange={(event) => {
                      setRouteOriginQuery(event.target.value)
                      setRouteOrigin(null)
                      setActiveRouteField('origin')
                    }}
                    placeholder={CURRENT_LOCATION_PLACEHOLDER}
                  />
                </label>
                <button className="swap-inline" onClick={handleRouteSwap} aria-label="Inverser">
                  ⇅
                </button>
                <label className="route-field">
                  <span>Arrivée</span>
                  <input
                    value={routeDestinationQuery}
                    onFocus={() => setActiveRouteField('destination')}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void handleResolveRouteInputs()
                      }
                    }}
                    onChange={(event) => {
                      setRouteDestinationQuery(event.target.value)
                      setRouteDestination(null)
                      setActiveRouteField('destination')
                    }}
                    placeholder="Choisir un lieu"
                  />
                </label>
              </div>

              <p className="panel-copy">
                Entre une adresse complète, un lieu ou une station. Exemple: 6920 avenue des Érables.
              </p>

              <div className="route-chip-row">
                <button className="small-chip" onClick={() => void handleUseCurrentLocationAsOrigin()}>
                  {isLocating ? 'Localisation…' : CURRENT_LOCATION_PLACEHOLDER}
                </button>
                {homePlace ? (
                  <button className="small-chip" onClick={() => handleRoutePick('destination', homePlace)}>
                    Domicile
                  </button>
                ) : null}
                {workPlace ? (
                  <button className="small-chip" onClick={() => handleRoutePick('destination', workPlace)}>
                    Travail
                  </button>
                ) : null}
                {extraPlaces.slice(0, 3).map((place) => (
                  <button
                    key={place.id}
                    className="small-chip"
                    onClick={() => handleRoutePick('destination', place)}
                  >
                    {place.name}
                  </button>
                ))}
              </div>

              <div className="mode-switch">
                {(
                  [
                    ['transit', 'Transport en commun'],
                    ['walking', 'À pied'],
                    ['cycling', 'Vélo'],
                  ] as const
                ).map(([modeId, label]) => (
                  <button
                    key={modeId}
                    className={`mode-pill ${routeMode === modeId ? 'active' : ''}`}
                    onClick={() => setRouteMode(modeId)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="inline-actions">
                <button className="primary-button" onClick={() => void handleResolveRouteInputs()}>
                  {isPlanning ? 'Calcul en cours…' : 'Calculer le trajet'}
                </button>
                <button
                  className="ghost-button"
                  onClick={() => {
                    setRouteOrigin(null)
                    setRouteDestination(null)
                    setRouteOriginQuery('')
                    setRouteDestinationQuery('')
                    setPlanError(null)
                    setPlanWarnings([])
                    setPlanItineraries([])
                    setSelectedItineraryId(null)
                    setPlanRequestNonce(0)
                  }}
                >
                  Effacer
                </button>
              </div>

              {effectiveRouteSuggestions.length > 0 || routeSuggestionQuery.trim().length >= 4 ? (
                <div className="search-section">
                  <p className="section-eyebrow">
                    {activeRouteField === 'origin' ? 'Suggestions départ' : 'Suggestions arrivée'}
                  </p>
                  <div className="stack-list">
                    {routeSuggestionQuery.trim().length >= 4 ? (
                      <button className="result-row typed-query-row" onClick={() => void handleUseTypedRouteQuery()}>
                        <strong>Utiliser “{routeSuggestionQuery.trim()}”</strong>
                        <small>Garder l’adresse saisie telle quelle.</small>
                      </button>
                    ) : null}
                    {effectiveRouteSuggestions.map((place) => (
                      <button
                        key={`${place.id}:${place.address}`}
                        className="result-row"
                        onClick={() => handleRoutePick(activeRouteField, place)}
                      >
                        <strong>{place.label}</strong>
                        <small>{place.address}</small>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : searchPopoverVisible ? (
            <div className="search-panel">
              {searchSections.routes.length > 0 ? (
                <SearchSection title="Lignes">
                  {searchSections.routes.map((item) => (
                    <button
                      key={`${item.type}:${item.id}`}
                      className={`result-row ${
                        selectedItem?.type === item.type && selectedItem.id === item.id ? 'active' : ''
                      }`}
                      onClick={() => handleSelectItem(item)}
                    >
                      <strong>{item.label}</strong>
                      <small>{item.subtitle}</small>
                    </button>
                  ))}
                </SearchSection>
              ) : null}

              {searchSections.stations.length > 0 ? (
                <SearchSection title="Stations">
                  {searchSections.stations.map((item) => (
                    <button
                      key={`${item.type}:${item.id}`}
                      className={`result-row ${
                        selectedItem?.type === item.type && selectedItem.id === item.id ? 'active' : ''
                      }`}
                      onClick={() => handleSelectItem(item)}
                    >
                      <strong>{item.label}</strong>
                      <small>{item.subtitle}</small>
                    </button>
                  ))}
                </SearchSection>
              ) : null}

              {searchSections.savedPlaces.length > 0 ? (
                <SearchSection title="Adresses enregistrées">
                  {searchSections.savedPlaces.map((place) => (
                    <button
                      key={`${place.id}:${place.address}`}
                      className="result-row"
                      onClick={() => void handleSelectSavedSearchPlace(place)}
                    >
                      <strong>{place.name}</strong>
                      <small>{place.address}</small>
                    </button>
                  ))}
                </SearchSection>
              ) : null}

              {searchSections.places.length > 0 ? (
                <SearchSection title="Adresses">
                  {searchSections.places.map((place) => (
                    <button
                      key={`${place.id}:${place.address}`}
                      className="result-row"
                      onClick={() => handleSelectPlace(place)}
                    >
                      <strong>{place.label}</strong>
                      <small>{place.address}</small>
                    </button>
                  ))}
                </SearchSection>
              ) : null}

              {isSearchingPlaces ? <p className="panel-copy">Recherche d’adresses…</p> : null}
              {!isSearchingPlaces &&
              deferredSearchQuery.trim() &&
              searchSections.routes.length === 0 &&
              searchSections.stations.length === 0 &&
              searchSections.savedPlaces.length === 0 &&
              searchSections.places.length === 0 ? (
                <p className="panel-copy">Aucun résultat.</p>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="status-toast">
          <div className="status-dot-wrap">
            <span className={`status-dot ${live?.stale ? 'stale' : isFetchingLive ? 'updating' : 'fresh'}`} />
            <strong>Montréal en direct</strong>
          </div>
          <small>
            {liveSummary.busRealtime} bus • {liveSummary.metroEstimated} métros • {liveSummary.remEstimated} REM
          </small>
          <small>{liveStatusLine(live, isFetchingLive)}</small>
        </div>
      </main>

      <aside className={`workspace-sidebar ${isSidebarOpen ? 'open' : 'closed'}`}>
        <div className="sidebar-header">
          <div>
            <p className="brand-kicker">Transit Atlas</p>
            <h1>Favoris, trajets et carte live</h1>
          </div>
          {!isMobileViewport ? (
            <button
              className="chrome-button icon subtle"
              onClick={() => setIsSidebarOpen((open) => !open)}
              aria-label={isSidebarOpen ? 'Replier le panneau' : 'Déplier le panneau'}
            >
              {isSidebarOpen ? '←' : '→'}
            </button>
          ) : null}
        </div>

        <section className="sidebar-section account-section">
          <div className="section-topline">
            <p className="section-eyebrow">Compte</p>
            {session ? (
              <button className="text-link" onClick={() => void logoutIdentity()}>
                Déconnexion
              </button>
            ) : null}
          </div>

          {session ? (
            <>
              <label className="profile-field">
                <span>Nom affiché</span>
                <input
                  defaultValue={profile.displayName || session.email?.split('@')[0] || ''}
                  onBlur={(event) => void handleSaveDisplayName(event.target.value)}
                  placeholder="Ton nom"
                />
              </label>
              <p className="panel-copy">Compte synchronisé{isSavingProfile ? ' • sauvegarde…' : ''}</p>
            </>
          ) : (
            <div className="auth-card">
              <p className="panel-copy">
                Connecte-toi pour synchroniser tes adresses, tes favoris et tes préférences.
              </p>
              <div className="inline-actions">
                <button className="secondary-button" onClick={() => openIdentity('login')}>
                  Connexion
                </button>
                <button className="primary-button" onClick={() => openIdentity('signup')}>
                  Créer un compte
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="sidebar-section location-section">
          <div className="section-topline">
            <p className="section-eyebrow">Ma position</p>
            <span className={`permission-pill ${effectiveLocationPreference}`}>
              {locationPreferenceLabel(effectiveLocationPreference, hasRequestedLocation)}
            </span>
          </div>
          <p className="panel-copy">
            Optionnelle. Sert surtout à partir d’où tu es ou à te recentrer sur la carte.
          </p>
          <div className="inline-actions">
            <button className="secondary-button" onClick={() => void handleLocateFromSidebar()}>
              {isLocating ? 'Localisation…' : 'Utiliser ma position'}
            </button>
          </div>
          {locationHint ? <p className="panel-copy">{locationHint}</p> : null}
        </section>

        {session ? (
          <section className="sidebar-section saved-places-section">
            <div className="section-topline">
              <p className="section-eyebrow">Adresses enregistrées</p>
              <span className="panel-copy">{profile.savedPlaces.length} adresses</span>
            </div>
            <p className="panel-copy">Garde ici ton domicile, ton travail et jusqu’à 20 lieux nommés.</p>
            <div className="section-actions">
              <button
                className="secondary-button compact-action"
                onClick={() => handleStartSaveSelectedPlace('saved')}
                disabled={!selectedPlace}
              >
                {selectedPlace ? 'Enregistrer la sélection' : 'Sélectionne une adresse'}
              </button>
              <span className="panel-copy">
                {selectedPlace
                  ? `Prêt à enregistrer: ${routeInputDisplay(selectedPlace)}`
                  : 'Choisis une adresse sur la carte ou dans la recherche pour l’ajouter.'}
              </span>
            </div>

            <div className="saved-place-grid">
              {homePlace ? (
                <SavedPlaceCard
                  place={homePlace}
                  onFocus={() => handleFocusSavedPlace(homePlace)}
                  onRoute={() => void handleRouteToSavedPlace(homePlace)}
                  onEditStart={() => handleStartEditSavedPlace(homePlace)}
                  onEditCancel={handleCancelEditSavedPlace}
                  onEditSave={() => void handleSaveEditedSavedPlace(homePlace)}
                  onEditNameChange={setEditingSavedPlaceName}
                  onDelete={() => void handleDeleteSavedPlace(homePlace.id)}
                  isEditing={editingSavedPlaceId === homePlace.id}
                  editingName={editingSavedPlaceName}
                  editingError={editingSavedPlaceError}
                />
              ) : (
                <PlaceholderCard
                  title="Domicile"
                  body="Enregistre une adresse depuis la recherche."
                  actionLabel={selectedPlace ? 'Définir depuis la sélection' : 'Sélectionne une adresse'}
                  onAction={
                    selectedPlace
                      ? () => handleStartSaveSelectedPlace('home')
                      : undefined
                  }
                />
              )}

              {workPlace ? (
                <SavedPlaceCard
                  place={workPlace}
                  onFocus={() => handleFocusSavedPlace(workPlace)}
                  onRoute={() => void handleRouteToSavedPlace(workPlace)}
                  onEditStart={() => handleStartEditSavedPlace(workPlace)}
                  onEditCancel={handleCancelEditSavedPlace}
                  onEditSave={() => void handleSaveEditedSavedPlace(workPlace)}
                  onEditNameChange={setEditingSavedPlaceName}
                  onDelete={() => void handleDeleteSavedPlace(workPlace.id)}
                  isEditing={editingSavedPlaceId === workPlace.id}
                  editingName={editingSavedPlaceName}
                  editingError={editingSavedPlaceError}
                />
              ) : (
                <PlaceholderCard
                  title="Travail"
                  body="Ajoute ton travail pour lancer un trajet en un geste."
                  actionLabel={selectedPlace ? 'Définir depuis la sélection' : 'Sélectionne une adresse'}
                  onAction={
                    selectedPlace
                      ? () => handleStartSaveSelectedPlace('work')
                      : undefined
                  }
                />
              )}
            </div>

            {extraPlaces.length > 0 ? (
              <div className="stack-list compact-stack">
                {extraPlaces.map((place) => (
                  <SavedPlaceListItem
                    key={place.id}
                    place={place}
                    onFocus={() => handleFocusSavedPlace(place)}
                    onRoute={() => void handleRouteToSavedPlace(place)}
                    onEditStart={() => handleStartEditSavedPlace(place)}
                    onEditCancel={handleCancelEditSavedPlace}
                    onEditSave={() => void handleSaveEditedSavedPlace(place)}
                    onEditNameChange={setEditingSavedPlaceName}
                    onDelete={() => void handleDeleteSavedPlace(place.id)}
                    isEditing={editingSavedPlaceId === place.id}
                    editingName={editingSavedPlaceName}
                    editingError={editingSavedPlaceError}
                  />
                ))}
              </div>
            ) : (
              <div className="empty-note">
                <p className="panel-copy">
                  Ajoute un premier lieu nommé pour pouvoir le retrouver d’un geste.
                </p>
                {selectedPlace ? (
                  <button
                    className="ghost-button compact-action"
                    onClick={() => handleStartSaveSelectedPlace('saved')}
                  >
                    Ajouter ce lieu
                  </button>
                ) : null}
              </div>
            )}
          </section>
        ) : null}

        {selectionCard ? (
          <section className="sidebar-section selection-section">
            <div className="section-topline">
              <p className="section-eyebrow">
                {surfaceMode === 'route' ? 'Itinéraire' : 'Exploration'}
              </p>
              <button className="text-link" onClick={handleClearSelection}>
                Effacer
              </button>
            </div>

            <div className="selection-headline">
              <h2>{selectionCard.title}</h2>
              <p>{selectionCard.subtitle}</p>
            </div>
            <p className="panel-copy">{selectionCard.note}</p>

            <div className="inline-actions">
              {selectedItem ? (
                <button className="primary-button" onClick={() => void handleToggleFavorite()}>
                  {selectedFavorite
                    ? isSavingFavorite
                      ? 'Mise à jour…'
                      : 'Retirer des favoris'
                    : 'Ajouter aux favoris'}
                </button>
              ) : null}
              {selectedPlace ? (
                <button className="primary-button" onClick={() => handleOpenRoute(selectedPlace)}>
                  Itinéraire
                </button>
              ) : null}
              {selectedPlace && session ? (
                <button className="ghost-button" onClick={() => handleStartSaveSelectedPlace()}>
                  Enregistrer l’adresse
                </button>
              ) : null}
            </div>

            {selectedPlace && session && isSavePlaceOpen ? (
              <div className="save-place-panel">
                <label className="profile-field">
                  <span>Nom</span>
                  <input
                    value={savePlaceName}
                    onChange={(event) => setSavePlaceName(event.target.value)}
                    placeholder="Ex. Salle de sport, Parents, Café"
                  />
                </label>
                <div className="mode-switch">
                  {(
                    [
                      ['saved', 'Adresse'],
                      ['home', 'Domicile'],
                      ['work', 'Travail'],
                    ] as const
                  ).map(([kind, label]) => (
                    <button
                      key={kind}
                      className={`mode-pill ${savePlaceKind === kind ? 'active' : ''}`}
                      onClick={() => {
                        setSavePlaceKind(kind)
                        setSavePlaceName(defaultSavedPlaceName(selectedPlace, kind))
                        setSavePlaceError(null)
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {savePlaceError ? <p className="panel-copy">{savePlaceError}</p> : null}
                <div className="inline-actions">
                  <button className="secondary-button" onClick={() => void handleSaveSelectedPlace()}>
                    Sauvegarder
                  </button>
                  <button
                    className="ghost-button"
                    onClick={() => {
                      setIsSavePlaceOpen(false)
                      setSavePlaceError(null)
                    }}
                  >
                    Annuler
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        {surfaceMode === 'route' ? (
          <section className="sidebar-section itinerary-section">
            <div className="section-topline">
              <p className="section-eyebrow">Résultats</p>
              <span className="panel-copy">
                {routeMode === 'transit'
                  ? 'Transport en commun'
                  : routeMode === 'walking'
                    ? 'Marche'
                    : 'Vélo et BIXI'}
              </span>
            </div>

            {isPlanning ? <p className="panel-copy">Calcul des itinéraires…</p> : null}
            {planError ? <p className="panel-copy">{planError}</p> : null}
            {!isPlanning && !planError && selectedItinerary ? (
              <div className="stack-list">
                {planItineraries.map((itinerary) => (
                  <button
                    key={itinerary.id}
                    className={`itinerary-card ${
                      selectedItinerary?.id === itinerary.id ? 'active' : ''
                    }`}
                    onClick={() => handleSelectItinerary(itinerary.id)}
                  >
                    <div className="itinerary-topline">
                      <strong>{itinerary.summary}</strong>
                      <span>{itinerary.durationMin} min</span>
                    </div>
                    <p>
                      {formatDistanceKm(itinerary.distanceKm)} •{' '}
                      {itinerary.transfers} correspondance
                      {itinerary.transfers > 1 ? 's' : ''}
                    </p>
                    <div className="mini-steps">
                      {itinerary.segments.slice(0, 4).map((segment) => (
                        <span key={segment.id} className={`mini-step mode-${segment.mode}`}>
                          {segment.label}
                        </span>
                      ))}
                    </div>
                  </button>
                ))}
              </div>
            ) : null}

            {selectedItinerary ? (
              <>
                <div className="inline-actions">
                  <button
                    className="secondary-button compact-action"
                    onClick={handlePreviewSelectedItinerary}
                  >
                    Voir sur la carte
                  </button>
                </div>
                <div className="stack-list step-stack">
                  {selectedItinerary.segments.map((segment, index) => (
                    <div key={segment.id} className={`step-card mode-${segment.mode}`}>
                      <div className="itinerary-step-row">
                        <span className="step-index">{index + 1}</span>
                        <div className="step-copy">
                          <div className="itinerary-topline">
                            <strong>{segmentInstruction(segment)}</strong>
                            <span>{segment.durationMin} min</span>
                          </div>
                          <p>
                            {segment.from.label} → {segment.to.label}
                          </p>
                          <small className="panel-copy">
                            {formatDistanceKm(segment.distanceKm)}
                          </small>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            {planWarnings.map((warning) => (
              <p key={warning} className="panel-copy">
                {warning}
              </p>
            ))}
          </section>
        ) : null}

        <section className="sidebar-section favorites-section">
          <div className="section-topline">
            <p className="section-eyebrow">Favoris live</p>
            <span className="panel-copy">{pinnedRouteFavorites.length} épinglé(s)</span>
          </div>

          {favorites.length > 0 ? (
            <div className="stack-list">
              {favorites.map((favorite) => (
                <FavoriteRow
                  key={`${favorite.type}:${favorite.id}`}
                  favorite={favorite}
                  live={live}
                  onFocus={() => handleSelectItem(favorite)}
                  onTogglePin={() => void handleToggleFavoritePin(favorite)}
                  onRemove={() => void handleRemoveFavorite(favorite)}
                />
              ))}
            </div>
          ) : (
            <p className="panel-copy">
              {session
                ? 'Ajoute une ligne ou une station à tes favoris depuis la carte.'
                : 'Connecte-toi pour retrouver tes lignes favorites dès l’ouverture.'}
            </p>
          )}
        </section>

        <section className="sidebar-section compact-controls map-section">
          <div className="section-topline">
            <p className="section-eyebrow">Carte</p>
            <span className="panel-copy">
              {mapLiveScope === 'network'
                ? `${mapLive?.entities.length ?? 0} véhicules affichés`
                : `${mapLive?.entities.length ?? 0} véhicules ciblés`}
            </span>
          </div>
          <div className="mode-switch scope-switch">
            <button
              className={`mode-pill ${mapLiveScope === 'network' ? 'active' : ''}`}
              onClick={() => setMapLiveScope('network')}
            >
              Tout Montréal
            </button>
            <button
              className={`mode-pill ${mapLiveScope === 'focus' ? 'active' : ''}`}
              onClick={() => setMapLiveScope('focus')}
            >
              Vue ciblée
            </button>
          </div>
          <p className="panel-copy">
            {mapLiveScope === 'network'
              ? `${liveSummary.busRealtime} bus • ${liveSummary.metroEstimated} métros • ${liveSummary.remEstimated} REM sur tout le réseau`
              : `${mapLiveSummary.busRealtime} bus • ${mapLiveSummary.metroEstimated} métros • ${mapLiveSummary.remEstimated} REM dans la vue courante`}
          </p>
          <div className="mode-switch view-switch">
            {(
              [
                ['combined', 'Tous'],
                ['bus', 'Bus'],
                ['metro', 'Métro'],
                ['rem', 'REM'],
              ] as const
            ).map(([modeId, label]) => (
              <button
                key={modeId}
                className={`mode-pill ${viewMode === modeId ? 'active' : ''}`}
                onClick={() => setViewMode(modeId)}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="panel-copy">{serviceStatusSummary}</p>
        </section>

        <section className="sidebar-section appearance-section">
          <div className="section-topline">
            <p className="section-eyebrow">Affichage</p>
            <span className="panel-copy">{theme === 'dark' ? 'Sombre' : 'Clair'}</span>
          </div>
          <div className="inline-actions">
            <button
              className="ghost-button"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? 'Passer en clair' : 'Passer en sombre'}
            </button>
          </div>
        </section>

        {(appError || live?.warnings.length || bootstrap?.warnings.length) && (
          <section className="sidebar-section alert-section">
            <p className="section-eyebrow">Informations</p>
            {appError ? <p className="panel-copy">{appError}</p> : null}
            {bootstrap?.warnings.map((warning) => (
              <p key={warning} className="panel-copy">
                {warning}
              </p>
            ))}
            {live?.warnings.map((warning) => (
              <p key={warning} className="panel-copy">
                {warning}
              </p>
            ))}
          </section>
        )}
      </aside>
    </div>
  )
}

function SearchSection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <div className="search-section">
      <p className="section-eyebrow">{title}</p>
      <div className="stack-list">{children}</div>
    </div>
  )
}

function FavoriteRow({
  favorite,
  live,
  onFocus,
  onTogglePin,
  onRemove,
}: {
  favorite: FavoriteItem
  live: LiveResponse | null
  onFocus: () => void
  onTogglePin: () => void
  onRemove: () => void
}) {
  const entityCount = live?.entities.filter((entity) => entity.routeId === favorite.id).length ?? 0
  const state = live?.serviceStates.find((serviceState) => serviceState.routeId === favorite.id)

  return (
    <div className={`favorite-row mode-${favorite.mode}`}>
      <button className="favorite-main" onClick={onFocus}>
        <strong>{favorite.label}</strong>
        <small>{favorite.subtitle}</small>
        <span className="favorite-meta">
          {entityCount} véhicule{entityCount > 1 ? 's' : ''}
          {state ? ` • ${serviceStatusLabel(state.status)}` : ''}
        </span>
      </button>
      <div className="row-actions">
        {favorite.type === 'route' ? (
          <button className={`pin-toggle ${favorite.pinnedToMap ? 'active' : ''}`} onClick={onTogglePin}>
            {favorite.pinnedToMap ? 'Épinglé' : 'Afficher'}
          </button>
        ) : null}
        <button className="ghost-button compact-action" onClick={onRemove}>
          Retirer
        </button>
      </div>
    </div>
  )
}

function SavedPlaceCard({
  place,
  onFocus,
  onRoute,
  onEditStart,
  onEditCancel,
  onEditSave,
  onEditNameChange,
  onDelete,
  isEditing,
  editingName,
  editingError,
}: {
  place: SavedPlace
  onFocus: () => void
  onRoute: () => void
  onEditStart: () => void
  onEditCancel: () => void
  onEditSave: () => void
  onEditNameChange: (value: string) => void
  onDelete: () => void
  isEditing: boolean
  editingName: string
  editingError: string | null
}) {
  return (
    <div className="saved-card">
      {isEditing ? (
        <SavedPlaceEditor
          place={place}
          value={editingName}
          error={editingError}
          onChange={onEditNameChange}
          onSave={onEditSave}
          onCancel={onEditCancel}
        />
      ) : (
        <>
          <button className="saved-card-main" onClick={onFocus}>
            <span className="saved-place-kind">{savedPlaceKindLabel(place.kind)}</span>
            <strong>{place.name}</strong>
            <small>{place.address}</small>
          </button>
          <div className="inline-actions">
            <button className="secondary-button" onClick={onRoute}>
              Itinéraire
            </button>
            <button className="ghost-button" onClick={onEditStart}>
              Modifier
            </button>
            <button className="ghost-button" onClick={onDelete}>
              Retirer
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function SavedPlaceListItem({
  place,
  onFocus,
  onRoute,
  onEditStart,
  onEditCancel,
  onEditSave,
  onEditNameChange,
  onDelete,
  isEditing,
  editingName,
  editingError,
}: {
  place: SavedPlace
  onFocus: () => void
  onRoute: () => void
  onEditStart: () => void
  onEditCancel: () => void
  onEditSave: () => void
  onEditNameChange: (value: string) => void
  onDelete: () => void
  isEditing: boolean
  editingName: string
  editingError: string | null
}) {
  return (
    <div className="saved-list-item">
      {isEditing ? (
        <SavedPlaceEditor
          place={place}
          value={editingName}
          error={editingError}
          onChange={onEditNameChange}
          onSave={onEditSave}
          onCancel={onEditCancel}
        />
      ) : (
        <>
          <button className="saved-list-main" onClick={onFocus}>
            <span className="saved-place-kind">{savedPlaceKindLabel(place.kind)}</span>
            <strong>{place.name}</strong>
            <small>{place.address}</small>
          </button>
          <div className="row-actions">
            <button className="secondary-button compact-action" onClick={onRoute}>
              Itinéraire
            </button>
            <button className="ghost-button compact-action" onClick={onEditStart}>
              Modifier
            </button>
            <button className="ghost-button compact-action" onClick={onDelete}>
              Retirer
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function SavedPlaceEditor({
  place,
  value,
  error,
  onChange,
  onSave,
  onCancel,
}: {
  place: SavedPlace
  value: string
  error: string | null
  onChange: (value: string) => void
  onSave: () => void
  onCancel: () => void
}) {
  return (
    <div className="saved-place-editor">
      <span className="saved-place-kind">{savedPlaceKindLabel(place.kind)}</span>
      <label className="profile-field compact-field">
        <span>Nom visible</span>
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Nom de cette adresse"
        />
      </label>
      <small>{place.address}</small>
      {error ? <p className="panel-copy">{error}</p> : null}
      <div className="inline-actions">
        <button className="secondary-button" onClick={onSave}>
          Enregistrer
        </button>
        <button className="ghost-button" onClick={onCancel}>
          Annuler
        </button>
      </div>
    </div>
  )
}

function PlaceholderCard({
  title,
  body,
  actionLabel,
  onAction,
}: {
  title: string
  body: string
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <div className="saved-card placeholder">
      <span className="saved-place-kind">{title}</span>
      <strong>{title}</strong>
      <small>{body}</small>
      {actionLabel ? (
        <button
          className="ghost-button compact-action"
          onClick={() => onAction?.()}
          disabled={!onAction}
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  )
}

function deriveModes(
  viewMode: ViewMode,
  selectedItem: SearchItem | FavoriteItem | null,
  itinerary: Itinerary | null,
): TransportMode[] {
  if (selectedItem?.type === 'route') {
    return [selectedItem.mode]
  }

  if (itinerary?.mode === 'transit') {
    const rideModes = itinerary.segments
      .filter((segment) => segment.kind === 'ride')
      .map((segment) => segment.mode)
      .filter((mode): mode is TransportMode => mode === 'bus' || mode === 'metro' || mode === 'rem')

    return rideModes.length > 0
      ? uniqueTransportModes(rideModes)
      : (['bus', 'metro', 'rem'] satisfies TransportMode[])
  }

  if (viewMode === 'combined' || viewMode === 'bixi') {
    return ['bus', 'metro', 'rem']
  }

  return [viewMode]
}

function modesFromViewMode(viewMode: ViewMode): TransportMode[] {
  if (viewMode === 'combined' || viewMode === 'bixi') {
    return ['bus', 'metro', 'rem']
  }

  return [viewMode]
}

function toFavoriteItem(item: SearchItem | FavoriteItem): FavoriteItem {
  if ('pinnedToMap' in item) {
    return item
  }

  return {
    type: item.type,
    id: item.id,
    mode: item.mode,
    label: item.label,
    subtitle: item.subtitle,
    lat: item.lat,
    lon: item.lon,
    pinnedToMap: item.type === 'route',
  }
}

function toSavedPlace(
  place: ResolvedPlace,
  kind: SavedPlace['kind'],
  name = defaultSavedPlaceName(place, kind),
): SavedPlace {
  return {
    ...place,
    kind,
    name,
  }
}

function toResolvedPlace(
  place: ResolvedPlace | SavedPlace | SearchItem,
): ResolvedPlace {
  if ('address' in place) {
    return {
      id: place.id,
      label: place.label,
      address: place.address,
      placeType: place.placeType,
      relevance: place.relevance,
      lat: place.lat,
      lon: place.lon,
    }
  }

  return {
    id: `${place.type}:${place.id}`,
    label: place.label,
    address: place.subtitle,
    placeType: place.type,
    relevance: 1,
    lat: place.lat,
    lon: place.lon,
  }
}

function routeInputDisplay(place: ResolvedPlace) {
  if (place.label === CURRENT_LOCATION_PLACEHOLDER) {
    return CURRENT_LOCATION_PLACEHOLDER
  }

  if (place.placeType === 'address' && extractStreetNumber(place.label)) {
    return place.label
  }

  if (place.placeType === 'station' || place.placeType === 'route') {
    return place.label
  }

  if (place.address === 'Station de métro' || place.address === 'Station du REM') {
    return place.label
  }

  return place.address || place.label
}

function buildRouteCameraRequest(
  bootstrap: BootstrapResponse,
  routeIds: string[],
): MapCameraRequest {
  const routeIdSet = new Set(routeIds)
  const points = bootstrap.shapes
    .filter((shape) => routeIdSet.has(shape.routeId))
    .flatMap((shape) => shape.coordinates)

  return {
    id: createRequestId('route'),
    kind: 'bounds',
    points: points.length > 0
      ? points
      : bootstrap.routes
          .filter((route) => routeIdSet.has(route.id))
          .map((route) => route.center),
    padding: 96,
    duration: 760,
  }
}

function summarizeLiveEntities(entities: LiveEntity[]) {
  return entities.reduce(
    (summary, entity) => {
      if (entity.mode === 'bus' && entity.positionSource === 'realtime') {
        summary.busRealtime += 1
      }

      if (entity.mode === 'metro') {
        summary.metroEstimated += 1
      }

      if (entity.mode === 'rem') {
        summary.remEstimated += 1
      }

      return summary
    },
    {
      busRealtime: 0,
      metroEstimated: 0,
      remEstimated: 0,
    },
  )
}

function summarizeServiceStates(states: ServiceState[]) {
  const warnings = states.filter(
    (state) => state.status === 'warning' || state.status === 'interruption',
  )
  const normal = states.filter((state) => state.status === 'normal')

  if (warnings.length === 0 && normal.length === 0) {
    return 'Aucune donnée'
  }

  if (warnings.length === 0) {
    return `${normal.length} ligne${normal.length > 1 ? 's' : ''} normale${normal.length > 1 ? 's' : ''}`
  }

  return `${warnings.length} alerte${warnings.length > 1 ? 's' : ''}`
}

function serviceStatusLabel(status: ServiceState['status']) {
  if (status === 'normal') return 'Normal'
  if (status === 'interruption') return 'Interruption'
  if (status === 'warning') return 'À surveiller'
  return 'Inconnu'
}

function permissionStateToPreference(state: PermissionState): LocationPreference {
  if (state === 'granted') return 'granted'
  if (state === 'denied') return 'denied'
  return 'unknown'
}

function locationPreferenceLabel(
  preference: LocationPreference,
  hasRequestedLocation: boolean,
) {
  if (preference === 'granted') return 'Autorisée'
  if (preference === 'denied') {
    return hasRequestedLocation ? 'Bloquée' : 'À autoriser'
  }
  if (preference === 'prompt-dismissed') return 'À confirmer'
  return 'Optionnelle'
}

function liveStatusLine(live: LiveResponse | null, isFetchingLive: boolean) {
  if (isFetchingLive) {
    return 'Actualisation en cours…'
  }

  const timestamp = live?.sourceTimestamp || live?.generatedAt
  if (!timestamp) {
    return 'Actualisation environ toutes les 8 secondes'
  }

  const formatted = new Intl.DateTimeFormat('fr-CA', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestamp))

  return `Mis à jour à ${formatted} • environ toutes les 8 secondes`
}

function filterLiveResponse(
  live: LiveResponse | null,
  bootstrap: BootstrapResponse | null,
  input: {
    modes: TransportMode[]
    routeIds?: string[]
    selectedStation?: { id: string; lat: number; lon: number; routeIds: string[] } | null
  },
) {
  if (!live) {
    return null
  }

  const effectiveModes = new Set(input.modes)
  const routeFilter = new Set(input.routeIds?.filter(Boolean) ?? [])
  const selectedStation = input.selectedStation ?? null
  const selectedStationRoutes = new Set(selectedStation?.routeIds ?? [])

  const entities = live.entities.filter((entity) => {
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

    return haversineKm(entity.lat, entity.lon, selectedStation.lat, selectedStation.lon) <= 1.1
  })

  const serviceStates = live.serviceStates.filter((state) => {
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

  if (routeFilter.size > 0 && bootstrap) {
    for (const routeId of routeFilter) {
      if (serviceStates.some((state) => state.routeId === routeId)) {
        continue
      }

      const route = bootstrap.routes.find((entry) => entry.id === routeId)
      if (!route) {
        continue
      }

      serviceStates.unshift({
        routeId,
        mode: route.mode,
        status: 'normal',
        message:
          route.mode === 'bus'
            ? 'Aucune perturbation publique signalée pour cette ligne.'
            : 'Service surveillé, sans alerte spécifique.',
        updatedAt: live.sourceTimestamp || live.generatedAt,
      })
    }
  }

  return {
    ...live,
    entities,
    serviceStates,
  } satisfies LiveResponse
}

function stabilizeLiveResponse(previous: LiveResponse | null, next: LiveResponse) {
  if (!previous) {
    return next
  }

  const nextTimestamp = Date.parse(next.sourceTimestamp || next.generatedAt)
  if (!Number.isFinite(nextTimestamp)) {
    return next
  }

  const incomingIds = new Set(next.entities.map((entity) => entity.id))
  const carried = previous.entities.filter((entity) => {
    if (incomingIds.has(entity.id)) {
      return false
    }

    const updatedAt = Date.parse(entity.updatedAt || previous.sourceTimestamp || previous.generatedAt)
    return Number.isFinite(updatedAt) && nextTimestamp - updatedAt <= 18_000
  })

  if (carried.length === 0) {
    return next
  }

  return {
    ...next,
    entities: [...next.entities, ...carried],
  }
}

function formatDistanceKm(distanceKm: number) {
  return `${distanceKm.toFixed(distanceKm >= 10 ? 0 : 1)} km`
}

function segmentInstruction(segment: Itinerary['segments'][number]) {
  if (segment.mode === 'walking') {
    return `Marcher jusqu’à ${segment.to.label}`
  }

  if (segment.mode === 'cycling' || segment.mode === 'bixi') {
    return `Rouler jusqu’à ${segment.to.label}`
  }

  return `${segment.label} jusqu’à ${segment.to.label}`
}

function readAccountCache(userId: string) {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const raw = window.localStorage.getItem(`${ACCOUNT_CACHE_PREFIX}:${userId}`)
    if (!raw) {
      return null
    }

    const parsed = JSON.parse(raw) as {
      favorites?: FavoriteItem[]
      profile?: UserProfile
    } | null

    return {
      favorites: Array.isArray(parsed?.favorites) ? parsed.favorites : [],
      profile: sanitizeCachedProfile(parsed?.profile),
    }
  } catch {
    return null
  }
}

function writeAccountCache(
  userId: string,
  input: Partial<{
    favorites: FavoriteItem[]
    profile: UserProfile
  }>,
) {
  if (typeof window === 'undefined') {
    return
  }

  const previous = readAccountCache(userId)
  const payload = {
    favorites: input.favorites ?? previous?.favorites ?? [],
    profile: input.profile ?? previous?.profile ?? DEFAULT_PROFILE,
  }

  try {
    window.localStorage.setItem(
      `${ACCOUNT_CACHE_PREFIX}:${userId}`,
      JSON.stringify(payload),
    )
  } catch {
    // Ignore storage quota or private-mode failures.
  }
}

function sanitizeCachedProfile(profile: unknown): UserProfile {
  if (!profile || typeof profile !== 'object') {
    return DEFAULT_PROFILE
  }

  const value = profile as Partial<UserProfile>

  return {
    displayName: typeof value.displayName === 'string' ? value.displayName : '',
    savedPlaces: Array.isArray(value.savedPlaces) ? value.savedPlaces : [],
    locationPreference:
      value.locationPreference === 'granted' ||
      value.locationPreference === 'denied' ||
      value.locationPreference === 'prompt-dismissed'
        ? value.locationPreference
        : 'unknown',
  }
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)))
}

function uniqueTransportModes(values: TransportMode[]) {
  return Array.from(new Set(values))
}

function normalizeRouteText(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
}

function createRequestId(prefix: string) {
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
}

function extractStreetNumber(value: string) {
  return value.match(/\b\d{1,6}\b/u)?.[0] ?? null
}

function savedPlaceKindLabel(kind: SavedPlace['kind']) {
  if (kind === 'home') {
    return 'Domicile'
  }

  if (kind === 'work') {
    return 'Travail'
  }

  return 'Adresse'
}

function defaultSavedPlaceName(
  place: ResolvedPlace,
  kind: SavedPlace['kind'] = 'saved',
) {
  if (kind === 'home') {
    return 'Domicile'
  }

  if (kind === 'work') {
    return 'Travail'
  }

  const baseLabel = place.label === CURRENT_LOCATION_PLACEHOLDER
    ? 'Adresse enregistrée'
    : (place.label || place.address).split(',')[0] || place.label || place.address

  return baseLabel.trim().slice(0, 60)
}

function searchSavedPlaces(savedPlaces: SavedPlace[], query: string) {
  const trimmed = query.trim()
  if (!trimmed) {
    return []
  }

  return [...savedPlaces]
    .map((place) => ({
      place,
      score: scoreSavedPlaceSearch(place, trimmed),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.place)
}

function scoreSavedPlaceSearch(place: SavedPlace, query: string) {
  const normalizedQuery = normalizeRouteText(query)
  const haystack = normalizeRouteText(
    `${place.name} ${place.label} ${place.address} ${savedPlaceKindLabel(place.kind)}`,
  )

  if (!normalizedQuery) {
    return 0
  }

  let score = 0

  if (normalizeRouteText(place.name) === normalizedQuery) {
    score += 12
  }

  if (normalizeRouteText(place.label) === normalizedQuery) {
    score += 8
  }

  if (haystack.includes(normalizedQuery)) {
    score += 4
  }

  const queryTokens = normalizedQuery.split(/\s+/).filter(Boolean)
  score += queryTokens.filter((token) => haystack.includes(token)).length

  if (place.kind === 'home' || place.kind === 'work') {
    score += 0.5
  }

  return score
}

export default App
