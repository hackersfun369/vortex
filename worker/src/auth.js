// auth.js — GitHub OAuth + API key issuance + session management

import {
  generateToken, sha256, verifyToken,
  jsonRes, errRes, extractBearer, nowISO
} from './utils.js'
import { getRegistry, setRegistry, USERS_DESC, PENDING_DESC, APPROVED_DESC } from './gist.js'

// ── GitHub OAuth ───────────────────────────────────────────────────────────

export async function handleAuthGitHub(request, env) {
  const state    = generateToken('', 16)
  const params   = new URLSearchParams({
    client_id:    env.GITHUB_OAUTH_CLIENT_ID,
    redirect_uri: `https://${env.BASE_DOMAIN}/auth/callback`,
    scope:        'read:user',
    state,
  })
  const url = `https://github.com/login/oauth/authorize?${params}`

  return new Response(null, {
    status: 302,
    headers: {
      'Location':  url,
      'Set-Cookie': `vortex_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  })
}

export async function handleAuthCallback(request, env) {
  const url    = new URL(request.url)
  const code   = url.searchParams.get('code')
  const state  = url.searchParams.get('state')

  // Verify state
  const cookies     = parseCookies(request)
  const savedState  = cookies['vortex_oauth_state']
  if (!code || !state || state !== savedState) {
    return errRes('Invalid OAuth state or missing code', 400)
  }

  // Exchange code for GitHub access token
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Accept':       'application/json',
      'Content-Type': 'application/json',
      'User-Agent':   'vortex-tunnel-service',
    },
    body: JSON.stringify({
      client_id:     env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: `https://${env.BASE_DOMAIN}/auth/callback`,
    }),
  })

  const tokenData = await tokenRes.json()
  if (!tokenData.access_token) {
    return errRes('GitHub OAuth failed', 502)
  }

  // Fetch GitHub user profile
  const profileRes = await fetch('https://api.github.com/user', {
    headers: {
      'Authorization': `token ${tokenData.access_token}`,
      'User-Agent':    'vortex-tunnel-service',
    },
  })
  const profile = await profileRes.json()
  const githubUsername = profile.login
  const githubId       = String(profile.id)

  // Load or create user record
  const { data: users, gist_id: usersGistId } = await getRegistry(USERS_DESC, env.GITHUB_TOKEN)

  let apiKey     = null
  let apiKeyHash = null

  if (!users[githubUsername]) {
    // New user — issue API key (not yet approved for API access)
    apiKey     = generateToken('vrtx', 32)
    apiKeyHash = await sha256(apiKey)

    users[githubUsername] = {
      github_username: githubUsername,
      github_id:       githubId,
      api_key_hash:    apiKeyHash,
      api_access:      false,
      joined_at:       nowISO(),
      tunnels:         [],
    }

    await setRegistry(USERS_DESC, users, usersGistId, env.GITHUB_TOKEN)
  }

  // Create signed session JWT (simple, no library needed)
  const session = await createSession(githubUsername, githubId, env.SESSION_SECRET)

  const redirectUrl = `https://hackersfun369.github.io/vortex/dashboard.html`
  const headers = {
    'Location': redirectUrl,
    'Set-Cookie': [
      `vortex_session=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
      `vortex_oauth_state=; Path=/; HttpOnly; Secure; Max-Age=0`,
    ].join(', '),
  }

  // If new user, show API key once via redirect with fragment
  const dest = apiKey
    ? `${redirectUrl}#apikey=${apiKey}`
    : redirectUrl

  return new Response(null, { status: 302, headers: { ...headers, 'Location': dest } })
}

export async function handleLogout(request, env) {
  return new Response(null, {
    status: 302,
    headers: {
      'Location': `https://${env.BASE_DOMAIN}/`,
      'Set-Cookie': 'vortex_session=; Path=/; HttpOnly; Secure; Max-Age=0',
    },
  })
}

// ── Auth middleware ────────────────────────────────────────────────────────

// Verify session cookie → returns github_username or null
export async function verifySession(request, env) {
  const cookies = parseCookies(request)
  const session = cookies['vortex_session']
  if (!session) return null
  return verifySession_(session, env.SESSION_SECRET)
}

// Verify API key → returns user record or null
export async function verifyApiKey(request, env) {
  const raw = extractBearer(request)
  if (!raw || !raw.startsWith('vrtx_')) return null

  const hash  = await sha256(raw)
  const { data: users } = await getRegistry(USERS_DESC, env.GITHUB_TOKEN)

  for (const [username, user] of Object.entries(users)) {
    if (user.api_key_hash === hash) {
      return { ...user, github_username: username }
    }
  }
  return null
}

// Returns user if session or API key is valid
export async function authenticate(request, env, requireApiAccess = false) {
  // Try API key first
  const apiUser = await verifyApiKey(request, env)
  if (apiUser) {
    if (requireApiAccess && !apiUser.api_access) {
      return { user: null, error: errRes('API access not approved. Apply via dashboard.', 403) }
    }
    return { user: apiUser, error: null }
  }

  // Try session
  const username = await verifySession(request, env)
  if (!username) return { user: null, error: errRes('Authentication required', 401) }

  const { data: users } = await getRegistry(USERS_DESC, env.GITHUB_TOKEN)
  const user = users[username]
  if (!user) return { user: null, error: errRes('User not found', 401) }

  if (requireApiAccess && !user.api_access) {
    return { user: null, error: errRes('API access not approved. Apply via dashboard.', 403) }
  }

  return { user: { ...user, github_username: username }, error: null }
}

// ── My tunnels ─────────────────────────────────────────────────────────────

export async function handleMyTunnels(request, env) {
  const { user, error } = await authenticate(request, env)
  if (error) return error

  const { data: users } = await getRegistry(USERS_DESC, env.GITHUB_TOKEN)
  const record = users[user.github_username]

  return jsonRes({
    ok: true,
    github_username: user.github_username,
    api_access: user.api_access,
    tunnels: record?.tunnels || [],
    joined_at: user.joined_at,
  })
}

// ── Apply for API access ───────────────────────────────────────────────────

export async function handleApplyApiAccess(request, env) {
  const { user, error } = await authenticate(request, env)
  if (error) return error

  let body = {}
  try { body = await request.json() } catch {}

  const { data: pending, gist_id: pendingGistId } = await getRegistry(PENDING_DESC, env.GITHUB_TOKEN)

  if (pending[user.github_username]) {
    return jsonRes({ ok: false, message: 'Application already submitted, pending review' })
  }

  pending[user.github_username] = {
    github_username: user.github_username,
    reason:          body.reason || 'No reason provided',
    applied_at:      nowISO(),
  }

  await setRegistry(PENDING_DESC, pending, pendingGistId, env.GITHUB_TOKEN)

  return jsonRes({ ok: true, message: 'Application submitted. Owner will review and approve.' })
}

// ── Admin — list applications ──────────────────────────────────────────────

export async function handleAdminApplications(request, env) {
  if (!verifyOwnerToken(request, env)) return errRes('Unauthorized', 401)

  const { data: pending } = await getRegistry(PENDING_DESC, env.GITHUB_TOKEN)
  const apps = Object.values(pending)

  return jsonRes({ ok: true, count: apps.length, applications: apps })
}

// ── Admin — approve ────────────────────────────────────────────────────────

export async function handleAdminApprove(request, env, githubUsername) {
  if (!verifyOwnerToken(request, env)) return errRes('Unauthorized', 401)

  const { data: users,   gist_id: usersGistId   } = await getRegistry(USERS_DESC,   env.GITHUB_TOKEN)
  const { data: pending, gist_id: pendingGistId  } = await getRegistry(PENDING_DESC, env.GITHUB_TOKEN)

  if (!users[githubUsername]) return errRes('User not found', 404)

  users[githubUsername].api_access = true
  delete pending[githubUsername]

  await setRegistry(USERS_DESC,   users,   usersGistId,  env.GITHUB_TOKEN)
  await setRegistry(PENDING_DESC, pending, pendingGistId, env.GITHUB_TOKEN)

  return jsonRes({ ok: true, message: `API access granted to ${githubUsername}` })
}

// ── Admin — list all users ─────────────────────────────────────────────────

export async function handleAdminUsers(request, env) {
  if (!verifyOwnerToken(request, env)) return errRes('Unauthorized', 401)

  const { data: users }   = await getRegistry(USERS_DESC,   env.GITHUB_TOKEN)
  const { data: pending } = await getRegistry(PENDING_DESC, env.GITHUB_TOKEN)

  const list = Object.entries(users).map(([username, user]) => ({
    github_username: username,
    github_id:       user.github_id,
    api_access:      user.api_access || false,
    api_pending:     !!pending[username],
    tunnel_count:    (user.tunnels || []).length,
    tunnels:         user.tunnels || [],
    joined_at:       user.joined_at,
  }))

  return jsonRes({
    ok:    true,
    count: list.length,
    users: list,
  })
}

// ── Admin — revoke ─────────────────────────────────────────────────────────

export async function handleAdminRevoke(request, env, githubUsername) {
  if (!verifyOwnerToken(request, env)) return errRes('Unauthorized', 401)

  const { data: users, gist_id: usersGistId } = await getRegistry(USERS_DESC, env.GITHUB_TOKEN)
  if (!users[githubUsername]) return errRes('User not found', 404)

  users[githubUsername].api_access = false
  await setRegistry(USERS_DESC, users, usersGistId, env.GITHUB_TOKEN)

  return jsonRes({ ok: true, message: `API access revoked from ${githubUsername}` })
}

// ── Session helpers ────────────────────────────────────────────────────────

async function createSession(username, githubId, secret) {
  const payload = btoa(JSON.stringify({ username, githubId, iat: Date.now() }))
  const sig     = await hmacSign(payload, secret)
  return `${payload}.${sig}`
}

async function verifySession_(token, secret) {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payload, sig] = parts
  const expected = await hmacSign(payload, secret)
  if (sig !== expected) return null
  try {
    const data = JSON.parse(atob(payload))
    // Session valid for 30 days
    if (Date.now() - data.iat > 30 * 86400000) return null
    return data.username
  } catch { return null }
}

async function hmacSign(data, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
}

function parseCookies(request) {
  const header  = request.headers.get('Cookie') || ''
  const cookies = {}
  header.split(';').forEach(part => {
    const [k, ...v] = part.trim().split('=')
    if (k) cookies[k.trim()] = v.join('=').trim()
  })
  return cookies
}

function verifyOwnerToken(request, env) {
  const token = extractBearer(request)
  return token && token === env.OWNER_TOKEN
}

// ── Admin — debug (list all gists) ────────────────────────────────────────
export async function handleAdminDebug(request, env) {
  if (!verifyOwnerToken(request, env)) return errRes('Unauthorized', 401)
  const { debugListGists } = await import('./gist.js')
  const gists = await debugListGists(env.GITHUB_TOKEN)
  return jsonRes({ ok: true, gists })
}
