import {
  startTransition,
  useDeferredValue,
  useEffect,
  useState,
} from 'react'
import './App.css'
import { MapView } from './components/MapView.tsx'
import {
  fetchBootstrap,
  fetchFavorites,
  fetchLiveData,
  fetchSearchResults,
  saveFavorites,
} from './lib/api.ts'
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
  LiveResponse,
  MapStyle,
  SearchItem,
  ServiceState,
  TransportMode,
  ViewMode,
} from './shared/types.ts'

function App() {
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
  const [searchResults, setSearchResults] = useState<SearchItem[]>([])
  const [appError, setAppError] = useState<string | null>(null)
  const [isBootstrapping, setIsBootstrapping] = useState(true)
  const [isFetchingLive, setIsFetchingLive] = useState(false)
  const [isSavingFavorite, setIsSavingFavorite] = useState(false)

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
    if (!deferredSearchQuery.trim()) {
      setSearchResults([])
      return
    }

    let cancelled = false

    const search = async () => {
      try {
        const results = await fetchSearchResults(deferredSearchQuery)
        if (!cancelled) {
          setSearchResults(results)
        }
      } catch (error) {
        if (!cancelled) {
          setAppError(
            error instanceof Error
              ? error.message
              : 'Impossible de lancer la recherche.',
          )
        }
      }
    }

    void search()

    return () => {
      cancelled = true
    }
  }, [deferredSearchQuery])

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

  const visibleServiceStates = filterServiceStates(live?.serviceStates ?? [], viewMode)
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

  const selectionCard = selectedRoute
    ? {
        title: selectedRoute.shortName,
        subtitle:
          selectedRoute.mode === 'bus'
            ? `Bus • ${selectedRoute.longName}`
            : selectedRoute.mode === 'metro'
              ? `Métro • ${selectedRoute.longName}`
              : `REM • ${selectedRoute.longName}`,
      }
    : selectedStation
      ? {
          title: selectedStation.name,
          subtitle:
            selectedStation.mode === 'metro' ? 'Station de métro' : 'Station du REM',
        }
      : null

  const handleSelectItem = (item: SearchItem | FavoriteItem) => {
    startTransition(() => {
      setSelectedItem(item)
      if (item.type === 'route') {
        setViewMode(item.mode)
      }
      setSearchQuery('')
      setSearchResults([])
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

  return (
    <div className="app-shell">
      <aside className="control-panel">
        <div className="panel-top">
          <div className="brand-lockup">
            <p className="eyebrow">Montréal Transit Atlas</p>
            <h1>Suivre bus, métro et REM sans quitter la carte.</h1>
            <p className="lede">
              Les bus STM sont affichés en temps réel quand le flux est configuré.
              Le métro et le REM sont signalés comme estimés ou en statut
              seulement.
            </p>
          </div>

          <div className="status-row">
            <span className="pill ghost">
              {isFetchingLive ? 'Mise à jour…' : 'Live actif'}
            </span>
            <span className={`pill ${live?.stale ? 'warn' : 'ok'}`}>
              {live?.stale ? 'Donnée possiblement périmée' : 'Flux à jour'}
            </span>
          </div>
        </div>

        <section className="panel-card">
          <label className="card-title" htmlFor="search-input">
            Recherche
          </label>
          <input
            id="search-input"
            className="search-input"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Bus 24, ligne 2, station Berri-UQAM, A1…"
          />
          {searchResults.length > 0 ? (
            <div className="search-results">
              {searchResults.map((item) => (
                <button
                  key={`${item.type}:${item.id}`}
                  className="search-result"
                  onClick={() => handleSelectItem(item)}
                >
                  <span>{item.label}</span>
                  <small>{item.subtitle}</small>
                </button>
              ))}
            </div>
          ) : searchQuery.trim() ? (
            <p className="small-copy">Aucun résultat pour cette recherche.</p>
          ) : null}
        </section>

        <section className="panel-card">
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
                      if (selectedItem?.type === 'route' && selectedItem.mode !== id && id !== 'combined') {
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
            <div className="segmented">
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

        <section className="panel-card spotlight">
          <div className="spotlight-top">
            <div>
              <p className="card-title">Sélection</p>
              {selectionCard ? (
                <>
                  <h2>{selectionCard.title}</h2>
                  <p className="small-copy">{selectionCard.subtitle}</p>
                </>
              ) : (
                <p className="small-copy">
                  Choisis une ligne ou une station pour isoler le flux.
                </p>
              )}
            </div>

            {selectedItem ? (
              <button
                className="favorite-button"
                onClick={() => void handleToggleFavorite()}
                disabled={isSavingFavorite}
              >
                {selectedFavorite ? 'Retirer' : 'Favori'}
              </button>
            ) : null}
          </div>

          <div className="legend-row">
            <LegendTone label="Temps réel" tone="live" />
            <LegendTone label="Estimé" tone="estimated" />
            <LegendTone label="Statut seulement" tone="status" />
          </div>
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
              <button className="secondary-action" onClick={() => void logoutIdentity()}>
                Déconnexion
              </button>
            ) : (
              <div className="auth-actions">
                <button className="secondary-action" onClick={() => openIdentity('login')}>
                  Connexion
                </button>
                <button className="primary-action" onClick={() => openIdentity('signup')}>
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
            <p className="card-title">État du service</p>
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

      <main className="map-panel">
        <div className="map-overlay">
          <p className="overlay-title">
            {favoritesFocus.length > 0 && !selectedItem
              ? 'Tes favoris'
              : viewMode === 'combined'
                ? 'Vue combinée'
                : `Vue ${modeLabel(viewMode)}`}
          </p>
          <p className="overlay-copy">
            {isBootstrapping
              ? 'Chargement du réseau de transport…'
              : 'Bus en temps réel quand disponibles, rail estimé avec badge explicite.'}
          </p>
        </div>

        <MapView
          bootstrap={bootstrap}
          live={live}
          selectedItem={selectedItem}
          viewMode={viewMode}
          mapStyle={mapStyle}
          favoritesFocus={favoritesFocus}
        />
      </main>
    </div>
  )
}

function filterServiceStates(serviceStates: ServiceState[], viewMode: ViewMode) {
  if (viewMode === 'combined') {
    const nonBus = serviceStates.filter((state) => state.mode !== 'bus')
    const busWarnings = serviceStates
      .filter((state) => state.mode === 'bus')
      .slice(0, 12)

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
  if (mode === 'bus') return 'Bus'
  if (mode === 'metro') return 'Métro'
  return 'REM'
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

function ServiceStateCard({ state }: { state: ServiceState }) {
  return (
    <div className={`service-state ${state.status}`}>
      <div className="service-state-top">
        <strong>
          {state.mode === 'bus'
            ? `Bus ${state.routeId}`
            : state.mode === 'metro'
              ? `Ligne ${state.routeId}`
              : `REM ${state.routeId}`}
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
