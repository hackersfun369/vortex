// ratelimit.js — IP-based rate limiting using Cloudflare Cache API

import { errRes, clientIP } from './utils.js'

const LIMITS = {
  'tunnel:create':    [{ max: 5,  windowSec: 3600,  label: '5/hour'  },
                       { max: 20, windowSec: 86400, label: '20/day'  }],
  'tunnel:delete':    [{ max: 30, windowSec: 3600,  label: '30/hour' }],
  'tunnel:heartbeat': [{ max: 1,  windowSec: 3600,  label: '1/hour per subdomain' }],
  'auth:login':       [{ max: 10, windowSec: 3600,  label: '10/hour' }],
  'admin:action':     [{ max: 100,windowSec: 3600,  label: '100/hour'}],
}

async function getCount(key) {
  const cache = caches.default
  const res   = await cache.match(new Request(`https://vortex-rl.internal/${key}`))
  return res ? parseInt(await res.text(), 10) || 0 : 0
}

async function incCount(key, windowSec) {
  const cache   = caches.default
  const current = await getCount(key)
  const next    = current + 1
  await cache.put(
    new Request(`https://vortex-rl.internal/${key}`),
    new Response(String(next), { headers: { 'Cache-Control': `public, max-age=${windowSec}` } })
  )
  return next
}

function bucket(windowSec) { return Math.floor(Date.now() / 1000 / windowSec) }

export async function checkRateLimit(request, action, subKey = '') {
  const ip     = clientIP(request)
  const limits = LIMITS[action]
  if (!limits) return null

  for (const limit of limits) {
    const key   = `rl:${action}:${ip}:${subKey}:${bucket(limit.windowSec)}`
    const count = await getCount(key)
    if (count >= limit.max) {
      const retryAfter = limit.windowSec - (Math.floor(Date.now() / 1000) % limit.windowSec)
      return errRes(`Rate limit exceeded: ${limit.label}`, 429, { retry_after: retryAfter })
    }
  }

  for (const limit of limits) {
    const key = `rl:${action}:${ip}:${subKey}:${bucket(limit.windowSec)}`
    await incCount(key, limit.windowSec)
  }
  return null
}
