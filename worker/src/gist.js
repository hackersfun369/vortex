// gist.js — GitHub Gist storage layer (TOON format)

import { encodeTOON, decodeTOON } from './utils.js'

// ── Gist descriptions used as lookup keys ─────────────────────────────────
export const GIST_PREFIX      = 'vortex:tunnel:'
export const USERS_DESC       = 'vortex:registry:users'
export const PENDING_DESC     = 'vortex:registry:pending'
export const APPROVED_DESC    = 'vortex:registry:approved'
export const FILENAME         = 'data.toon'

// ── Core Gist API wrapper ─────────────────────────────────────────────────
async function gistRequest(method, path, body, token) {
  const res = await fetch(`https://api.github.com/gists${path}`, {
    method,
    headers: {
      'Authorization': `token ${token}`,
      'Accept':        'application/vnd.github.v3+json',
      'Content-Type':  'application/json',
      'User-Agent':    'vortex-tunnel-service',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`GitHub API ${res.status}: ${err}`)
  }
  return res.status === 204 ? null : res.json()
}

// ── Create a Gist ─────────────────────────────────────────────────────────
export async function createGist(description, data, isPublic, token) {
  const content = encodeTOON(data)
  return gistRequest('POST', '', {
    description,
    public: isPublic,
    files: { [FILENAME]: { content } },
  }, token)
}

// ── Update a Gist ─────────────────────────────────────────────────────────
export async function updateGist(gistId, data, token) {
  const content = encodeTOON(data)
  return gistRequest('PATCH', `/${gistId}`, {
    files: { [FILENAME]: { content } },
  }, token)
}

// ── Delete a Gist ─────────────────────────────────────────────────────────
export async function deleteGist(gistId, token) {
  return gistRequest('DELETE', `/${gistId}`, null, token)
}

// ── Get a Gist by ID ──────────────────────────────────────────────────────
export async function getGistById(gistId, token) {
  const gist = await gistRequest('GET', `/${gistId}`, null, token)
  const raw  = gist?.files?.[FILENAME]?.content
  return raw ? decodeTOON(raw) : null
}

// ── List all Gists and find by description ────────────────────────────────
export async function findGistByDescription(description, token) {
  let page = 1
  while (true) {
    const gists = await gistRequest('GET', `?per_page=100&page=${page}`, null, token)
    if (!gists || gists.length === 0) return null
    const match = gists.find(g => g.description === description)
    if (match) return match
    if (gists.length < 100) return null
    page++
  }
}

// ── Tunnel-specific helpers ───────────────────────────────────────────────

export async function getTunnel(subdomain, token) {
  const desc = `${GIST_PREFIX}${subdomain}`
  const gist = await findGistByDescription(desc, token)
  if (!gist) return null
  const raw = gist.files?.[FILENAME]?.content
  const data = raw ? decodeTOON(raw) : null
  return data ? { ...data, gist_id: gist.id } : null
}

export async function createTunnel(data, isPublic, token) {
  const desc = `${GIST_PREFIX}${data.subdomain}`
  const gist = await createGist(desc, data, isPublic, token)
  return { ...data, gist_id: gist.id }
}

export async function updateTunnel(gistId, data, token) {
  await updateGist(gistId, data, token)
  return data
}

export async function deleteTunnel(gistId, token) {
  await deleteGist(gistId, token)
}

export async function listPublicTunnels(token) {
  let page = 1
  const tunnels = []
  while (true) {
    const gists = await gistRequest('GET', `?per_page=100&page=${page}`, null, token)
    if (!gists || gists.length === 0) break
    for (const g of gists) {
      if (!g.description?.startsWith(GIST_PREFIX)) continue
      if (!g.public) continue
      const raw = g.files?.[FILENAME]?.content
      if (!raw) continue
      const data = decodeTOON(raw)
      if (data?.status === 'active') {
        const { token_hash: _t, ...safe } = data
        tunnels.push({ ...safe, gist_id: g.id })
      }
    }
    if (gists.length < 100) break
    page++
  }
  return tunnels
}

// ── Registry Gist helpers (users / pending / approved) ───────────────────

export async function getRegistry(description, token) {
  const gist = await findGistByDescription(description, token)
  if (!gist) return { data: {}, gist_id: null }
  const raw  = gist.files?.[FILENAME]?.content
  return { data: raw ? decodeTOON(raw) : {}, gist_id: gist.id }
}

export async function setRegistry(description, data, gistId, token) {
  if (gistId) {
    await updateGist(gistId, data, token)
  } else {
    const gist = await createGist(description, data, false, token)
    return gist.id
  }
  return gistId
}
