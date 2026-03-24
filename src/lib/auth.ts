import netlifyIdentity, {
  type IdentityUser,
} from 'netlify-identity-widget'
import type { IdentitySession } from '../shared/types.ts'

let initialized = false

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
