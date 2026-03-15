// utils.js — shared helpers

const ADJECTIVES = [
  'swift','calm','bold','bright','clear','cool','dark','deep','fair','fast',
  'firm','free','full','glad','good','gray','great','green','hard','high',
  'keen','kind','large','late','light','long','loud','mild','neat','nice',
  'odd','pale','pure','rare','rich','safe','sharp','shy','slim','slow',
  'soft','still','strong','tall','thin','warm','wide','wild','wise','young'
]

const NOUNS = [
  'river','cloud','stone','flame','ridge','creek','brook','cliff','crest',
  'delta','dune','field','fjord','grove','haven','inlet','isle','lake',
  'marsh','mesa','moon','moor','peak','plain','pond','pool','port','reef',
  'shore','slope','sound','storm','stream','tide','trail','vale','wave',
  'wind','wood','bay','cape','cave','cove','dale','dawn','dusk','fog',
  'gale','glen','hill','knoll','leaf','mist','rain','rock','sand','sky'
]

// ── Subdomain generation ───────────────────────────────────────────────────
export function randomSubdomain() {
  const adj  = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]
  const num  = String(Math.floor(Math.random() * 9000) + 1000)
  return `${adj}-${noun}-${num}`
}

export const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9\-]{1,61}[a-z0-9]$/
export const RESERVED_SUBS = new Set([
  'www','api','admin','mail','ftp','ssh','registry','vortex',
  'health','status','docs','live','portal','dashboard','expired',
  'auth','install','static','assets','cdn','help','support'
])

export function validateSubdomain(sub) {
  if (!sub || typeof sub !== 'string') return 'subdomain is required'
  const s = sub.toLowerCase().trim()
  if (!SUBDOMAIN_RE.test(s))
    return 'subdomain must be 3-63 chars, lowercase letters, numbers, hyphens only'
  if (RESERVED_SUBS.has(s))
    return `"${s}" is a reserved subdomain`
  return null
}

// ── Token / hashing ────────────────────────────────────────────────────────
export function generateToken(prefix = '', len = 32) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  const raw   = Array.from(bytes, b => chars[b % chars.length]).join('')
  return prefix ? `${prefix}_${raw}` : raw
}

export async function sha256(str) {
  const buf  = new TextEncoder().encode(str)
  const hash = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2,'0')).join('')
}

export async function verifyToken(raw, hash) {
  return (await sha256(raw)) === hash
}

// ── TOON helpers ───────────────────────────────────────────────────────────
// Lightweight TOON encoder/decoder for Gist storage
// TOON: indented key-value, no braces/brackets/quotes for simple values

export function encodeTOON(obj, indent = 0) {
  const pad = '  '.repeat(indent)
  const lines = []
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) {
      lines.push(`${pad}${k}: null`)
    } else if (typeof v === 'boolean' || typeof v === 'number') {
      lines.push(`${pad}${k}: ${v}`)
    } else if (typeof v === 'string') {
      // quote strings containing special chars
      const needsQuote = /[:\n\r#]/.test(v) || v.trim() !== v
      lines.push(`${pad}${k}: ${needsQuote ? `"${v.replace(/"/g, '\\"')}"` : v}`)
    } else if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`${pad}${k}: []`)
      } else if (v.every(i => typeof i !== 'object' || i === null)) {
        lines.push(`${pad}${k}: [${v.join(', ')}]`)
      } else {
        lines.push(`${pad}${k}:`)
        v.forEach(item => {
          if (typeof item === 'object' && item !== null) {
            lines.push(`${pad}  -`)
            lines.push(encodeTOON(item, indent + 2).split('\n').map(l => '  ' + l).join('\n'))
          } else {
            lines.push(`${pad}  - ${item}`)
          }
        })
      }
    } else if (typeof v === 'object') {
      lines.push(`${pad}${k}:`)
      lines.push(encodeTOON(v, indent + 1))
    }
  }
  return lines.join('\n')
}

export function decodeTOON(text) {
  // Parse TOON back to JS object
  const lines  = text.split('\n')
  const result = {}
  const stack  = [{ obj: result, indent: -1 }]

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) continue

    const indent = line.length - line.trimStart().length
    const trimmed = line.trim()

    // pop stack to correct level
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop()
    }

    const current = stack[stack.length - 1].obj
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx === -1) continue

    const key = trimmed.slice(0, colonIdx).trim()
    const val = trimmed.slice(colonIdx + 1).trim()

    if (val === '' || val === undefined) {
      // nested object follows
      const nested = {}
      current[key] = nested
      stack.push({ obj: nested, indent })
    } else if (val === 'null')          current[key] = null
    else if (val === 'true')            current[key] = true
    else if (val === 'false')           current[key] = false
    else if (val === '[]')              current[key] = []
    else if (/^\[.+\]$/.test(val))     current[key] = val.slice(1,-1).split(',').map(s => s.trim())
    else if (/^-?\d+(\.\d+)?$/.test(val)) current[key] = Number(val)
    else if (val.startsWith('"'))       current[key] = val.slice(1,-1).replace(/\\"/g,'"')
    else                                current[key] = val
  }

  return result
}

// ── HTTP helpers ───────────────────────────────────────────────────────────
export const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Vortex-Privacy',
}

export function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

export function errRes(message, status = 400, extra = {}) {
  return jsonRes({ ok: false, error: message, ...extra }, status)
}

// ── Date helpers ───────────────────────────────────────────────────────────
export function nowISO()  { return new Date().toISOString() }
export function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString()
}
export function daysFromNow(n) {
  return new Date(Date.now() + n * 86400000).toISOString()
}
export function isOlderThan(isoDate, days) {
  return new Date(isoDate).getTime() < Date.now() - days * 86400000
}

// ── Extract bearer token ───────────────────────────────────────────────────
export function extractBearer(request) {
  const auth = request.headers.get('Authorization') || ''
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : null
}

// ── IP for rate limiting ───────────────────────────────────────────────────
export function clientIP(request) {
  return request.headers.get('CF-Connecting-IP') ||
         request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
         'unknown'
}