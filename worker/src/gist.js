// gist.js — GitHub Gist storage layer (JSON format)

// ── Gist descriptions used as lookup keys ─────────────────────────────────
export const GIST_PREFIX   = 'vortex:tunnel:'
export const USERS_DESC    = 'vortex:registry:users'
export const PENDING_DESC  = 'vortex:registry:pending'
export const APPROVED_DESC = 'vortex:registry:approved'
export const FILENAME      = 'data.json'

// ── Core Gist API wrapper ──────────────────────────────────────────────────
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

// ── Create a Gist ──────────────────────────────────────────────────────────
export async function createGist(description, data, isPublic, token) {
  return gistRequest('POST', '', {
    description,
    public: isPublic,
    files: { [FILENAME]: { content: JSON.stringify(data, null, 2) } },
  }, token)
}

// ── Update a Gist ──────────────────────────────────────────────────────────
export async function updateGist(gistId, data, token) {
  return gistRequest('PATCH', `/${gistId}`, {
    files: { [FILENAME]: { content: JSON.stringify(data, null, 2) } },
  }, token)
}

// ── Delete a Gist ──────────────────────────────────────────────────────────
export async function deleteGist(gistId, token) {
  return gistRequest('DELETE', `/${gistId}`, null, token)
}

// ── Get a Gist by ID ───────────────────────────────────────────────────────
export async function getGistById(gistId, token) {
  const gist = await gistRequest('GET', `/${gistId}`, null, token)
  const raw  = gist?.files?.[FILENAME]?.content
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

// ── Find Gist by description ───────────────────────────────────────────────
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

// ── Tunnel helpers ─────────────────────────────────────────────────────────
export async function getTunnel(subdomain, token) {
  const desc = `${GIST_PREFIX}${subdomain}`
  const gist = await findGistByDescription(desc, token)
  if (!gist) return null
  const full = await gistRequest('GET', `/${gist.id}`, null, token)
  const raw  = full?.files?.[FILENAME]?.content
  if (!raw) return null
  try {
    const data = JSON.parse(raw)
    return { ...data, gist_id: gist.id }
  } catch { return null }
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
      try {
        const full = await gistRequest('GET', `/${g.id}`, null, token)
        const raw  = full?.files?.[FILENAME]?.content
        if (!raw) continue
        const data = JSON.parse(raw)
        if (data?.status === 'active') {
          const { token_hash: _t, ...safe } = data
          tunnels.push({ ...safe, gist_id: g.id })
        }
      } catch { continue }
    }
    if (gists.length < 100) break
    page++
  }
  return tunnels
}

// ── Registry helpers ───────────────────────────────────────────────────────
export async function getRegistry(description, token) {
  try {
    const gist = await findGistByDescription(description, token)
    if (!gist) return { data: {}, gist_id: null }
    const full = await gistRequest('GET', `/${gist.id}`, null, token)
    const raw  = full?.files?.[FILENAME]?.content
    if (!raw) return { data: {}, gist_id: gist.id }
    const data = JSON.parse(raw)
    return { data: data || {}, gist_id: gist.id }
  } catch (err) {
    console.error('[vortex] getRegistry error:', err.message)
    return { data: {}, gist_id: null }
  }
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

export async function debugListGists(token) {
  try {
    const res = await fetch('https://api.github.com/gists?per_page=100', {
      headers: {
        'Authorization': `token ${token}`,
        'Accept':        'application/vnd.github.v3+json',
        'User-Agent':    'vortex-tunnel-service',
      },
    })
    const gists = await res.json()
    if (!Array.isArray(gists)) return { error: gists }
    return gists.map(g => ({
      id:          g.id,
      description: g.description,
      public:      g.public,
      updated_at:  g.updated_at,
      files:       Object.keys(g.files || {}),
    }))
  } catch(err) {
    return { error: err.message }
  }
}

// ── Migration: convert old TOON Gist to JSON ───────────────────────────────
export async function migrateGistToJson(gistId, token) {
  try {
    const gist = await gistRequest('GET', `/${gistId}`, null, token)
    // Check if it has old data.toon file
    const toonRaw = gist?.files?.['data.toon']?.content
    if (!toonRaw) return { skipped: true }

    // Simple TOON to JSON migration using the decoder
    const { decodeTOON } = await import('./utils.js')
    const data = decodeTOON(toonRaw)

    // Update Gist with JSON file, remove TOON file
    await gistRequest('PATCH', `/${gistId}`, {
      files: {
        'data.toon': null,                              // delete old file
        [FILENAME]:  { content: JSON.stringify(data, null, 2) }, // create new
      },
    }, token)
    return { migrated: true, data }
  } catch (err) {
    return { error: err.message }
  }
}
