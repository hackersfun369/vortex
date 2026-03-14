// tunnel.js — tunnel CRUD handlers

import {
  generateToken, sha256, verifyToken,
  validateSubdomain, randomSubdomain,
  jsonRes, errRes, extractBearer,
  nowISO, isOlderThan, daysFromNow
} from './utils.js'
import {
  getTunnel, createTunnel, updateTunnel,
  deleteTunnel, listPublicTunnels
} from './gist.js'
import { getRegistry, setRegistry, USERS_DESC } from './gist.js'
import { checkRateLimit } from './ratelimit.js'
import { authenticate } from './auth.js'

// ── POST /tunnel/create ────────────────────────────────────────────────────
export async function handleCreate(request, env) {
  // Rate limit by IP
  const rl = await checkRateLimit(request, 'tunnel:create')
  if (rl) return rl

  let body = {}
  try { body = await request.json() } catch {}

  // Determine if user is authenticated (optional for create)
  let authUser = null
  const bearer = extractBearer(request)
  if (bearer?.startsWith('vrtx_')) {
    const { user } = await authenticate(request, env, true)
    authUser = user
  }

  // Privacy flag
  const isPrivate = body.privacy === true ||
    request.headers.get('X-Vortex-Privacy') === '1'

  // Reservation requires API access
  const wantReserve = body.reserve === true
  if (wantReserve && !authUser) {
    return errRes('Subdomain reservation requires an approved API key', 401)
  }

  // Resolve subdomain
  let sub = body.subdomain
    ? body.subdomain.toLowerCase().trim()
    : randomSubdomain()

  const validErr = validateSubdomain(sub)
  if (validErr) return errRes(validErr, 400)

  // Check if subdomain is taken
  const existing = await getTunnel(sub, env.GITHUB_TOKEN)
  if (existing) {
    const status = getTunnelStatus(existing, env)

    if (status === 'active' || status === 'inactive') {
      if (existing.reserved) {
        return errRes(`Subdomain "${sub}" is permanently reserved`, 409, { retry_after: null })
      }
      return errRes(`Subdomain "${sub}" is currently in use`, 409, {
        expires_hint: `Will be freed after ${env.INACTIVITY_DAYS || 30} days of inactivity`,
      })
    }

    if (status === 'grace') {
      // In grace period — only token holder can reclaim
      const rawToken = extractBearer(request)
      const isOwner  = rawToken && await verifyToken(rawToken, existing.token_hash)
      if (!isOwner) {
        return errRes(`Subdomain "${sub}" is in grace period for its owner`, 409, {
          grace_until: existing.grace_until,
        })
      }
      // Owner reclaiming — fall through to re-create
      if (existing.gist_id) await deleteTunnel(existing.gist_id, env.GITHUB_TOKEN)
    }

    // Expired and not in grace — free to claim, delete old record
    if (status === 'expired' && existing.gist_id) {
      await deleteTunnel(existing.gist_id, env.GITHUB_TOKEN)
    }
  }

  // Generate token
  const rawToken  = generateToken('', 32)
  const tokenHash = await sha256(rawToken)
  const inactivityDays = parseInt(env.INACTIVITY_DAYS || '30', 10)

  const tunnelData = {
    subdomain:    sub,
    token_hash:   tokenHash,
    github_username: authUser?.github_username || null,
    reserved:     wantReserve,
    private:      isPrivate,
    port:         body.port || null,
    created_at:   nowISO(),
    last_seen:    nowISO(),
    grace_until:  null,
    status:       'active',
  }

  const tunnel = await createTunnel(tunnelData, !isPrivate, env.GITHUB_TOKEN)

  // Link tunnel to user account if authenticated
  if (authUser) {
    await linkTunnelToUser(sub, authUser.github_username, env)
  }

  const cfCmd = `cloudflared tunnel --url http://localhost:${body.port || '<PORT>'} --hostname ${sub}.${env.BASE_DOMAIN}`

  return jsonRes({
    ok:           true,
    subdomain:    sub,
    url:          `https://${sub}.${env.BASE_DOMAIN}`,
    token:        rawToken,
    reserved:     wantReserve,
    private:      isPrivate,
    created_at:   tunnelData.created_at,
    expires_after_inactivity: `${inactivityDays} days`,
    grace_period_if_reserved: `${env.GRACE_DAYS || 30} days`,
    cloudflared_cmd: cfCmd,
    install_cmd:  `curl -fsSL https://${env.BASE_DOMAIN}/install.sh | sh`,
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

  await deleteTunnel(tunnel.gist_id, env.GITHUB_TOKEN)

  // Unlink from user account
  if (tunnel.github_username) {
    await unlinkTunnelFromUser(sub, tunnel.github_username, env)
  }

  return jsonRes({ ok: true, subdomain: sub, message: 'Tunnel deleted, subdomain freed' })
}

// ── GET /tunnel/:subdomain ─────────────────────────────────────────────────
export async function handleGet(request, env, sub) {
  const tunnel = await getTunnel(sub, env.GITHUB_TOKEN)
  if (!tunnel) return errRes('Tunnel not found or expired', 404)
  if (tunnel.private) return errRes('Tunnel not found or expired', 404)

  const status = getTunnelStatus(tunnel, env)
  const { token_hash: _t, ...safe } = tunnel

  return jsonRes({ ...safe, status })
}

// ── GET /tunnels ───────────────────────────────────────────────────────────
export async function handleList(request, env) {
  const tunnels    = await listPublicTunnels(env.GITHUB_TOKEN)
  const inactivity = parseInt(env.INACTIVITY_DAYS || '30', 10)

  const active = tunnels
    .filter(t => !isOlderThan(t.last_seen, inactivity))
    .map(t => {
      const { token_hash: _t, ...safe } = t
      return { ...safe, status: getTunnelStatus(t, env) }
    })

  return jsonRes({
    ok:         true,
    count:      active.length,
    tunnels:    active,
    updated_at: nowISO(),
  })
}

// ── POST /tunnel/heartbeat/:subdomain ─────────────────────────────────────
export async function handleHeartbeat(request, env, sub) {
  // Rate limit: 1 heartbeat/hour per subdomain
  const rl = await checkRateLimit(request, 'tunnel:heartbeat', sub)
  if (rl) return rl

  const tunnel = await getTunnel(sub, env.GITHUB_TOKEN)
  if (!tunnel) return errRes('Tunnel not found', 404)

  const rawToken = extractBearer(request)
  if (!rawToken) return errRes('Token required', 401)

  const isOwner = await verifyToken(rawToken, tunnel.token_hash)
  if (!isOwner) return errRes('Invalid token', 403)

  const updated = { ...tunnel, last_seen: nowISO(), status: 'active' }
  await updateTunnel(tunnel.gist_id, updated, env.GITHUB_TOKEN)

  return jsonRes({ ok: true, subdomain: sub, last_seen: updated.last_seen })
}

// ── Cron: sweep expired tunnels ────────────────────────────────────────────
export async function sweepExpiredTunnels(env) {
  const tunnels      = await listPublicTunnels(env.GITHUB_TOKEN)
  const inactivity   = parseInt(env.INACTIVITY_DAYS || '30', 10)
  const graceDays    = parseInt(env.GRACE_DAYS || '30', 10)
  let   swept        = 0

  for (const tunnel of tunnels) {
    const status = getTunnelStatus(tunnel, env)

    if (status === 'active' || status === 'inactive') continue

    if (status === 'expired') {
      // Grace period expired — delete permanently
      if (tunnel.gist_id) {
        await deleteTunnel(tunnel.gist_id, env.GITHUB_TOKEN)
        swept++
      }
      continue
    }

    // Transition active/inactive → grace
    if (isOlderThan(tunnel.last_seen, inactivity) && !tunnel.grace_until) {
      if (tunnel.reserved) {
        const updated = {
          ...tunnel,
          status:      'grace',
          grace_until: daysFromNow(graceDays),
        }
        await updateTunnel(tunnel.gist_id, updated, env.GITHUB_TOKEN)
      } else {
        // Non-reserved: delete immediately
        await deleteTunnel(tunnel.gist_id, env.GITHUB_TOKEN)
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
    if (tunnel.grace_until && new Date(tunnel.grace_until) < new Date()) {
      return 'expired'
    }
    return 'grace'
  }

  if (isOlderThan(tunnel.last_seen, inactivity)) {
    if (tunnel.reserved) return 'grace'
    return 'expired'
  }

  // Inactive: no heartbeat in 7 days but not yet expired
  if (isOlderThan(tunnel.last_seen, 7)) return 'inactive'

  return 'active'
}

// ── User tunnel linking ────────────────────────────────────────────────────
async function linkTunnelToUser(sub, githubUsername, env) {
  const { data: users, gist_id } = await getRegistry(USERS_DESC, env.GITHUB_TOKEN)
  if (!users[githubUsername]) return
  if (!users[githubUsername].tunnels) users[githubUsername].tunnels = []
  if (!users[githubUsername].tunnels.includes(sub)) {
    users[githubUsername].tunnels.push(sub)
    await setRegistry(USERS_DESC, users, gist_id, env.GITHUB_TOKEN)
  }
}

async function unlinkTunnelFromUser(sub, githubUsername, env) {
  const { data: users, gist_id } = await getRegistry(USERS_DESC, env.GITHUB_TOKEN)
  if (!users[githubUsername]) return
  users[githubUsername].tunnels = (users[githubUsername].tunnels || []).filter(s => s !== sub)
  await setRegistry(USERS_DESC, users, gist_id, env.GITHUB_TOKEN)
}
