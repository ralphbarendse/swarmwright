/**
 * Client-side auth state — permissions manifest loaded at boot from /api/v1/auth/me.
 * All views should call canDo() before rendering write actions.
 */

let _user = null;
let _permissions = {};

export function setCurrentUser(user) {
  _user = user;
  _permissions = user?.permissions || {};
}

export function currentUser() {
  return _user;
}

/** Return true if the current user has the named permission (or is admin). */
export function canDo(perm) {
  return !!_permissions[perm];
}

export async function logout() {
  await fetch('/api/v1/auth/logout', { method: 'POST' });
  window.location.href = '/login';
}
