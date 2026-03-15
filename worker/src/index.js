// index.js — Vortex Cloudflare Worker main router

import { jsonRes, errRes, CORS } from './utils.js'

import {
  handleAuthGitHub, handleAuthCallback, handleLogout,
  handleMyTunnels, handleRecoverApiKey, handleApplyApiAccess,
  handleAdminUsers, handleAdminApplications,
  handleAdminApprove, handleAdminRevoke,
  handleAdminSuspend, handleAdminUnsuspend,
  handleAdminDebug, handleAdminRecoverKey,
} from './auth.js'

import {
  handleCreate, handleDelete, handleGet,
  handleList, handleHeartbeat,
  handleRecoverTunnelToken,
  sweepExpiredTunnels,
} from './tunnel.js'

export default {
  // ── HTTP handler ──────────────────────────────────────────────────────────
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }

    const url    = new URL(request.url)
    const path   = url.pathname.replace(/\/$/, '') || '/'
    const method = request.method

    try {

      // ── Health ─────────────────────────────────────────────────────────
      if (method === 'GET' && path === '/health') {
        return jsonRes({ status: 'ok', version: '2.0.0', ts: Date.now() })
      }

      // ── Public tunnel endpoints ────────────────────────────────────────
      if (method === 'POST' && path === '/tunnel/create') {
        return handleCreate(request, env)
      }

      if (method === 'GET' && path === '/tunnels') {
        return handleList(request, env)
      }

      if (method === 'GET' && path.startsWith('/tunnel/') && !path.includes('/heartbeat') && !path.includes('/recover')) {
        const sub = path.split('/')[2]
        if (!sub) return errRes('Subdomain required', 400)
        return handleGet(request, env, sub)
      }

      if (method === 'DELETE' && path.startsWith('/tunnel/')) {
        const sub = path.split('/')[2]
        if (!sub) return errRes('Subdomain required', 400)
        return handleDelete(request, env, sub)
      }

      // ── Auth ───────────────────────────────────────────────────────────
      if (method === 'GET'  && path === '/auth/github')   return handleAuthGitHub(request, env)
      if (method === 'GET'  && path === '/auth/callback') return handleAuthCallback(request, env)
      if (method === 'POST' && path === '/auth/logout')   return handleLogout(request, env)

      // ── Authenticated endpoints ────────────────────────────────────────
      if (method === 'POST' && path.includes('/tunnel/heartbeat/')) {
        const sub = path.split('/heartbeat/')[1]
        if (!sub) return errRes('Subdomain required', 400)
        return handleHeartbeat(request, env, sub)
      }

      if (method === 'GET' && path.includes('/tunnel/recover/')) {
        const sub = path.split('/recover/')[1]
        if (!sub) return errRes('Subdomain required', 400)
        return handleRecoverTunnelToken(request, env, sub)
      }

      if (method === 'GET'  && path === '/my/tunnels')          return handleMyTunnels(request, env)
      if (method === 'GET'  && path === '/my/recover-apikey')   return handleRecoverApiKey(request, env)
      if (method === 'POST' && path === '/my/apply-api-access') return handleApplyApiAccess(request, env)

      // ── Admin (owner only) ─────────────────────────────────────────────
      if (method === 'GET'    && path === '/admin/debug')               return handleAdminDebug(request, env)
      if (method === 'GET'    && path.startsWith('/admin/recover-key/'))  return handleAdminRecoverKey(request, env, path.split('/admin/recover-key/')[1])
      if (method === 'GET'    && path === '/admin/users')               return handleAdminUsers(request, env)
      if (method === 'GET'    && path === '/admin/applications')        return handleAdminApplications(request, env)

      if (method === 'POST'   && path.startsWith('/admin/approve/')) {
        return handleAdminApprove(request, env, path.split('/admin/approve/')[1])
      }
      if (method === 'DELETE' && path.startsWith('/admin/revoke/')) {
        return handleAdminRevoke(request, env, path.split('/admin/revoke/')[1])
      }
      if (method === 'POST'   && path.startsWith('/admin/suspend/')) {
        return handleAdminSuspend(request, env, path.split('/admin/suspend/')[1])
      }
      if (method === 'POST'   && path.startsWith('/admin/unsuspend/')) {
        return handleAdminUnsuspend(request, env, path.split('/admin/unsuspend/')[1])
      }

      return errRes('Not found', 404)

    } catch (err) {
      console.error('[vortex]', err.message, err.stack)
      return errRes('Internal server error', 500)
    }
  },

  // ── Cron: daily sweep ─────────────────────────────────────────────────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      sweepExpiredTunnels(env).then(n => {
        console.log(`[vortex cron] swept ${n} expired tunnels`)
      })
    )
  },
}
