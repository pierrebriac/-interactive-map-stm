import netlifyIdentity, {
  type IdentityUser,
} from 'netlify-identity-widget'
import type { IdentitySession } from '../shared/types.ts'

let initialized = false
const IDENTITY_TOKEN_TYPES = [
  'confirmation',
  'invite',
  'recovery',
  'email_change',
] as const

function toSession(user: IdentityUser | null, token: string | null) {
  if (!user) {
    return null
  }

  return {
    id: user.id,
    email: user.email ?? null,
    token,
  } satisfies IdentitySession
}

export function initIdentity() {
  if (typeof window === 'undefined' || initialized) {
    return
  }

  normalizeIdentityTokenLocation()

  netlifyIdentity.init({
    locale: 'fr',
    logo: false,
  })
  initialized = true
}

export async function getIdentitySession() {
  initIdentity()

  const user = netlifyIdentity.currentUser()
  if (!user) {
    return null
  }

  let token = user.token?.access_token ?? null

  try {
    token = await netlifyIdentity.refresh()
  } catch {
    token = token ?? null
  }

  return toSession(user, token)
}

export function subscribeToIdentity(onChange: () => void) {
  initIdentity()

  const handler = () => {
    void onChange()
  }

  const errorHandler = () => {
    void onChange()
  }

  netlifyIdentity.on('init', handler)
  netlifyIdentity.on('login', handler)
  netlifyIdentity.on('logout', handler)
  netlifyIdentity.on('error', errorHandler)

  return () => {
    netlifyIdentity.off('init', handler)
    netlifyIdentity.off('login', handler)
    netlifyIdentity.off('logout', handler)
    netlifyIdentity.off('error', errorHandler)
  }
}

export function openIdentity(tab: 'login' | 'signup') {
  initIdentity()
  netlifyIdentity.open(tab)
}

export async function logoutIdentity() {
  initIdentity()
  await netlifyIdentity.logout()
}

function normalizeIdentityTokenLocation() {
  const url = new URL(window.location.href)
  const normalizedHash = url.hash.replace(/^#\/?/, '')

  if (hasIdentityToken(normalizedHash)) {
    return
  }

  for (const tokenType of IDENTITY_TOKEN_TYPES) {
    const key = `${tokenType}_token`
    const token = url.searchParams.get(key)
    if (!token) {
      continue
    }

    url.searchParams.delete(key)
    const nextHash = `${key}=${encodeURIComponent(token)}`
    const nextUrl =
      `${url.pathname}${url.searchParams.toString() ? `?${url.searchParams.toString()}` : ''}#${nextHash}`

    window.history.replaceState({}, '', nextUrl)
    return
  }
}

function hasIdentityToken(value: string) {
  return IDENTITY_TOKEN_TYPES.some((tokenType) =>
    value.includes(`${tokenType}_token=`),
  )
}
