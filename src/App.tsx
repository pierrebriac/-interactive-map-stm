import {
  startTransition,
  useDeferredValue,
  useEffect,
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

  const favoritesFocus =
    session && favorites.length > 0 && !selectedItem ? favorites : []
  const selectedPlannerStation = selectedStation
    ? toPlannerStation(selectedStation)
    : null
  const plannerResult = bootstrap
    ? buildPlanner(bootstrap, plannerOrigin, plannerDestination, plannerMode)
    : null
  const liveSummary = summarizeLiveEntities(live?.entities ?? [])
  const totalVisibleEntities = live?.entities.length ?? 0

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
            ? 'Trajet complet de la ligne affiché sur la carte. Clique sur un bus ou cherche un numéro pour isoler la ligne.'
            : 'La ligne et les stations associées sont isolées pour une lecture plus nette.',
      }
    : selectedStation
      ? {
          title: selectedStation.name,
          subtitle:
            selectedStation.mode === 'metro' ? 'Station de métro' : 'Station du REM',
          note:
            selectedStation.routeIds.length > 0
              ? `Correspondances visibles: ${selectedStation.routeIds
                  .map((routeId) =>
                    selectedStation.mode === 'metro' ? `ligne ${routeId}` : `REM ${routeId.replace(/^S/, 'A')}`,
                  )
                  .join(', ')}`
              : 'Stations et véhicules proches visibles autour du point choisi.',
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

        <div className="map-toolbar">
          <div className="toolbar-brand">
            <p className="eyebrow">Atlas STM / REM</p>
            <strong>Montréal Transit Atlas</strong>
          </div>

          <div className="toolbar-actions">
            {selectedItem ? (
              <button className="toolbar-button subtle" onClick={handleClearSelection}>
                Tout réafficher
              </button>
            ) : null}
            {isMobileViewport ? (
              <button
                className="toolbar-button primary"
                onClick={() => setIsPanelOpen((open) => !open)}
              >
                {isPanelOpen ? 'Voir la carte' : 'Recherche & filtres'}
              </button>
            ) : null}
          </div>
        </div>

        <div className="map-overlay">
          <div>
            <p className="overlay-title">
              {selectedRoute
                ? `Ligne ${selectedRoute.shortName}`
                : selectedStation
                  ? 'Station ciblée'
                  : viewMode === 'combined'
                    ? 'Vue combinée clarifiée'
                    : `Vue ${modeLabel(viewMode)}`}
            </p>
            <p className="overlay-copy">
              {selectedRoute
                ? 'Le tracé complet est visible, avec les véhicules de la ligne en priorité.'
                : selectedStation
                  ? 'Les correspondances et véhicules proches restent au premier plan.'
                  : isBootstrapping
                    ? 'Chargement du réseau de transport…'
                    : 'Bus live, rail estimé, lecture rapide par mode et par ligne.'}
            </p>
          </div>

          <div className="overlay-stats">
            <ModeStat label="Bus live" value={liveSummary.busRealtime} tone="bus" />
            <ModeStat label="Métro estimé" value={liveSummary.metroEstimated} tone="metro" />
            <ModeStat label="REM estimé" value={liveSummary.remEstimated} tone="rem" />
          </div>
        </div>

        {isMobileViewport ? (
          <button
            className="mobile-search-launch"
            onClick={() => setIsPanelOpen(true)}
          >
            Rechercher une ligne, une station ou planifier un trajet
          </button>
        ) : null}
      </main>

      <aside className={`control-panel ${isPanelOpen ? 'open' : 'closed'}`}>
        <div className="panel-header">
          <div>
            <p className="eyebrow">Contrôle en direct</p>
            <h1>Bus, métro, REM, puis le bon trajet.</h1>
            <p className="lede">
              Interface resserrée pour lire rapidement la ville, puis descendre au
              niveau d’une ligne ou d’un itinéraire.
            </p>
          </div>

          {isMobileViewport ? (
            <button
              className="panel-close"
              onClick={() => setIsPanelOpen(false)}
              aria-label="Fermer le panneau"
            >
              Fermer
            </button>
          ) : null}
        </div>

        <section className="panel-card overview-card">
          <div className="status-row">
            <span className="pill ghost">
              {isFetchingLive ? 'Mise à jour…' : 'Live actif'}
            </span>
            <span className={`pill ${live?.stale ? 'warn' : 'ok'}`}>
              {live?.stale ? 'Donnée possiblement périmée' : 'Flux à jour'}
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
        </section>

        <section className="panel-card">
          <div className="card-header-inline">
            <label className="card-title" htmlFor="search-input">
              Recherche
            </label>
            {searchQuery ? (
              <button
                className="text-action"
                onClick={() => {
                  setSearchQuery('')
                }}
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
            placeholder="Bus 24, ligne 2, Jean-Talon, Berri-UQAM…"
          />
          <p className="small-copy">
            La recherche locale répond tout de suite et remonte les lignes avant les
            stations quand tu tapes un numéro.
          </p>

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
            <p className="small-copy">Aucun résultat pour cette recherche.</p>
          ) : null}
        </section>

        <section className="panel-card compact-card">
          <div className="filter-group">
            <span className="card-title">Modes</span>
            <div className="segmented">
              {[
                ['combined', 'Combiné'],
                ['bus', 'Bus'],
                ['metro', 'Métro'],
                ['rem', 'REM'],
              ].map(([id, label]) => (
                <button
                  key={id}
                  className={viewMode === id ? 'segment active' : 'segment'}
                  onClick={() =>
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
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="filter-group">
            <span className="card-title">Carte</span>
            <div className="segmented two-up">
              {styleOptions.map((option) => (
                <button
                  key={option.id}
                  className={mapStyle === option.id ? 'segment active' : 'segment'}
                  disabled={!option.available}
                  onClick={() => setMapStyle(option.id)}
                  title={
                    option.available
                      ? option.label
                      : 'Style indisponible sans clé MapTiler'
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="panel-card selection-card">
          <div className="card-header-inline">
            <p className="card-title">Sélection</p>
            {selectedItem ? (
              <button className="text-action" onClick={handleClearSelection}>
                Réinitialiser
              </button>
            ) : null}
          </div>

          {selectionCard ? (
            <>
              <h2>{selectionCard.title}</h2>
              <p className="small-copy">{selectionCard.subtitle}</p>
              <p className="selection-note">{selectionCard.note}</p>

              <div className="selection-actions">
                <button
                  className="favorite-button"
                  onClick={() => void handleToggleFavorite()}
                  disabled={isSavingFavorite}
                >
                  {selectedFavorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}
                </button>
              </div>
            </>
          ) : (
            <p className="small-copy">
              Clique sur une ligne, une station, un bus ou utilise la recherche pour
              isoler le flux et afficher le trajet utile sur la carte.
            </p>
          )}

          <div className="legend-row">
            <LegendTone label="Temps réel" tone="live" />
            <LegendTone label="Estimé" tone="estimated" />
            <LegendTone label="Statut seulement" tone="status" />
          </div>
        </section>

        <section className="panel-card planner-card">
          <div className="card-header-inline">
            <div>
              <p className="card-title">Planificateur</p>
              <p className="small-copy">
                V1 centrée sur les stations déjà présentes dans l’atlas.
              </p>
            </div>
            <button className="text-action" onClick={handlePlannerSwap}>
              Inverser
            </button>
          </div>

          <div className="segmented two-up planner-mode-switch">
            <button
              className={plannerMode === 'transit' ? 'segment active' : 'segment'}
              onClick={() => setPlannerMode('transit')}
            >
              Transport
            </button>
            <button
              className={plannerMode === 'walking' ? 'segment active' : 'segment'}
              onClick={() => setPlannerMode('walking')}
            >
              À pied
            </button>
          </div>

          <div className="planner-fields">
            <div className="planner-field">
              <label className="card-title" htmlFor="planner-origin">
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

            <div className="planner-field">
              <label className="card-title" htmlFor="planner-destination">
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

          {plannerResult ? (
            <div className="planner-result">
              <div className="planner-summary">
                <strong>{plannerResult.durationMin} min</strong>
                <span>
                  {formatDistanceKm(plannerResult.distanceKm)} •{' '}
                  {plannerMode === 'transit'
                    ? `${plannerResult.transfers} correspondance${plannerResult.transfers > 1 ? 's' : ''}`
                    : 'marche estimée'}
                </span>
              </div>

              <div className="planner-steps">
                {plannerResult.segments.length > 0 ? (
                  plannerResult.segments.map((segment, index) => (
                    <div key={`${segment.label}:${index}`} className="planner-step">
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
              Aucun trajet transit calculé entre ces stations dans ce modèle.
              Essaie le mode à pied ou une autre paire de stations.
            </p>
          ) : (
            <p className="small-copy">
              Choisis un départ et une arrivée pour obtenir un temps de marche ou
              un parcours réseau estimé.
            </p>
          )}
        </section>

        <section className="panel-card">
          <div className="auth-row">
            <div>
              <p className="card-title">Favoris</p>
              <p className="small-copy">
                {session
                  ? session.email ?? 'Compte connecté'
                  : 'Connexion optionnelle pour synchroniser tes favoris'}
              </p>
            </div>

            {session ? (
              <button
                className="secondary-action"
                onClick={() => void logoutIdentity()}
              >
                Déconnexion
              </button>
            ) : (
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
            )}
          </div>

          {favorites.length > 0 ? (
            <div className="favorites-list">
              {favorites.map((favorite) => (
                <button
                  key={`${favorite.type}:${favorite.id}`}
                  className="favorite-chip"
                  onClick={() => handleSelectItem(favorite)}
                >
                  <strong>{favorite.label}</strong>
                  <small>{favorite.subtitle}</small>
                </button>
              ))}
            </div>
          ) : (
            <p className="small-copy">
              {session
                ? 'Aucun favori enregistré pour le moment.'
                : 'Connecte-toi pour sauvegarder des lignes et des stations.'}
            </p>
          )}
        </section>

        <section className="panel-card">
          <div className="card-header-inline">
            <div>
              <p className="card-title">État du service</p>
              <p className="small-copy">
                {viewMode === 'combined'
                  ? 'Vue filtrée pour éviter de noyer les alertes bus.'
                  : `Focus ${modeLabel(viewMode)}.`}
              </p>
            </div>
            {live ? (
              <small className="small-copy">
                {new Date(live.sourceTimestamp).toLocaleTimeString('fr-CA', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </small>
            ) : null}
          </div>

          <div className="state-list">
            {visibleServiceStates.map((state) => (
              <ServiceStateCard key={`${state.mode}:${state.routeId}`} state={state} />
            ))}
          </div>
        </section>

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

  return serviceStates.filter((state) => state.mode === viewMode)
}

function deriveModes(
  viewMode: ViewMode,
  selectedItem: SearchItem | FavoriteItem | null,
): TransportMode[] {
  if (selectedItem?.type === 'route') {
    return [selectedItem.mode]
  }

  if (viewMode === 'combined') {
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

function modeLabel(mode: Exclude<ViewMode, 'combined'>) {
  if (mode === 'bus') return 'bus'
  if (mode === 'metro') return 'métro'
  return 'REM'
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

function formatDistanceKm(distanceKm: number) {
  return `${distanceKm.toFixed(distanceKm >= 10 ? 0 : 1)} km`
}

function LegendTone({
  label,
  tone,
}: {
  label: string
  tone: 'live' | 'estimated' | 'status'
}) {
  return (
    <span className={`legend-tone ${tone}`}>
      <i />
      {label}
    </span>
  )
}

function ModeStat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'bus' | 'metro' | 'rem'
}) {
  return (
    <div className={`mode-stat ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
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
