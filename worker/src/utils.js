// v2.0.0 - full rewrite
// utils.js — shared helpers, crypto, subdomain generation

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

// ── Subdomain ──────────────────────────────────────────────────────────────
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
  if (!SUBDOMAIN_RE.test(s)) return 'subdomain: 3-63 chars, lowercase letters, numbers, hyphens only'
  if (RESERVED_SUBS.has(s))  return `"${s}" is a reserved subdomain`
  return null
}

// ── Token generation ───────────────────────────────────────────────────────
export function generateToken(prefix = '', len = 32) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  const raw   = Array.from(bytes, b => chars[b % chars.length]).join('')
  return prefix ? `${prefix}_${raw}` : raw
}

export function tokenHint(raw) {
  if (!raw || raw.length < 8) return '****'
  return raw.slice(0, 4) + '...' + raw.slice(-4)
}

// ── SHA-256 hashing ────────────────────────────────────────────────────────
export async function sha256(str) {
  const buf  = new TextEncoder().encode(str)
  const hash = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2,'0')).join('')
}

export async function verifyToken(raw, hash) {
  if (!raw || !hash) return false
  return (await sha256(raw)) === hash
}

// ── AES-256-GCM encryption ─────────────────────────────────────────────────
async function getEncryptionKey(hexKey) {
  const raw = new Uint8Array(hexKey.match(/.{1,2}/g).map(b => parseInt(b, 16)))
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function encryptToken(plaintext, hexKey) {
  try {
    const key = await getEncryptionKey(hexKey)
    const iv  = crypto.getRandomValues(new Uint8Array(12))
    const enc = new TextEncoder().encode(plaintext)
    const ct  = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc)
    const ivB64 = btoa(String.fromCharCode(...iv))
    const ctB64 = btoa(String.fromCharCode(...new Uint8Array(ct)))
    return `${ivB64}:${ctB64}`
  } catch (err) {
    throw new Error(`encrypt failed: ${err.message}`)
  }
}

export async function decryptToken(encrypted, hexKey) {
  try {
    const [ivB64, ctB64] = encrypted.split(':')
    if (!ivB64 || !ctB64) throw new Error('invalid encrypted format')
    const iv  = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0))
    const ct  = Uint8Array.from(atob(ctB64), c => c.charCodeAt(0))
    const key = await getEncryptionKey(hexKey)
    const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
    return new TextDecoder().decode(dec)
  } catch (err) {
    throw new Error(`decrypt failed: ${err.message}`)
  }
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
export function nowISO()               { return new Date().toISOString() }
export function daysFromNow(n)         { return new Date(Date.now() + n * 86400000).toISOString() }
export function isOlderThan(iso, days) { return new Date(iso).getTime() < Date.now() - days * 86400000 }

// ── Extract bearer token ───────────────────────────────────────────────────
export function extractBearer(request) {
  const auth = request.headers.get('Authorization') || ''
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : null
}

// ── Client IP ──────────────────────────────────────────────────────────────
export function clientIP(request) {
  return request.headers.get('CF-Connecting-IP') ||
         request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
         'unknown'
}

