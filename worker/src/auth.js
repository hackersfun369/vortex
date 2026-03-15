// auth.js — GitHub OAuth, API keys, session management, admin

import {
  generateToken, sha256, verifyToken,
  encryptToken, decryptToken, tokenHint,
  jsonRes, errRes, extractBearer, nowISO
} from './utils.js'

import {
  getUser, saveUser, listUsers,
  getPending, savePending, deletePending, listPending,
  debugListAllGists
} from './gist.js'

// ── GitHub OAuth ───────────────────────────────────────────────────────────
export async function handleAuthGitHub(request, env) {
  const state  = generateToken('', 16)
  const params = new URLSearchParams({
    client_id:    env.GITHUB_OAUTH_CLIENT_ID,
    redirect_uri: `https://${env.BASE_DOMAIN}/auth/callback`,
    scope:        'read:user user:email',
    state,
  })
  return new Response(null, {
    status: 302,
    headers: {
      'Location':   `https://github.com/login/oauth/authorize?${params}`,
      'Set-Cookie': `vortex_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  })
}

export async function handleAuthCallback(request, env) {
  const url   = new URL(request.url)
  const code  = url.searchParams.get('code')
  const state = url.searchParams.get('state')

  const cookies    = parseCookies(request)
  const savedState = cookies['vortex_state']
  if (!code || !state || state !== savedState) {
    return errRes('Invalid OAuth state', 400)
  }

  // Exchange code for GitHub token
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'vortex' },
    body: JSON.stringify({
      client_id:     env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: `https://${env.BASE_DOMAIN}/auth/callback`,
    }),
  })
  const tokenData = await tokenRes.json()
  if (!tokenData.access_token) return errRes('GitHub OAuth failed', 502)

  // Fetch GitHub profile
  const profileRes = await fetch('https://api.github.com/user', {
    headers: { 'Authorization': `token ${tokenData.access_token}`, 'User-Agent': 'vortex' },
  })
  const profile = await profileRes.json()

  // Fetch email if not public
  let email = profile.email || ''
  if (!email) {
    const emailRes = await fetch('https://api.github.com/user/emails', {
      headers: { 'Authorization': `token ${tokenData.access_token}`, 'User-Agent': 'vortex' },
    })
    const emails = await emailRes.json()
    const primary = emails.find(e => e.primary && e.verified)
    email = primary?.email || ''
  }

  const username = profile.login
  const now      = nowISO()

  // Load or create user
  let user        = await getUser(username, env.GITHUB_TOKEN)
  let rawApiKey   = null
  let isNewUser   = false

  if (!user) {
    isNewUser  = true
    rawApiKey  = generateToken('vrtx', 32)
    const hash = await sha256(rawApiKey)
    const enc  = await encryptToken(rawApiKey, env.ENCRYPTION_KEY)

    user = {
      github_username:   username,
      github_id:         String(profile.id),
      github_avatar:     profile.avatar_url || '',
      email,
      api_key_hash:      hash,
      api_key_encrypted: enc,
      api_key_hint:      tokenHint(rawApiKey),
      api_access:        false,
      role:              'user',
      joined_at:         now,
      last_login:        now,
      tunnels:           [],
      tunnel_limit:      10,
      suspended:         false,
      suspension_reason: null,
    }
    await saveUser(user, env.GITHUB_TOKEN)
  } else {
    // Update last login and email
    user.last_login = now
    if (email && !user.email) user.email = email
    if (profile.avatar_url)   user.github_avatar = profile.avatar_url
    await saveUser(user, env.GITHUB_TOKEN)
  }

  // Create session
  const session = await createSession(username, String(profile.id), env.SESSION_SECRET)

  const dashUrl = `https://${env.PAGES_DOMAIN}/dashboard.html`
  const dest    = isNewUser ? `${dashUrl}#apikey=${rawApiKey}` : dashUrl

  return new Response(null, {
    status: 302,
    headers: {
      'Location':   dest,
      'Set-Cookie': [
        `vortex_session=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
        `vortex_state=; Path=/; HttpOnly; Secure; Max-Age=0`,
      ].join(', '),
    },
  })
}

export async function handleLogout(request, env) {
  return new Response(null, {
    status: 302,
    headers: {
      'Location':   `https://${env.PAGES_DOMAIN}/`,
      'Set-Cookie': 'vortex_session=; Path=/; HttpOnly; Secure; Max-Age=0',
    },
  })
}

// ── Auth middleware ────────────────────────────────────────────────────────
export async function verifySession(request, env) {
  const cookies = parseCookies(request)
  const session = cookies['vortex_session']
  if (!session) return null
  return verifySessionToken(session, env.SESSION_SECRET)
}

export async function verifyApiKey(request, env) {
  const raw = extractBearer(request)
  if (!raw || !raw.startsWith('vrtx_')) return null

  const hash  = await sha256(raw)
  const users = await listUsers(env.GITHUB_TOKEN)
  const user  = users.find(u => {
    const fullUser = getUser(u.github_username, env.GITHUB_TOKEN)
    return u.api_key_hash === hash
  })

  if (!user) return null

  // Get full user with encrypted fields
  const full = await getUser(user.github_username, env.GITHUB_TOKEN)
  return full
}

export async function authenticate(request, env, requireApiAccess = false) {
  // Try API key
  const raw = extractBearer(request)
  if (raw?.startsWith('vrtx_')) {
    const hash  = await sha256(raw)
    const users = await listUsers(env.GITHUB_TOKEN)
    for (const u of users) {
      const full = await getUser(u.github_username, env.GITHUB_TOKEN)
      if (!full) continue
      if (full.api_key_hash !== hash) continue
      if (full.suspended) return { user: null, error: errRes('Account suspended', 403) }
      if (requireApiAccess && !full.api_access) {
        return { user: null, error: errRes('API access not approved. Apply via dashboard.', 403) }
      }
      return { user: full, error: null }
    }
    return { user: null, error: errRes('Invalid API key', 401) }
  }

  // Try session
  const username = await verifySession(request, env)
  if (!username) return { user: null, error: errRes('Authentication required', 401) }

  const user = await getUser(username, env.GITHUB_TOKEN)
  if (!user) return { user: null, error: errRes('User not found', 401) }
  if (user.suspended) return { user: null, error: errRes('Account suspended', 403) }

  if (requireApiAccess && !user.api_access) {
    return { user: null, error: errRes('API access not approved. Apply via dashboard.', 403) }
  }

  return { user, error: null }
}

// ── My tunnels + profile ───────────────────────────────────────────────────
export async function handleMyTunnels(request, env) {
  const { user, error } = await authenticate(request, env)
  if (error) return error

  return jsonRes({
    ok:             true,
    github_username: user.github_username,
    github_avatar:   user.github_avatar,
    email:           user.email,
    api_access:      user.api_access,
    api_key_hint:    user.api_key_hint,
    role:            user.role,
    joined_at:       user.joined_at,
    last_login:      user.last_login,
    tunnels:         user.tunnels || [],
    tunnel_limit:    user.tunnel_limit || 10,
    suspended:       user.suspended || false,
  })
}

// ── Recover API key ────────────────────────────────────────────────────────
export async function handleRecoverApiKey(request, env) {
  const { user, error } = await authenticate(request, env)
  if (error) return error

  if (!user.api_key_encrypted) {
    return errRes('No encrypted API key found. Please contact support.', 404)
  }

  const rawKey = await decryptToken(user.api_key_encrypted, env.ENCRYPTION_KEY)
  return jsonRes({ ok: true, api_key: rawKey, hint: user.api_key_hint })
}

// ── Apply for API access ───────────────────────────────────────────────────
export async function handleApplyApiAccess(request, env) {
  const { user, error } = await authenticate(request, env)
  if (error) return error

  const existing = await getPending(user.github_username, env.GITHUB_TOKEN)
  if (existing && !existing.reviewed) {
    return jsonRes({ ok: false, message: 'Application already pending review' })
  }

  let body = {}
  try { body = await request.json() } catch {}

  const pending = {
    github_username: user.github_username,
    github_avatar:   user.github_avatar,
    email:           user.email,
    reason:          body.reason || 'No reason provided',
    applied_at:      nowISO(),
    reviewed:        false,
    reviewed_at:     null,
    reviewed_by:     null,
    decision:        null,
  }

  await savePending(pending, env.GITHUB_TOKEN)
  return jsonRes({ ok: true, message: 'Application submitted. Owner will review.' })
}

// ── Admin — list users ─────────────────────────────────────────────────────
export async function handleAdminUsers(request, env) {
  if (!verifyOwnerToken(request, env)) return errRes('Unauthorized', 401)

  const users   = await listUsers(env.GITHUB_TOKEN)
  const pending = await listPending(env.GITHUB_TOKEN)
  const pendingSet = new Set(pending.map(p => p.github_username))

  const list = users.map(u => ({
    github_username:  u.github_username,
    github_id:        u.github_id,
    github_avatar:    u.github_avatar,
    email:            u.email,
    api_key_hint:     u.api_key_hint,
    api_access:       u.api_access || false,
    api_pending:      pendingSet.has(u.github_username),
    role:             u.role || 'user',
    joined_at:        u.joined_at,
    last_login:       u.last_login,
    tunnel_count:     (u.tunnels || []).length,
    tunnels:          u.tunnels || [],
    suspended:        u.suspended || false,
    suspension_reason: u.suspension_reason || null,
  }))

  return jsonRes({ ok: true, count: list.length, users: list })
}

// ── Admin — list pending applications ─────────────────────────────────────
export async function handleAdminApplications(request, env) {
  if (!verifyOwnerToken(request, env)) return errRes('Unauthorized', 401)
  const apps = await listPending(env.GITHUB_TOKEN)
  return jsonRes({ ok: true, count: apps.length, applications: apps })
}

// ── Admin — approve ────────────────────────────────────────────────────────
export async function handleAdminApprove(request, env, username) {
  if (!verifyOwnerToken(request, env)) return errRes('Unauthorized', 401)

  const user = await getUser(username, env.GITHUB_TOKEN)
  if (!user) return errRes('User not found', 404)

  user.api_access = true
  await saveUser(user, env.GITHUB_TOKEN)

  // Mark pending as reviewed
  const pending = await getPending(username, env.GITHUB_TOKEN)
  if (pending) {
    pending.reviewed    = true
    pending.reviewed_at = nowISO()
    pending.reviewed_by = 'owner'
    pending.decision    = 'approved'
    await savePending(pending, env.GITHUB_TOKEN)
  }

  return jsonRes({ ok: true, message: `API access granted to ${username}` })
}

// ── Admin — revoke ─────────────────────────────────────────────────────────
export async function handleAdminRevoke(request, env, username) {
  if (!verifyOwnerToken(request, env)) return errRes('Unauthorized', 401)

  const user = await getUser(username, env.GITHUB_TOKEN)
  if (!user) return errRes('User not found', 404)

  user.api_access = false
  await saveUser(user, env.GITHUB_TOKEN)

  return jsonRes({ ok: true, message: `API access revoked from ${username}` })
}

// ── Admin — suspend user ───────────────────────────────────────────────────
export async function handleAdminSuspend(request, env, username) {
  if (!verifyOwnerToken(request, env)) return errRes('Unauthorized', 401)

  const user = await getUser(username, env.GITHUB_TOKEN)
  if (!user) return errRes('User not found', 404)

  let body = {}
  try { body = await request.json() } catch {}

  user.suspended         = true
  user.suspension_reason = body.reason || 'Suspended by owner'
  await saveUser(user, env.GITHUB_TOKEN)

  return jsonRes({ ok: true, message: `${username} suspended` })
}

// ── Admin — unsuspend user ─────────────────────────────────────────────────
export async function handleAdminUnsuspend(request, env, username) {
  if (!verifyOwnerToken(request, env)) return errRes('Unauthorized', 401)

  const user = await getUser(username, env.GITHUB_TOKEN)
  if (!user) return errRes('User not found', 404)

  user.suspended         = false
  user.suspension_reason = null
  await saveUser(user, env.GITHUB_TOKEN)

  return jsonRes({ ok: true, message: `${username} unsuspended` })
}

// ── Admin — debug ──────────────────────────────────────────────────────────
export async function handleAdminDebug(request, env) {
  if (!verifyOwnerToken(request, env)) return errRes('Unauthorized', 401)
  const gists = await debugListAllGists(env.GITHUB_TOKEN)
  return jsonRes({ ok: true, gists })
}

// ── Session helpers ────────────────────────────────────────────────────────
async function createSession(username, githubId, secret) {
  const payload = btoa(JSON.stringify({ username, githubId, iat: Date.now() }))
  const sig     = await hmacSign(payload, secret)
  return `${payload}.${sig}`
}

async function verifySessionToken(token, secret) {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payload, sig] = parts
  const expected = await hmacSign(payload, secret)
  if (sig !== expected) return null
  try {
    const data = JSON.parse(atob(payload))
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
  const cookies = {}
  const header  = request.headers.get('Cookie') || ''
  header.split(';').forEach(part => {
    const [k, ...v] = part.trim().split('=')
    if (k) cookies[k.trim()] = v.join('=').trim()
  })
  return cookies
}

function verifyOwnerToken(request, env) {
  return extractBearer(request) === env.OWNER_TOKEN
}
