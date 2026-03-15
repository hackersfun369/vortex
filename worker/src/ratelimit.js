// ratelimit.js — IP-based rate limiting using Cloudflare Cache API

import { errRes, clientIP } from './utils.js'

// Limits per action
const LIMITS = {
  'tunnel:create': [
    { max: 5,  windowSec: 3600,  label: '5 per hour' },
    { max: 20, windowSec: 86400, label: '20 per day'  },
  ],
  'tunnel:delete': [
    { max: 30, windowSec: 3600, label: '30 per hour' },
  ],
  'tunnel:heartbeat': [
    { max: 1, windowSec: 3600, label: '1 per hour per subdomain' },
  ],
  'auth:login': [
    { max: 10, windowSec: 3600, label: '10 per hour' },
  ],
  'admin:action': [
    { max: 100, windowSec: 3600, label: '100 per hour' },
  ],
}

// Uses Cloudflare's Cache API as an ephemeral counter store
// Key format: rl:<action>:<ip>:<window_bucket>

async function getCount(key) {
  const cache = caches.default
  const req   = new Request(`https://vortex-rl.internal/${key}`)
  const res   = await cache.match(req)
  if (!res) return 0
  return parseInt(await res.text(), 10) || 0
}

async function incCount(key, windowSec) {
  const cache   = caches.default
  const req     = new Request(`https://vortex-rl.internal/${key}`)
  const current = await getCount(key)
  const next    = current + 1
  const res     = new Response(String(next), {
    headers: { 'Cache-Control': `public, max-age=${windowSec}` },
  })
  await cache.put(req, res)
  return next
}

function windowBucket(windowSec) {
  return Math.floor(Date.now() / 1000 / windowSec)
}

// Returns null if ok, or an error Response if rate limited
export async function checkRateLimit(request, action, subKey = '') {
  const ip     = clientIP(request)
  const limits = LIMITS[action]
  if (!limits) return null

  for (const limit of limits) {
    const bucket = windowBucket(limit.windowSec)
    const key    = `rl:${action}:${ip}:${subKey}:${bucket}`
    const count  = await getCount(key)

    if (count >= limit.max) {
      const retryAfter = limit.windowSec - (Math.floor(Date.now() / 1000) % limit.windowSec)
      return errRes(
        `Rate limit exceeded: ${limit.label}`,
        429,
        {
          retry_after: retryAfter,
          limit: limit.label,
          hint: 'Use the portal at hackersfun369.github.io/vortex/portal.html for manual tunnel creation',
        }
      )
    }
  }

  // All checks passed — increment all counters
  for (const limit of limits) {
    const bucket = windowBucket(limit.windowSec)
    const key    = `rl:${action}:${ip}:${subKey}:${bucket}`
    await incCount(key, limit.windowSec)
  }

  return null
}