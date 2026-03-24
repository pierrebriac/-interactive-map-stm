import {
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from 'react'
import './App.css'
import { MapView } from './components/MapView.tsx'
import {
  buildPlanner,
  type PlannerMode,
  type PlannerStation,
  toPlannerStation,
} from './lib/planner.ts'
import {
  fetchBootstrap,
  fetchFavorites,
  fetchLiveData,
  saveFavorites,
} from './lib/api.ts'
import { searchItems } from './lib/search.ts'
import {
  getIdentitySession,
  initIdentity,
  logoutIdentity,
  openIdentity,
  subscribeToIdentity,
} from './lib/auth.ts'
import type {
  BootstrapResponse,
  FavoriteItem,
  IdentitySession,
  LiveEntity,
  LiveResponse,
  MapStyle,
  SearchItem,
  ServiceState,
  TransportMode,
  ViewMode,
} from './shared/types.ts'

function App() {
  const initialMobile =
    typeof window !== 'undefined'
      ? window.matchMedia('(max-width: 960px)').matches
      : false

  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null)
  const [live, setLive] = useState<LiveResponse | null>(null)
  const [session, setSession] = useState<IdentitySession | null>(null)
  const [favorites, setFavorites] = useState<FavoriteItem[]>([])
  const [selectedItem, setSelectedItem] = useState<SearchItem | FavoriteItem | null>(
    null,
  )
  const [viewMode, setViewMode] = useState<ViewMode>('combined')
  const [mapStyle, setMapStyle] = useState<MapStyle>('streets')
  const [searchQuery, setSearchQuery] = useState('')
  const [appError, setAppError] = useState<string | null>(null)
  const [isBootstrapping, setIsBootstrapping] = useState(true)
  const [isFetchingLive, setIsFetchingLive] = useState(false)
  const [isSavingFavorite, setIsSavingFavorite] = useState(false)
  const [isMobileViewport, setIsMobileViewport] = useState(initialMobile)
  const [isPanelOpen, setIsPanelOpen] = useState(!initialMobile)
  const [plannerMode, setPlannerMode] = useState<PlannerMode>('transit')
  const [plannerOriginQuery, setPlannerOriginQuery] = useState('')
  const [plannerDestinationQuery, setPlannerDestinationQuery] = useState('')
  const [plannerOrigin, setPlannerOrigin] = useState<PlannerStation | null>(null)
  const [plannerDestination, setPlannerDestination] = useState<PlannerStation | null>(
    null,
  )
  const [plannerActiveField, setPlannerActiveField] = useState<
    'origin' | 'destination' | null
  >(null)
  const [serviceStatusOpen, setServiceStatusOpen] = useState(false)
  const [techStatsOpen, setTechStatsOpen] = useState(false)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') return 'light'
    const stored = localStorage.getItem('transit-atlas-theme')
    if (stored === 'dark' || stored === 'light') return stored
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('transit-atlas-theme', theme)
  }, [theme])

  const deferredSearchQuery = useDeferredValue(searchQuery)
  const selectedRouteId = selectedItem?.type === 'route' ? selectedItem.id : null
  const selectedStationId =
    selectedItem?.type === 'station' ? selectedItem.id : null

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
      } finally {
        if (!cancelled) {
          setIsBootstrapping(false)
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
      return
    }

    let cancelled = false

    const loadFavorites = async () => {
      try {
        const response = await fetchFavorites(session.token as string)
        if (!cancelled) {
          setFavorites(response.favorites)
        }
      } catch (error) {
        if (!cancelled) {
          setAppError(
            error instanceof Error
              ? error.message
              : 'Impossible de charger les favoris.',
          )
        }
      }
    }

    void loadFavorites()

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
        setIsPanelOpen(true)
      }
    }

    syncViewport()
    media.addEventListener('change', syncViewport)

    return () => media.removeEventListener('change', syncViewport)
  }, [])

  useEffect(() => {
    if (!bootstrap) {
      return
    }

    let cancelled = false
    let intervalId = 0

    const loadLive = async () => {
      setIsFetchingLive(true)
      const modes = deriveModes(viewMode, selectedItem)

      try {
        const data = await fetchLiveData({
          modes,
          routeId: selectedRouteId,
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
  }, [bootstrap, selectedItem, selectedRouteId, selectedStationId, viewMode])

  useEffect(() => {
    if (selectedItem || favorites.length === 0 || !session) {
      return
    }

    startTransition(() => {
      const primaryFavorite = favorites[0]
      if (primaryFavorite.type === 'route') {
        setViewMode(primaryFavorite.mode)
      }
    })
  }, [favorites, selectedItem, session])

  const searchResults = bootstrap
    ? searchItems(bootstrap.searchIndex, deferredSearchQuery, { limit: 14 })
    : []

  const plannerSearchPool = bootstrap
    ? bootstrap.searchIndex.filter(
        (item): item is SearchItem => item.type === 'station',
      )
    : []
  const plannerSuggestions =
    plannerActiveField === 'origin'
      ? searchItems(plannerSearchPool, plannerOriginQuery, {
          limit: 8,
          types: ['station'],
        })
      : plannerActiveField === 'destination'
        ? searchItems(plannerSearchPool, plannerDestinationQuery, {
            limit: 8,
            types: ['station'],
          })
        : []

  const visibleServiceStates = filterServiceStates(
    live?.serviceStates ?? [],
    viewMode,
    selectedItem,
    bootstrap,
  )
  const selectedRoute = bootstrap?.routes.find((route) => route.id === selectedRouteId)
  const selectedStation = bootstrap?.stations.find(
    (station) => station.id === selectedStationId,
  )
  const selectedFavorite =
    selectedItem &&
    favorites.some(
      (favorite) =>
        favorite.type === selectedItem.type && favorite.id === selectedItem.id,
    )

  const styleOptions = bootstrap?.styles ?? [
    { id: 'streets' as const, label: '2D', available: true },
    { id: 'satellite' as const, label: 'Aérien', available: false },
  ]

  const favoritesFocus = useMemo(
    () => (session && favorites.length > 0 && !selectedItem ? favorites : []),
    [session, favorites, selectedItem],
  )

  const selectedPlannerStation = selectedStation
    ? toPlannerStation(selectedStation)
    : null
  const plannerResult = bootstrap
    ? buildPlanner(bootstrap, plannerOrigin, plannerDestination, plannerMode)
    : null
  const liveSummary = summarizeLiveEntities(live?.entities ?? [])
  const totalVisibleEntities = live?.entities.length ?? 0

  const serviceStatusSummary = summarizeServiceStates(visibleServiceStates)

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
            ? 'Trajet complet affiché sur la carte.'
            : 'Ligne et stations associées isolées.',
      }
    : selectedStation
      ? {
          title: selectedStation.name,
          subtitle:
            selectedStation.mode === 'metro' ? 'Station de métro' : 'Station du REM',
          note:
            selectedStation.routeIds.length > 0
              ? `Correspondances: ${selectedStation.routeIds
                  .map((routeId) =>
                    selectedStation.mode === 'metro' ? `ligne ${routeId}` : `REM ${routeId.replace(/^S/, 'A')}`,
                  )
                  .join(', ')}`
              : 'Véhicules proches visibles.',
        }
      : null

  const handleSelectItem = (item: SearchItem | FavoriteItem) => {
    startTransition(() => {
      setSelectedItem(item)
      if (item.type === 'route') {
        setViewMode(item.mode)
      }
      setSearchQuery('')
      if (isMobileViewport) {
        setIsPanelOpen(false)
      }
    })
  }

  const handleClearSelection = () => {
    startTransition(() => {
      setSelectedItem(null)
      if (viewMode !== 'combined') {
        setViewMode(viewMode)
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
            !(
              favorite.type === nextFavorite.type && favorite.id === nextFavorite.id
            ),
        )
      : [nextFavorite, ...favorites].slice(0, 24)

    setIsSavingFavorite(true)
    setFavorites(nextFavorites)

    try {
      const response = await saveFavorites(session.token, nextFavorites)
      setFavorites(response.favorites)
    } catch (error) {
      setFavorites(favorites)
      setAppError(
        error instanceof Error
          ? error.message
          : 'Impossible de mettre à jour les favoris.',
      )
    } finally {
      setIsSavingFavorite(false)
    }
  }

  const handlePlannerFieldChange = (
    field: 'origin' | 'destination',
    value: string,
  ) => {
    setPlannerActiveField(field)

    if (field === 'origin') {
      setPlannerOriginQuery(value)
      if (plannerOrigin?.name !== value) {
        setPlannerOrigin(null)
      }
      return
    }

    setPlannerDestinationQuery(value)
    if (plannerDestination?.name !== value) {
      setPlannerDestination(null)
    }
  }

  const handlePlannerPick = (field: 'origin' | 'destination', item: SearchItem) => {
    const station = toPlannerStation(item)
    if (!station) {
      return
    }

    if (field === 'origin') {
      setPlannerOrigin(station)
      setPlannerOriginQuery(station.name)
    } else {
      setPlannerDestination(station)
      setPlannerDestinationQuery(station.name)
    }

    setPlannerActiveField(null)
  }

  const handlePlannerUseSelectedStation = (field: 'origin' | 'destination') => {
    if (!selectedPlannerStation) {
      return
    }

    if (field === 'origin') {
      setPlannerOrigin(selectedPlannerStation)
      setPlannerOriginQuery(selectedPlannerStation.name)
    } else {
      setPlannerDestination(selectedPlannerStation)
      setPlannerDestinationQuery(selectedPlannerStation.name)
    }

    setPlannerActiveField(null)
  }

  const handlePlannerSwap = () => {
    setPlannerOrigin(plannerDestination)
    setPlannerDestination(plannerOrigin)
    setPlannerOriginQuery(plannerDestination?.name ?? '')
    setPlannerDestinationQuery(plannerOrigin?.name ?? '')
  }

  return (
    <div className={`app-shell ${isPanelOpen ? 'panel-open' : 'panel-closed'}`}>
      <main className="map-panel">
        <MapView
          bootstrap={bootstrap}
          live={live}
          selectedItem={selectedItem}
          viewMode={viewMode}
          mapStyle={mapStyle}
          favoritesFocus={favoritesFocus}
          onSelectItem={handleSelectItem}
        />

        {/* Map toolbar */}
        <div className="map-toolbar">
          <div className="toolbar-brand">
            <strong>Transit Atlas</strong>
            <span className={`freshness-dot ${live?.stale ? 'stale' : isFetchingLive ? 'updating' : 'fresh'}`} />
          </div>

          <div className="toolbar-actions">
            {selectedItem ? (
              <button className="toolbar-button subtle" onClick={handleClearSelection}>
                Tout réafficher
              </button>
            ) : null}

            <button
              className="toolbar-button subtle icon-button"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              title={theme === 'dark' ? 'Mode clair' : 'Mode sombre'}
            >
              {theme === 'dark' ? '☀' : '◑'}
            </button>

            {styleOptions.length > 1 ? (
              <button
                className="toolbar-button subtle icon-button"
                onClick={() => setMapStyle(mapStyle === 'streets' ? 'satellite' : 'streets')}
                disabled={!styleOptions.find(o => o.id === 'satellite')?.available}
                title={mapStyle === 'streets' ? 'Vue aérienne' : 'Vue 2D'}
              >
                {mapStyle === 'streets' ? '🛰' : '🗺'}
              </button>
            ) : null}

            {isMobileViewport ? (
              <button
                className="toolbar-button primary"
                onClick={() => setIsPanelOpen((open) => !open)}
              >
                {isPanelOpen ? 'Carte' : 'Menu'}
              </button>
            ) : null}
          </div>
        </div>

        {/* Map legend overlay */}
        <div className="map-legend">
          <span className="legend-item"><i className="dot dot-live" />Temps réel</span>
          <span className="legend-item"><i className="dot dot-estimated" />Estimé</span>
          <span className="legend-item"><i className="dot dot-status" />Statut</span>
        </div>

        {/* Contextual info overlay - simplified */}
        {(selectedRoute || selectedStation || isBootstrapping) ? (
          <div className="map-overlay">
            <p className="overlay-title">
              {selectedRoute
                ? `Ligne ${selectedRoute.shortName}`
                : selectedStation
                  ? 'Station ciblée'
                  : 'Chargement…'}
            </p>
            <p className="overlay-copy">
              {selectedRoute
                ? 'Tracé complet avec véhicules de la ligne.'
                : selectedStation
                  ? 'Correspondances et véhicules proches.'
                  : 'Chargement du réseau de transport…'}
            </p>
          </div>
        ) : null}
      </main>

      {/* Sidebar / Bottom sheet */}
      <aside className={`control-panel ${isPanelOpen ? 'open' : 'closed'}`}>
        {/* Drag handle (mobile) */}
        {isMobileViewport ? (
          <div className="sheet-handle-row" onClick={() => setIsPanelOpen(o => !o)}>
            <div className="sheet-handle" />
          </div>
        ) : null}

        {/* 1. Header - simplified */}
        <div className="panel-header">
          <div>
            <h1>Transit Atlas</h1>
            <p className="header-subtitle">Montréal en direct</p>
          </div>
          {isMobileViewport ? (
            <button
              className="panel-close"
              onClick={() => setIsPanelOpen(false)}
              aria-label="Fermer le panneau"
            >
              ✕
            </button>
          ) : null}
        </div>

        {/* 2. Favorites (HERO) */}
        <section className="panel-card favorites-card">
          <div className="card-header-inline">
            <p className="card-title">★ Favoris</p>
            {session ? (
              <button
                className="text-action"
                onClick={() => void logoutIdentity()}
              >
                {session.email ? session.email.split('@')[0] : 'Déconnexion'}
              </button>
            ) : null}
          </div>

          {favorites.length > 0 ? (
            <div className="favorites-grid">
              {favorites.map((favorite) => (
                <button
                  key={`${favorite.type}:${favorite.id}`}
                  className={`favorite-chip mode-${favorite.mode}`}
                  onClick={() => handleSelectItem(favorite)}
                >
                  <strong>{favorite.label}</strong>
                  <small>{favorite.subtitle}</small>
                </button>
              ))}
            </div>
          ) : (
            <div className="favorites-empty">
              {session ? (
                <p className="small-copy">
                  Cherche une ligne ou une station, puis ajoute-la avec ★
                </p>
              ) : (
                <>
                  <p className="small-copy">
                    Connecte-toi pour retrouver tes lignes favorites dès l'ouverture.
                  </p>
                  <div className="auth-actions">
                    <button
                      className="secondary-action"
                      onClick={() => openIdentity('login')}
                    >
                      Connexion
                    </button>
                    <button
                      className="primary-action"
                      onClick={() => openIdentity('signup')}
                    >
                      Créer un compte
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </section>

        {/* 3. Search */}
        <section className="panel-card">
          <div className="card-header-inline">
            <label className="card-title" htmlFor="search-input">
              Recherche
            </label>
            {searchQuery ? (
              <button
                className="text-action"
                onClick={() => setSearchQuery('')}
              >
                Effacer
              </button>
            ) : null}
          </div>

          <input
            id="search-input"
            className="search-input"
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value)
              if (isMobileViewport) {
                setIsPanelOpen(true)
              }
            }}
            placeholder="Bus 24, ligne 2, Jean-Talon…"
          />

          {searchResults.length > 0 ? (
            <div className="search-results">
              {searchResults.map((item) => (
                <button
                  key={`${item.type}:${item.id}`}
                  className={`search-result ${
                    selectedItem?.type === item.type && selectedItem.id === item.id
                      ? 'active'
                      : ''
                  }`}
                  onClick={() => handleSelectItem(item)}
                >
                  <div className="search-result-top">
                    <span>{item.label}</span>
                    <span className={`result-badge ${item.mode}`}>
                      {item.type === 'route'
                        ? item.mode === 'bus'
                          ? 'Bus'
                          : item.mode === 'metro'
                            ? 'Métro'
                            : 'REM'
                        : 'Station'}
                    </span>
                  </div>
                  <small>{item.subtitle}</small>
                </button>
              ))}
            </div>
          ) : searchQuery.trim() ? (
            <p className="small-copy">Aucun résultat.</p>
          ) : null}
        </section>

        {/* 4. Mode filter */}
        <section className="panel-card compact-card">
          <span className="card-title">Modes</span>
          <div className="segmented five-up">
            {(
              [
                ['combined', 'Tous'],
                ['bus', 'Bus'],
                ['metro', 'Métro'],
                ['rem', 'REM'],
                ['bixi', 'BIXI'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                className={`segment ${viewMode === id ? 'active' : ''} ${id === 'bixi' ? 'bixi-segment' : ''}`}
                onClick={() => {
                  if (id === 'bixi') return
                  startTransition(() => {
                    setViewMode(id as ViewMode)
                    if (
                      selectedItem?.type === 'route' &&
                      selectedItem.mode !== id &&
                      id !== 'combined'
                    ) {
                      setSelectedItem(null)
                    }
                  })
                }}
                disabled={id === 'bixi'}
              >
                {label}
                {id === 'bixi' ? <span className="coming-soon-badge">Bientôt</span> : null}
              </button>
            ))}
          </div>
        </section>

        {/* 5. Selection card - only when selected */}
        {selectionCard ? (
          <section className="panel-card selection-card">
            <div className="card-header-inline">
              <div>
                <h2>{selectionCard.title}</h2>
                <p className="small-copy">{selectionCard.subtitle}</p>
              </div>
              <div className="selection-header-actions">
                <button
                  className="icon-action star-button"
                  onClick={() => void handleToggleFavorite()}
                  disabled={isSavingFavorite}
                  title={selectedFavorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}
                >
                  {selectedFavorite ? '★' : '☆'}
                </button>
                <button className="text-action" onClick={handleClearSelection}>
                  ✕
                </button>
              </div>
            </div>
            <p className="small-copy selection-note">{selectionCard.note}</p>
          </section>
        ) : null}

        {/* 6. Planner */}
        <section className="panel-card planner-card">
          <p className="card-title">Planificateur</p>

          <div className="segmented three-up planner-mode-switch">
            {(
              [
                ['transit', '🚇', 'Transport'],
                ['walking', '🚶', 'À pied'],
                ['bixi', '🚲', 'BIXI'],
              ] as const
            ).map(([id, icon, label]) => (
              <button
                key={id}
                className={`segment ${plannerMode === id ? 'active' : ''} ${id === 'bixi' ? 'bixi-segment' : ''}`}
                onClick={() => setPlannerMode(id)}
                disabled={id === 'bixi'}
              >
                <span className="segment-icon">{icon}</span>
                {label}
                {id === 'bixi' ? <span className="coming-soon-badge">Bientôt</span> : null}
              </button>
            ))}
          </div>

          <div className="planner-fields-wrapper">
            <div className="planner-timeline">
              <span className="timeline-dot origin-dot" />
              <span className="timeline-line" />
              <span className="timeline-dot destination-dot" />
            </div>

            <div className="planner-fields">
              <div className="planner-field">
                <label className="field-label" htmlFor="planner-origin">
                  Départ
                </label>
                <input
                  id="planner-origin"
                  className="search-input"
                  value={plannerOriginQuery}
                  onFocus={() => setPlannerActiveField('origin')}
                  onChange={(event) =>
                    handlePlannerFieldChange('origin', event.target.value)
                  }
                  placeholder="Choisir une station"
                />
              </div>

              <button
                className="swap-button"
                onClick={handlePlannerSwap}
                title="Inverser départ et arrivée"
              >
                ⇅
              </button>

              <div className="planner-field">
                <label className="field-label" htmlFor="planner-destination">
                  Arrivée
                </label>
                <input
                  id="planner-destination"
                  className="search-input"
                  value={plannerDestinationQuery}
                  onFocus={() => setPlannerActiveField('destination')}
                  onChange={(event) =>
                    handlePlannerFieldChange('destination', event.target.value)
                  }
                  placeholder="Choisir une station"
                />
              </div>
            </div>
          </div>

          {selectedPlannerStation ? (
            <div className="planner-shortcuts">
              <button
                className="secondary-action"
                onClick={() => handlePlannerUseSelectedStation('origin')}
              >
                Départ = {selectedPlannerStation.name}
              </button>
              <button
                className="secondary-action"
                onClick={() => handlePlannerUseSelectedStation('destination')}
              >
                Arrivée = {selectedPlannerStation.name}
              </button>
            </div>
          ) : null}

          {plannerSuggestions.length > 0 ? (
            <div className="search-results planner-results">
              {plannerSuggestions.map((item) => (
                <button
                  key={`planner:${item.id}`}
                  className="search-result"
                  onClick={() =>
                    handlePlannerPick(plannerActiveField ?? 'origin', item)
                  }
                >
                  <div className="search-result-top">
                    <span>{item.label}</span>
                    <span className={`result-badge ${item.mode}`}>Station</span>
                  </div>
                  <small>{item.subtitle}</small>
                </button>
              ))}
            </div>
          ) : null}

          {plannerMode === 'bixi' ? (
            <div className="planner-bixi-placeholder">
              <p className="small-copy">
                Le calcul d'itinéraire BIXI sera bientôt disponible.
              </p>
            </div>
          ) : plannerResult ? (
            <div className="planner-result">
              <div className="planner-summary">
                <div className="planner-duration">
                  <strong>{plannerResult.durationMin}</strong>
                  <span>min</span>
                </div>
                <span className="planner-details">
                  {formatDistanceKm(plannerResult.distanceKm)} •{' '}
                  {plannerMode === 'transit'
                    ? `${plannerResult.transfers} correspondance${plannerResult.transfers > 1 ? 's' : ''}`
                    : 'marche estimée'}
                </span>
              </div>

              <div className="planner-steps">
                {plannerResult.segments.length > 0 ? (
                  plannerResult.segments.map((segment, index) => (
                    <div
                      key={`${segment.label}:${index}`}
                      className={`planner-step step-${segment.mode} ${segment.kind === 'walk' ? 'step-walk' : ''}`}
                    >
                      <div className="planner-step-top">
                        <strong>{segment.label}</strong>
                        <span>{segment.durationMin} min</span>
                      </div>
                      <p>
                        {segment.from} → {segment.to}
                        {segment.kind === 'ride' && segment.stops
                          ? ` • ${segment.stops} arrêt${segment.stops > 1 ? 's' : ''}`
                          : ''}
                      </p>
                    </div>
                  ))
                ) : (
                  <p className="small-copy">Départ et arrivée identiques.</p>
                )}
              </div>

              {plannerResult.warnings.map((warning) => (
                <p key={warning} className="small-copy planner-note">
                  {warning}
                </p>
              ))}
            </div>
          ) : plannerOrigin && plannerDestination ? (
            <p className="small-copy">
              Aucun trajet trouvé. Essaie un autre mode ou d'autres stations.
            </p>
          ) : (
            <p className="small-copy">
              Choisis un départ et une arrivée.
            </p>
          )}
        </section>

        {/* 7. Service status - collapsed */}
        <section className="panel-card collapsible-card">
          <button
            className="collapsible-header"
            onClick={() => setServiceStatusOpen(open => !open)}
          >
            <div>
              <p className="card-title">État du service</p>
              <p className="small-copy">{serviceStatusSummary}</p>
            </div>
            <span className={`chevron ${serviceStatusOpen ? 'open' : ''}`}>›</span>
          </button>

          {serviceStatusOpen ? (
            <div className="state-list">
              {visibleServiceStates.length > 0 ? (
                visibleServiceStates.map((state) => (
                  <ServiceStateCard key={`${state.mode}:${state.routeId}`} state={state} />
                ))
              ) : (
                <p className="small-copy">Aucune alerte en cours.</p>
              )}
            </div>
          ) : null}
        </section>

        {/* 8. Tech stats - collapsed */}
        <section className="panel-card collapsible-card">
          <button
            className="collapsible-header"
            onClick={() => setTechStatsOpen(open => !open)}
          >
            <div>
              <p className="card-title">Statistiques</p>
              <p className="small-copy">
                {liveSummary.busRealtime} bus • {liveSummary.metroEstimated} métros • {liveSummary.remEstimated} REM
              </p>
            </div>
            <span className={`chevron ${techStatsOpen ? 'open' : ''}`}>›</span>
          </button>

          {techStatsOpen ? (
            <div className="tech-stats-content">
              <div className="status-row">
                <span className={`pill ${isFetchingLive ? 'ghost' : 'ok'}`}>
                  {isFetchingLive ? 'Mise à jour…' : 'Live actif'}
                </span>
                <span className={`pill ${live?.stale ? 'warn' : 'ok'}`}>
                  {live?.stale ? 'Données périmées' : 'Flux à jour'}
                </span>
              </div>

              <div className="summary-grid">
                <div className="summary-metric">
                  <strong>{liveSummary.busRealtime}</strong>
                  <span>bus suivis</span>
                </div>
                <div className="summary-metric">
                  <strong>{liveSummary.metroEstimated}</strong>
                  <span>métros estimés</span>
                </div>
                <div className="summary-metric">
                  <strong>{liveSummary.remEstimated}</strong>
                  <span>REM estimés</span>
                </div>
                <div className="summary-metric">
                  <strong>{totalVisibleEntities}</strong>
                  <span>points visibles</span>
                </div>
              </div>
            </div>
          ) : null}
        </section>

        {/* 9. Alerts */}
        {(appError || live?.warnings.length || bootstrap?.warnings.length) && (
          <section className="panel-card alert-card">
            <p className="card-title">Attention</p>
            {appError ? <p className="small-copy">{appError}</p> : null}
            {bootstrap?.warnings.map((warning) => (
              <p key={warning} className="small-copy">
                {warning}
              </p>
            ))}
            {live?.warnings.map((warning) => (
              <p key={warning} className="small-copy">
                {warning}
              </p>
            ))}
          </section>
        )}
      </aside>
    </div>
  )
}

function filterServiceStates(
  serviceStates: ServiceState[],
  viewMode: ViewMode,
  selectedItem: SearchItem | FavoriteItem | null,
  bootstrap: BootstrapResponse | null,
) {
  if (selectedItem?.type === 'route') {
    return serviceStates.filter((state) => state.routeId === selectedItem.id)
  }

  if (selectedItem?.type === 'station' && bootstrap) {
    const selectedStation = bootstrap.stations.find((station) => station.id === selectedItem.id)
    const selectedStationRoutes = new Set(selectedStation?.routeIds ?? [])
    return serviceStates.filter((state) => selectedStationRoutes.has(state.routeId))
  }

  if (viewMode === 'combined') {
    const nonBus = serviceStates.filter((state) => state.mode !== 'bus')
    const busWarnings = serviceStates
      .filter((state) => state.mode === 'bus')
      .slice(0, 8)

    return [...nonBus, ...busWarnings]
  }

  if (viewMode === 'bixi') {
    return []
  }

  return serviceStates.filter((state) => state.mode === viewMode)
}

function deriveModes(
  viewMode: ViewMode,
  selectedItem: SearchItem | FavoriteItem | null,
): TransportMode[] {
  if (selectedItem?.type === 'route') {
    return [selectedItem.mode]
  }

  if (viewMode === 'combined' || viewMode === 'bixi') {
    return ['bus', 'metro', 'rem']
  }

  return [viewMode]
}

function toFavoriteItem(item: SearchItem | FavoriteItem): FavoriteItem {
  if ('subtitle' in item && 'type' in item) {
    return {
      type: item.type,
      id: item.id,
      mode: item.mode,
      label: item.label,
      subtitle: item.subtitle,
      lat: item.lat,
      lon: item.lon,
    }
  }

  return item
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
  const warnings = states.filter(s => s.status === 'warning' || s.status === 'interruption')
  const normal = states.filter(s => s.status === 'normal')
  if (warnings.length === 0 && normal.length === 0) return 'Aucune donnée'
  if (warnings.length === 0) return `${normal.length} ligne${normal.length > 1 ? 's' : ''} normale${normal.length > 1 ? 's' : ''}`
  return `${warnings.length} alerte${warnings.length > 1 ? 's' : ''}`
}

function formatDistanceKm(distanceKm: number) {
  return `${distanceKm.toFixed(distanceKm >= 10 ? 0 : 1)} km`
}

function ServiceStateCard({ state }: { state: ServiceState }) {
  return (
    <div className={`service-state ${state.status}`}>
      <div className="service-state-top">
        <strong>
          {state.mode === 'bus'
            ? `Bus ${state.routeId}`
            : state.mode === 'metro'
              ? `Ligne ${state.routeId}`
              : `REM ${state.routeId.replace(/^S/, 'A')}`}
        </strong>
        <span>{serviceStatusLabel(state.status)}</span>
      </div>
      <p>{state.message}</p>
    </div>
  )
}

function serviceStatusLabel(status: ServiceState['status']) {
  if (status === 'normal') return 'Normal'
  if (status === 'interruption') return 'Interruption'
  if (status === 'warning') return 'À surveiller'
  return 'Inconnu'
}

export default App
