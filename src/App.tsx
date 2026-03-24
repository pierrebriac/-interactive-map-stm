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

const DEFAULT_PROFILE: UserProfile = {
  displayName: '',
  savedPlaces: [],
  locationPreference: 'unknown',
}

const CURRENT_LOCATION_PLACEHOLDER = 'Ma position'

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
  const [browserLocationPreference, setBrowserLocationPreference] =
    useState<LocationPreference>('unknown')
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

      try {
        const [favoritesResponse, profileResponse] = await Promise.all([
          fetchFavorites(token),
          fetchProfile(token),
        ])

        if (cancelled) {
          return
        }

        setFavorites(favoritesResponse.favorites)
        setProfile(profileResponse.profile)
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
  }, [session?.token])

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
    if (!bootstrap) {
      return
    }

    let cancelled = false
    let intervalId = 0

    const loadLive = async () => {
      setIsFetchingLive(true)

      try {
        const data = await fetchLiveData({
          modes: deriveModes(viewMode, selectedItem, selectedItinerary),
          routeIds: routeFocusIds,
          stationId: selectedStationId,
        })

        if (!cancelled) {
          setLive(data)
        }
      } catch (error) {
        if (!cancelled) {
          setAppError(
            error instanceof Error
              ? error.message
              : 'Impossible de charger les positions live.',
          )
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
  }, [bootstrap, routeFocusIds, selectedItem, selectedItinerary, selectedStationId, viewMode])

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
          setAppError(
            error instanceof Error
              ? error.message
              : 'Impossible de charger les suggestions d’adresses.',
          )
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
          setAppError(
            error instanceof Error
              ? error.message
              : 'Impossible de charger les suggestions de trajet.',
          )
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

  const effectiveRouteSuggestions = useMemo(() => {
    const deduped = new Map<string, ResolvedPlace>()

    for (const suggestion of [...routeSuggestions, ...routeStationSuggestions]) {
      deduped.set(`${suggestion.id}:${suggestion.address}`, suggestion)
    }

    return Array.from(deduped.values()).slice(0, 8)
  }, [routeStationSuggestions, routeSuggestions])

  useEffect(() => {
    if (!routeOrigin || !routeDestination || surfaceMode !== 'route') {
      setPlanItineraries([])
      setPlanWarnings([])
      setPlanError(null)
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
        setPlanWarnings(response.warnings)
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
  }, [routeDestination, routeMode, routeOrigin, surfaceMode])

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
      routes: networkSearchResults.filter((item) => item.type === 'route'),
      stations: networkSearchResults.filter((item) => item.type === 'station'),
      places: searchPlaces,
    }),
    [networkSearchResults, searchPlaces],
  )

  const serviceStatusSummary = summarizeServiceStates(live?.serviceStates ?? [])
  const liveSummary = summarizeLiveEntities(live?.entities ?? [])
  const styleOptions = bootstrap?.styles ?? [
    { id: 'streets' as const, label: '2D', available: true },
    { id: 'satellite' as const, label: 'Aérien', available: false },
  ]
  const homePlace = profile.savedPlaces.find((place) => place.kind === 'home') ?? null
  const workPlace = profile.savedPlaces.find((place) => place.kind === 'work') ?? null
  const extraPlaces = profile.savedPlaces.filter((place) => place.kind === 'saved')
  const effectiveLocationPreference =
    browserLocationPreference === 'granted'
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
      setSearchQuery(place.address)
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

  const handleSaveSelectedPlace = async (kind: SavedPlace['kind']) => {
    if (!session?.token) {
      openIdentity('signup')
      return
    }

    if (!selectedPlace) {
      return
    }

    const nextPlace = toSavedPlace(selectedPlace, kind)
    const basePlaces = profile.savedPlaces.filter((place) =>
      kind === 'saved' ? place.id !== nextPlace.id : place.kind !== kind,
    )

    await persistProfile({
      ...profile,
      savedPlaces:
        kind === 'saved'
          ? [nextPlace, ...basePlaces].slice(0, 10)
          : [nextPlace, ...basePlaces],
    })
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
              ? 'Accès à la localisation refusé.'
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
    }
  }

  const handleRoutePick = (field: RouteField, place: ResolvedPlace) => {
    const displayValue = routeInputDisplay(place)

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

  const handleRouteSwap = () => {
    setRouteOrigin(routeDestination)
    setRouteDestination(routeOrigin)
    setRouteOriginQuery(routeDestinationQuery)
    setRouteDestinationQuery(routeOriginQuery)
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
        setResolvedRouteField(field, bestPlace, bestPlace.address)
        return bestPlace
      }
    } catch (error) {
      setAppError(
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

  const searchPopoverVisible =
    isSearchExpanded ||
    surfaceMode === 'route' ||
    Boolean(searchQuery.trim()) ||
    searchSections.routes.length > 0 ||
    searchSections.stations.length > 0 ||
    searchSections.places.length > 0

  return (
    <div className={`app-shell ${isSidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}>
      <main className="map-panel">
        <MapView
          bootstrap={bootstrap}
          live={live}
          selectedItem={selectedItem}
          selectedPlace={selectedPlace}
          itinerary={selectedItinerary}
          viewMode={viewMode}
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
              <span className="search-leading">⌕</span>
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
                    ['transit', 'Transit'],
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
                  Calculer le trajet
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
                  }}
                >
                  Effacer
                </button>
              </div>

              {effectiveRouteSuggestions.length > 0 ? (
                <div className="search-section">
                  <p className="section-eyebrow">
                    {activeRouteField === 'origin' ? 'Suggestions départ' : 'Suggestions arrivée'}
                  </p>
                  <div className="stack-list">
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
              <p className="panel-copy">
                {session.email ?? 'Compte connecté'}{isSavingProfile ? ' • sauvegarde…' : ''}
              </p>
            </>
          ) : (
            <div className="auth-card">
              <p className="panel-copy">
                Connecte-toi pour enregistrer domicile, travail, favoris et préférences.
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

        <section className="sidebar-section">
          <div className="section-topline">
            <p className="section-eyebrow">Localisation</p>
            <span className={`permission-pill ${effectiveLocationPreference}`}>
              {locationPreferenceLabel(effectiveLocationPreference)}
            </span>
          </div>
          <div className="inline-actions">
            <button className="secondary-button" onClick={() => void handleLocateFromSidebar()}>
              {isLocating ? 'Localisation…' : 'Utiliser ma position'}
            </button>
            <button
              className="ghost-button"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? 'Mode clair' : 'Mode sombre'}
            </button>
          </div>
          {locationHint ? <p className="panel-copy">{locationHint}</p> : null}
        </section>

        {session ? (
          <section className="sidebar-section">
            <div className="section-topline">
              <p className="section-eyebrow">Adresses enregistrées</p>
              <span className="panel-copy">{profile.savedPlaces.length} adresses</span>
            </div>

            <div className="saved-place-grid">
              {homePlace ? (
                <SavedPlaceCard
                  place={homePlace}
                  onRoute={() => void handleRouteToSavedPlace(homePlace)}
                  onDelete={() => void handleDeleteSavedPlace(homePlace.id)}
                />
              ) : (
                <PlaceholderCard title="Domicile" body="Enregistre une adresse depuis la recherche." />
              )}

              {workPlace ? (
                <SavedPlaceCard
                  place={workPlace}
                  onRoute={() => void handleRouteToSavedPlace(workPlace)}
                  onDelete={() => void handleDeleteSavedPlace(workPlace.id)}
                />
              ) : (
                <PlaceholderCard title="Travail" body="Ajoute ton travail pour lancer un trajet en un geste." />
              )}
            </div>

            {extraPlaces.length > 0 ? (
              <div className="stack-list compact-stack">
                {extraPlaces.map((place) => (
                  <SavedPlaceListItem
                    key={place.id}
                    place={place}
                    onRoute={() => void handleRouteToSavedPlace(place)}
                    onDelete={() => void handleDeleteSavedPlace(place.id)}
                  />
                ))}
              </div>
            ) : (
              <p className="panel-copy">
                Sélectionne une adresse dans la recherche, puis enregistre-la ici.
              </p>
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
                <>
                  <button className="ghost-button" onClick={() => void handleSaveSelectedPlace('home')}>
                    Enregistrer en domicile
                  </button>
                  <button className="ghost-button" onClick={() => void handleSaveSelectedPlace('work')}>
                    Enregistrer en travail
                  </button>
                  <button className="ghost-button" onClick={() => void handleSaveSelectedPlace('saved')}>
                    Enregistrer
                  </button>
                </>
              ) : null}
            </div>
          </section>
        ) : null}

        {surfaceMode === 'route' ? (
          <section className="sidebar-section itinerary-section">
            <div className="section-topline">
              <p className="section-eyebrow">Résultats</p>
              <span className="panel-copy">
                {routeMode === 'transit'
                  ? 'Bus, métro, REM'
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
              <div className="stack-list step-stack">
                {selectedItinerary.segments.map((segment) => (
                  <div key={segment.id} className={`step-card mode-${segment.mode}`}>
                    <div className="itinerary-topline">
                      <strong>{segment.label}</strong>
                      <span>{segment.durationMin} min</span>
                    </div>
                    <p>
                      {segment.from.label} → {segment.to.label}
                    </p>
                  </div>
                ))}
              </div>
            ) : null}

            {planWarnings.map((warning) => (
              <p key={warning} className="panel-copy">
                {warning}
              </p>
            ))}
          </section>
        ) : null}

        <section className="sidebar-section">
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

        <section className="sidebar-section compact-controls">
          <div className="section-topline">
            <p className="section-eyebrow">Carte</p>
            <span className="panel-copy">{serviceStatusSummary}</span>
          </div>
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
}: {
  favorite: FavoriteItem
  live: LiveResponse | null
  onFocus: () => void
  onTogglePin: () => void
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
      {favorite.type === 'route' ? (
        <button className={`pin-toggle ${favorite.pinnedToMap ? 'active' : ''}`} onClick={onTogglePin}>
          {favorite.pinnedToMap ? 'Épinglé' : 'Afficher'}
        </button>
      ) : null}
    </div>
  )
}

function SavedPlaceCard({
  place,
  onRoute,
  onDelete,
}: {
  place: SavedPlace
  onRoute: () => void
  onDelete: () => void
}) {
  return (
    <div className="saved-card">
      <div>
        <span className="saved-place-kind">{savedPlaceKindLabel(place.kind)}</span>
        <strong>{place.name}</strong>
        <small>{place.address}</small>
      </div>
      <div className="inline-actions">
        <button className="secondary-button" onClick={onRoute}>
          Y aller
        </button>
        <button className="ghost-button" onClick={onDelete}>
          Retirer
        </button>
      </div>
    </div>
  )
}

function SavedPlaceListItem({
  place,
  onRoute,
  onDelete,
}: {
  place: SavedPlace
  onRoute: () => void
  onDelete: () => void
}) {
  return (
    <div className="saved-list-item">
      <button className="saved-list-main" onClick={onRoute}>
        <span className="saved-place-kind">{savedPlaceKindLabel(place.kind)}</span>
        <strong>{place.name}</strong>
        <small>{place.address}</small>
      </button>
      <button className="ghost-button" onClick={onDelete}>
        Retirer
      </button>
    </div>
  )
}

function PlaceholderCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="saved-card placeholder">
      <span className="saved-place-kind">{title}</span>
      <strong>{title}</strong>
      <small>{body}</small>
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

function toSavedPlace(place: ResolvedPlace, kind: SavedPlace['kind']): SavedPlace {
  return {
    ...place,
    kind,
    name:
      kind === 'home'
        ? 'Domicile'
        : kind === 'work'
          ? 'Travail'
          : place.label,
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

function locationPreferenceLabel(preference: LocationPreference) {
  if (preference === 'granted') return 'Autorisée'
  if (preference === 'denied') return 'Refusée'
  if (preference === 'prompt-dismissed') return 'À confirmer'
  return 'Non définie'
}

function formatDistanceKm(distanceKm: number) {
  return `${distanceKm.toFixed(distanceKm >= 10 ? 0 : 1)} km`
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

function savedPlaceKindLabel(kind: SavedPlace['kind']) {
  if (kind === 'home') {
    return 'Domicile'
  }

  if (kind === 'work') {
    return 'Travail'
  }

  return 'Adresse'
}

export default App
