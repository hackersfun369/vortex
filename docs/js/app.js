// app.js — shared auth state and nav sync across all Vortex pages
const API     = 'https://vortex-api.guessmesir-007.workers.dev'
const LS_KEY  = 'vortex_apikey'
const LS_USER = 'vortex_user'

// ── Auth helpers ───────────────────────────────────────────────────────────
function getApiKey()  { return localStorage.getItem(LS_KEY) || '' }
function getCachedUser() {
  try { return JSON.parse(localStorage.getItem(LS_USER) || 'null') }
  catch { return null }
}
function isSignedIn() { return !!getApiKey() }

function saveSession(apiKey, userData) {
  localStorage.setItem(LS_KEY,  apiKey)
  localStorage.setItem(LS_USER, JSON.stringify({
    github_username: userData.github_username,
    github_avatar:   userData.github_avatar,
    email:           userData.email,
    api_access:      userData.api_access,
    api_key_hint:    userData.api_key_hint,
    role:            userData.role,
    joined_at:       userData.joined_at,
  }))
}

function clearSession() {
  localStorage.removeItem(LS_KEY)
  localStorage.removeItem(LS_USER)
  localStorage.setItem('vortex_reauth', '1')
}

// ── Nav sync ───────────────────────────────────────────────────────────────
async function initNav() {
  const key  = getApiKey()
  const user = getCachedUser()

  const navUser    = document.getElementById('nav-user')
  const navAvatar  = document.getElementById('nav-avatar')
  const navSignIn  = document.getElementById('nav-signin')
  const navSignOut = document.getElementById('nav-signout')
  const navDash    = document.getElementById('nav-dashboard')

  function setSignedIn(u) {
    if (navUser)    { navUser.textContent = u.github_username; navUser.classList.remove('hidden') }
    if (navAvatar && u.github_avatar) { navAvatar.src = u.github_avatar; navAvatar.classList.remove('hidden') }
    if (navSignIn)  navSignIn.classList.add('hidden')
    if (navSignOut) navSignOut.classList.remove('hidden')
    if (navDash)    navDash.classList.remove('hidden')
  }

  function setSignedOut() {
    if (navUser)    navUser.classList.add('hidden')
    if (navAvatar)  navAvatar.classList.add('hidden')
    if (navSignIn)  navSignIn.classList.remove('hidden')
    if (navSignOut) navSignOut.classList.add('hidden')
    if (navDash)    navDash.classList.add('hidden')
  }

  if (!key) { setSignedOut(); return }

  if (user) {
    setSignedIn(user)
  } else {
    try {
      const res = await fetch(`${API}/my/tunnels`, { headers: { Authorization: `Bearer ${key}` } })
      if (res.ok) {
        const data = await res.json()
        saveSession(key, data)
        setSignedIn(data)
      } else {
        clearSession()
        setSignedOut()
      }
    } catch { setSignedOut() }
  }
}

// ── Sign out ───────────────────────────────────────────────────────────────
async function signOut() {
  clearSession()
  const returnUrl = encodeURIComponent(window.location.origin + '/vortex/dashboard.html')
  window.location.href = `${API}/auth/logout?redirect=${returnUrl}`
}

// ── Handle OAuth return (apikey in URL hash) ───────────────────────────────
async function handleOAuthReturn() {
  const hash = window.location.hash
  if (!hash.startsWith('#apikey=')) return false
  const key = decodeURIComponent(hash.slice(8))
  history.replaceState(null, '', window.location.pathname)
  if (!key || !key.startsWith('vrtx_')) return false
  try {
    const res = await fetch(`${API}/my/tunnels`, { headers: { Authorization: `Bearer ${key}` } })
    if (res.ok) {
      const data = await res.json()
      saveSession(key, data)
      return true
    }
  } catch {}
  return false
}

// ── Sign-in URL (with reauth after logout) ────────────────────────────────
function getSignInUrl() {
  const reauth = localStorage.getItem('vortex_reauth') === '1'
  localStorage.removeItem('vortex_reauth')
  return `${API}/auth/github${reauth ? '?reauth=1' : ''}`
}

// ── API helper ─────────────────────────────────────────────────────────────
async function apiCall(method, path, body) {
  const key = getApiKey()
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  }
  if (key) opts.headers['Authorization'] = `Bearer ${key}`
  if (body) opts.body = JSON.stringify(body)
  const res  = await fetch(`${API}${path}`, opts)
  const data = await res.json()
  return { ok: res.ok, status: res.status, data }
}

// ── Shared nav HTML ────────────────────────────────────────────────────────
function buildNav(activePage) {
  const pages = [
    { id: 'portal',    href: '/vortex/portal.html',    label: 'portal' },
    { id: 'docs',      href: '/vortex/docs.html',      label: 'docs' },
    { id: 'live',      href: '/vortex/live.html',      label: 'live' },
  ]
  const links = pages.map(p =>
    `<a href="${p.href}"${p.id === activePage ? ' class="active"' : ''}>${p.label}</a>`
  ).join('\n    ')

  return `
<nav class="nav">
  <a href="/vortex/" class="nav-logo">⬡ vortex</a>
  <div class="nav-links">
    ${links}
    <img id="nav-avatar" src="" alt="" class="hidden" style="width:28px;height:28px;border-radius:50%;border:1px solid var(--border2)">
    <span id="nav-user" class="nav-user hidden"></span>
    <a href="/vortex/dashboard.html" id="nav-dashboard" class="btn-nav hidden">dashboard</a>
    <a id="nav-signin" href="${API}/auth/github" class="btn-nav">sign in</a>
    <button id="nav-signout" onclick="signOut()" class="btn-nav-ghost hidden">sign out</button>
  </div>
</nav>`
}