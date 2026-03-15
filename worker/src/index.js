// index.js — Vortex Cloudflare Worker main router

import { jsonRes, errRes, CORS } from './utils.js'
import {
  handleAuthGitHub, handleAuthCallback, handleLogout,
  handleMyTunnels, handleApplyApiAccess,
  handleAdminApplications, handleAdminApprove, handleAdminRevoke,
  handleAdminUsers,
} from './auth.js'
import {
  handleCreate, handleDelete, handleGet,
  handleList, handleHeartbeat, sweepExpiredTunnels,
} from './tunnel.js'

export default {
  // ── HTTP requests ────────────────────────────────────────────────────────
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }

    const url    = new URL(request.url)
    const path   = url.pathname.replace(/\/$/, '') || '/'
    const method = request.method

    try {
      // ── Public ────────────────────────────────────────────────────────
      if (method === 'GET' && path === '/health') {
        return jsonRes({ status: 'ok', version: '1.0.0', ts: Date.now() })
      }

      if (method === 'POST' && path === '/tunnel/create') {
        return handleCreate(request, env)
      }

      if (method === 'GET' && path === '/tunnels') {
        return handleList(request, env)
      }

      if (method === 'GET' && path.startsWith('/tunnel/') && !path.includes('/heartbeat')) {
        const sub = path.split('/')[2]
        if (!sub) return errRes('Subdomain required', 400)
        return handleGet(request, env, sub)
      }

      if (method === 'DELETE' && path.startsWith('/tunnel/')) {
        const sub = path.split('/')[2]
        if (!sub) return errRes('Subdomain required', 400)
        return handleDelete(request, env, sub)
      }

      // ── Auth ──────────────────────────────────────────────────────────
      if (method === 'GET'  && path === '/auth/github')   return handleAuthGitHub(request, env)
      if (method === 'GET'  && path === '/auth/callback') return handleAuthCallback(request, env)
      if (method === 'POST' && path === '/auth/logout')   return handleLogout(request, env)

      // ── Authenticated ─────────────────────────────────────────────────
      if (method === 'POST' && path.includes('/tunnel/heartbeat/')) {
        const sub = path.split('/heartbeat/')[1]
        if (!sub) return errRes('Subdomain required', 400)
        return handleHeartbeat(request, env, sub)
      }

      if (method === 'GET'    && path === '/my/tunnels')          return handleMyTunnels(request, env)
      if (method === 'POST'   && path === '/my/apply-api-access') return handleApplyApiAccess(request, env)

      // ── Admin (owner only) ────────────────────────────────────────────
      if (method === 'GET'    && path === '/admin/applications')        return handleAdminApplications(request, env)
      if (method === 'GET'    && path === '/admin/users')               return handleAdminUsers(request, env)
      if (method === 'POST'   && path.startsWith('/admin/approve/')) {
        const username = path.split('/admin/approve/')[1]
        return handleAdminApprove(request, env, username)
      }
      if (method === 'DELETE' && path.startsWith('/admin/revoke/')) {
        const username = path.split('/admin/revoke/')[1]
        return handleAdminRevoke(request, env, username)
      }

      return errRes('Not found', 404)

    } catch (err) {
      console.error('[vortex]', err.message, err.stack)
      return errRes('Internal server error', 500)
    }
  },

  // ── Cron trigger — runs daily to sweep expired tunnels ────────────────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      sweepExpiredTunnels(env).then(n => {
        console.log(`[vortex cron] swept ${n} expired tunnels`)
      })
    )
  },
}
