// tunnel.js — tunnel CRUD, heartbeat, expiry sweep

import {
  generateToken, sha256, verifyToken,
  encryptToken, decryptToken, tokenHint,
  validateSubdomain, randomSubdomain,
  jsonRes, errRes, extractBearer,
  nowISO, daysFromNow, isOlderThan
} from './utils.js'

import {
  getTunnel, saveTunnel, deleteTunnel,
  listPublicTunnels, getUser, saveUser
} from './gist.js'

import { checkRateLimit } from './ratelimit.js'
import { authenticate }   from './auth.js'

// ── POST /tunnel/create ────────────────────────────────────────────────────
export async function handleCreate(request, env) {
  const rl = await checkRateLimit(request, 'tunnel:create')
  if (rl) return rl

  let body = {}
  try { body = await request.json() } catch {}

  // Optional auth
  let authUser = null
  const bearer = extractBearer(request)
  if (bearer?.startsWith('vrtx_')) {
    const { user } = await authenticate(request, env)
    authUser = user
  }

  const isPrivate  = body.privacy === true || request.headers.get('X-Vortex-Privacy') === '1'
  const wantReserve = body.reserve === true
  if (wantReserve && !authUser) return errRes('Reservation requires an approved API key', 401)

  // Resolve subdomain
  const sub = body.subdomain
    ? body.subdomain.toLowerCase().trim()
    : randomSubdomain()

  const validErr = validateSubdomain(sub)
  if (validErr) return errRes(validErr, 400)

  // Check existing
  const existing = await getTunnel(sub, env.GITHUB_TOKEN)
  if (existing) {
    const status = getTunnelStatus(existing, env)
    if (status === 'active' || status === 'inactive') {
      if (existing.reserved) return errRes(`"${sub}" is permanently reserved`, 409, { retry_after: null })
      return errRes(`"${sub}" is currently in use`, 409)
    }
    if (status === 'grace') {
      const rawToken = extractBearer(request)
      const isOwner  = rawToken && await verifyToken(rawToken, existing.token_hash)
      if (!isOwner) return errRes(`"${sub}" is in grace period for its owner`, 409, { grace_until: existing.grace_until })
    }
    // Expired or reclaimed — delete old record
    await deleteTunnel(sub, env.GITHUB_TOKEN)
  }

  // Generate token
  const rawToken       = generateToken('', 32)
  const tokenHash      = await sha256(rawToken)
  const tokenEncrypted = await encryptToken(rawToken, env.ENCRYPTION_KEY)
  const inactivityDays = parseInt(env.INACTIVITY_DAYS || '30', 10)
  const graceDays      = parseInt(env.GRACE_DAYS      || '30', 10)
  const now            = nowISO()

  const tunnelData = {
    subdomain:        sub,
    token_hash:       tokenHash,
    token_encrypted:  tokenEncrypted,
    token_hint:       tokenHint(rawToken),
    github_username:  authUser?.github_username || null,
    reserved:         wantReserve,
    private:          isPrivate,
    port:             body.port || null,
    status:           'active',
    created_at:       now,
    last_seen:        now,
    expires_at:       null,
    grace_until:      null,
    heartbeat_count:  0,
    request_count:    0,
    meta:             body.meta || {},
  }

  await saveTunnel(tunnelData, env.GITHUB_TOKEN)

  // Link to user account
  if (authUser) await linkTunnelToUser(sub, authUser.github_username, env)

  const cfCmd = `cloudflared tunnel --url http://localhost:${body.port || '<PORT>'} --hostname ${sub}.${env.BASE_DOMAIN}`

  return jsonRes({
    ok:                       true,
    subdomain:                sub,
    url:                      `https://${sub}.${env.BASE_DOMAIN}`,
    token:                    rawToken,
    token_hint:               tokenHint(rawToken),
    reserved:                 wantReserve,
    private:                  isPrivate,
    created_at:               now,
    expires_after_inactivity: `${inactivityDays} days`,
    grace_period_if_reserved: `${graceDays} days`,
    cloudflared_cmd:          cfCmd,
    install_cmd:              `curl -fsSL https://${env.PAGES_DOMAIN}/install.sh | sh`,
  }, 201)
}

// ── DELETE /tunnel/:subdomain ──────────────────────────────────────────────
export async function handleDelete(request, env, sub) {
  const rl = await checkRateLimit(request, 'tunnel:delete')
  if (rl) return rl

  const tunnel = await getTunnel(sub, env.GITHUB_TOKEN)
  if (!tunnel) return errRes('Tunnel not found', 404)

  const rawToken = extractBearer(request)
  if (!rawToken) return errRes('Token required', 401)

  const isOwner = await verifyToken(rawToken, tunnel.token_hash)
  if (!isOwner) return errRes('Invalid token', 403)

  await deleteTunnel(sub, env.GITHUB_TOKEN)
  if (tunnel.github_username) await unlinkTunnelFromUser(sub, tunnel.github_username, env)

  return jsonRes({ ok: true, subdomain: sub, message: 'Tunnel deleted, subdomain freed' })
}

// ── GET /tunnel/:subdomain ─────────────────────────────────────────────────
export async function handleGet(request, env, sub) {
  const tunnel = await getTunnel(sub, env.GITHUB_TOKEN)
  if (!tunnel) return errRes('Tunnel not found or expired', 404)
  if (tunnel.private) return errRes('Tunnel not found or expired', 404)

  const { token_hash: _h, token_encrypted: _e, ...safe } = tunnel
  return jsonRes({ ...safe, status: getTunnelStatus(tunnel, env) })
}

// ── GET /tunnels ───────────────────────────────────────────────────────────
export async function handleList(request, env) {
  const tunnels      = await listPublicTunnels(env.GITHUB_TOKEN)
  const inactivity   = parseInt(env.INACTIVITY_DAYS || '30', 10)
  const active       = tunnels.filter(t => !isOlderThan(t.last_seen, inactivity))

  return jsonRes({
    ok:         true,
    count:      active.length,
    tunnels:    active.map(t => ({ ...t, status: getTunnelStatus(t, env) })),
    updated_at: nowISO(),
  })
}

// ── POST /tunnel/heartbeat/:subdomain ─────────────────────────────────────
export async function handleHeartbeat(request, env, sub) {
  const rl = await checkRateLimit(request, 'tunnel:heartbeat', sub)
  if (rl) return rl

  const tunnel = await getTunnel(sub, env.GITHUB_TOKEN)
  if (!tunnel) return errRes('Tunnel not found', 404)

  const rawToken = extractBearer(request)
  if (!rawToken) return errRes('Token required', 401)

  const isOwner = await verifyToken(rawToken, tunnel.token_hash)
  if (!isOwner) return errRes('Invalid token', 403)

  const now     = nowISO()
  const updated = {
    ...tunnel,
    last_seen:       now,
    status:          'active',
    heartbeat_count: (tunnel.heartbeat_count || 0) + 1,
  }
  await saveTunnel(updated, env.GITHUB_TOKEN)

  return jsonRes({ ok: true, subdomain: sub, last_seen: now })
}

// ── GET /tunnel/recover/:subdomain — recover token ────────────────────────
export async function handleRecoverTunnelToken(request, env, sub) {
  const { user, error } = await authenticate(request, env)
  if (error) return error

  const tunnel = await getTunnel(sub, env.GITHUB_TOKEN)
  if (!tunnel) return errRes('Tunnel not found', 404)

  if (tunnel.github_username !== user.github_username) {
    return errRes('You do not own this tunnel', 403)
  }

  if (!tunnel.token_encrypted) {
    return errRes('No encrypted token found for this tunnel', 404)
  }

  const rawToken = await decryptToken(tunnel.token_encrypted, env.ENCRYPTION_KEY)
  return jsonRes({ ok: true, subdomain: sub, token: rawToken, hint: tunnel.token_hint })
}

// ── Cron: sweep expired tunnels ────────────────────────────────────────────
export async function sweepExpiredTunnels(env) {
  const tunnels    = await listPublicTunnels(env.GITHUB_TOKEN)
  const inactivity = parseInt(env.INACTIVITY_DAYS || '30', 10)
  const graceDays  = parseInt(env.GRACE_DAYS      || '30', 10)
  let swept = 0

  for (const tunnel of tunnels) {
    const status = getTunnelStatus(tunnel, env)
    if (status === 'active' || status === 'inactive') continue

    if (status === 'expired') {
      await deleteTunnel(tunnel.subdomain, env.GITHUB_TOKEN)
      if (tunnel.github_username) await unlinkTunnelFromUser(tunnel.subdomain, tunnel.github_username, env)
      swept++
      continue
    }

    // active/inactive → transition to grace for reserved, delete for non-reserved
    if (isOlderThan(tunnel.last_seen, inactivity) && !tunnel.grace_until) {
      if (tunnel.reserved) {
        const updated = { ...tunnel, status: 'grace', grace_until: daysFromNow(graceDays) }
        await saveTunnel(updated, env.GITHUB_TOKEN)
      } else {
        await deleteTunnel(tunnel.subdomain, env.GITHUB_TOKEN)
        if (tunnel.github_username) await unlinkTunnelFromUser(tunnel.subdomain, tunnel.github_username, env)
        swept++
      }
    }
  }
  return swept
}

// ── Status helper ──────────────────────────────────────────────────────────
export function getTunnelStatus(tunnel, env) {
  const inactivity = parseInt(env?.INACTIVITY_DAYS || '30', 10)

  if (tunnel.status === 'grace') {
    if (tunnel.grace_until && new Date(tunnel.grace_until) < new Date()) return 'expired'
    return 'grace'
  }
  if (isOlderThan(tunnel.last_seen, inactivity)) {
    return tunnel.reserved ? 'grace' : 'expired'
  }
  if (isOlderThan(tunnel.last_seen, 7)) return 'inactive'
  return 'active'
}

// ── User tunnel linking ────────────────────────────────────────────────────
async function linkTunnelToUser(sub, username, env) {
  const user = await getUser(username, env.GITHUB_TOKEN)
  if (!user) return
  if (!user.tunnels) user.tunnels = []
  if (!user.tunnels.includes(sub)) {
    user.tunnels.push(sub)
    await saveUser(user, env.GITHUB_TOKEN)
  }
}

async function unlinkTunnelFromUser(sub, username, env) {
  const user = await getUser(username, env.GITHUB_TOKEN)
  if (!user) return
  user.tunnels = (user.tunnels || []).filter(s => s !== sub)
  await saveUser(user, env.GITHUB_TOKEN)
}
