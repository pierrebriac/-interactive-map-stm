declare module 'netlify-identity-widget' {
  export interface IdentityUser {
    id: string
    email?: string | null
    user_metadata?: Record<string, unknown>
    token?: {
      access_token?: string
    }
  }

  export interface IdentityWidget {
    init(options?: { container?: string; locale?: string; logo?: boolean }): void
    currentUser(): IdentityUser | null
    open(tab?: 'login' | 'signup'): void
    close(): void
    logout(): Promise<void>
    refresh(): Promise<string>
    on(
      event:
        | 'init'
        | 'login'
        | 'logout'
        | 'open'
        | 'close'
        | 'error',
      callback: (payload?: unknown) => void,
    ): void
    off(
      event:
        | 'init'
        | 'login'
        | 'logout'
        | 'open'
        | 'close'
        | 'error',
      callback?: (payload?: unknown) => void,
    ): void
    setLocale(locale: string): void
  }

  const identity: IdentityWidget
  export default identity
}
