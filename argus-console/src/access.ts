/**
 * Keep Console visibility aligned with the server-side platform-admin guard.
 * `admin` remains supported as the legacy alias for `platform_admin`.
 */
export function isPlatformAdminRole(role: string | null | undefined): boolean {
  return role === 'platform_admin' || role === 'admin';
}
