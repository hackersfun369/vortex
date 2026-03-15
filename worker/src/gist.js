// v2.0.0 - full rewrite
// gist.js — GitHub Gist storage, one Gist per record, pure JSON

// ── Gist description prefixes ──────────────────────────────────────────────
export const PREFIX_TUNNEL  = 'vortex:tunnel:'
export const PREFIX_USER    = 'vortex:user:'
export const PREFIX_PENDING = 'vortex:pending:'
export const FILENAME       = 'data.json'

// ── Core GitHub API request ────────────────────────────────────────────────
async function gh(method, path, body, token) {
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
    throw new Error(`GitHub ${res.status}: ${err}`)
  }
  return res.status === 204 ? null : res.json()
}

// ── Read full Gist content by ID ───────────────────────────────────────────
async function readGist(id, token) {
  const gist = await gh('GET', `/${id}`, null, token)
  const raw  = gist?.files?.[FILENAME]?.content
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

// ── Write full Gist content by ID ─────────────────────────────────────────
async function writeGist(id, data, token) {
  await gh('PATCH', `/${id}`, {
    files: { [FILENAME]: { content: JSON.stringify(data, null, 2) } },
  }, token)
}

// ── Find Gist ID by description ────────────────────────────────────────────
async function findId(description, token) {
  let page = 1
  while (true) {
    const list = await gh('GET', `?per_page=100&page=${page}`, null, token)
    if (!list?.length) return null
    const match = list.find(g => g.description === description)
    if (match) return match.id
    if (list.length < 100) return null
    page++
  }
}

// ── Create a new Gist ──────────────────────────────────────────────────────
async function createGist(description, data, isPublic, token) {
  const gist = await gh('POST', '', {
    description,
    public: isPublic,
    files: { [FILENAME]: { content: JSON.stringify(data, null, 2) } },
  }, token)
  return gist.id
}

// ── Delete a Gist ──────────────────────────────────────────────────────────
async function deleteGist(id, token) {
  await gh('DELETE', `/${id}`, null, token)
}

// ══════════════════════════════════════════════════════════════════════════════
// TUNNEL OPERATIONS
// ══════════════════════════════════════════════════════════════════════════════

export async function getTunnel(subdomain, token) {
  const id = await findId(`${PREFIX_TUNNEL}${subdomain}`, token)
  if (!id) return null
  const data = await readGist(id, token)
  return data ? { ...data, _gist_id: id } : null
}

export async function saveTunnel(data, token) {
  const desc    = `${PREFIX_TUNNEL}${data.subdomain}`
  const isPublic = !data.private
  const existing = await findId(desc, token)
  if (existing) {
    await writeGist(existing, data, token)
    return { ...data, _gist_id: existing }
  }
  const id = await createGist(desc, data, isPublic, token)
  return { ...data, _gist_id: id }
}

export async function deleteTunnel(subdomain, token) {
  const id = await findId(`${PREFIX_TUNNEL}${subdomain}`, token)
  if (id) await deleteGist(id, token)
}

export async function listPublicTunnels(token) {
  let page = 1
  const tunnels = []
  while (true) {
    const list = await gh('GET', `?per_page=100&page=${page}`, null, token)
    if (!list?.length) break
    for (const g of list) {
      if (!g.description?.startsWith(PREFIX_TUNNEL)) continue
      if (!g.public) continue
      const data = await readGist(g.id, token)
      if (data?.status === 'active') {
        const { token_hash: _h, token_encrypted: _e, ...safe } = data
        tunnels.push({ ...safe, _gist_id: g.id })
      }
    }
    if (list.length < 100) break
    page++
  }
  return tunnels
}

// ══════════════════════════════════════════════════════════════════════════════
// USER OPERATIONS
// ══════════════════════════════════════════════════════════════════════════════

export async function getUser(username, token) {
  const id = await findId(`${PREFIX_USER}${username}`, token)
  if (!id) return null
  const data = await readGist(id, token)
  return data ? { ...data, _gist_id: id } : null
}

export async function saveUser(data, token) {
  const desc     = `${PREFIX_USER}${data.github_username}`
  const existing = await findId(desc, token)
  if (existing) {
    await writeGist(existing, data, token)
    return { ...data, _gist_id: existing }
  }
  const id = await createGist(desc, data, false, token)
  return { ...data, _gist_id: id }
}

export async function listUsers(token) {
  let page = 1
  const users = []
  while (true) {
    const list = await gh('GET', `?per_page=100&page=${page}`, null, token)
    if (!list?.length) break
    for (const g of list) {
      if (!g.description?.startsWith(PREFIX_USER)) continue
      const data = await readGist(g.id, token)
      if (data) {
        const { api_key_hash: _h, api_key_encrypted: _e, ...safe } = data
        users.push({ ...safe, _gist_id: g.id })
      }
    }
    if (list.length < 100) break
    page++
  }
  return users
}

// ══════════════════════════════════════════════════════════════════════════════
// PENDING APPLICATION OPERATIONS
// ══════════════════════════════════════════════════════════════════════════════

export async function getPending(username, token) {
  const id = await findId(`${PREFIX_PENDING}${username}`, token)
  if (!id) return null
  const data = await readGist(id, token)
  return data ? { ...data, _gist_id: id } : null
}

export async function savePending(data, token) {
  const desc     = `${PREFIX_PENDING}${data.github_username}`
  const existing = await findId(desc, token)
  if (existing) {
    await writeGist(existing, data, token)
    return { ...data, _gist_id: existing }
  }
  const id = await createGist(desc, data, false, token)
  return { ...data, _gist_id: id }
}

export async function deletePending(username, token) {
  const id = await findId(`${PREFIX_PENDING}${username}`, token)
  if (id) await deleteGist(id, token)
}

export async function listPending(token) {
  let page = 1
  const apps = []
  while (true) {
    const list = await gh('GET', `?per_page=100&page=${page}`, null, token)
    if (!list?.length) break
    for (const g of list) {
      if (!g.description?.startsWith(PREFIX_PENDING)) continue
      const data = await readGist(g.id, token)
      if (data) apps.push({ ...data, _gist_id: g.id })
    }
    if (list.length < 100) break
    page++
  }
  return apps
}

// ══════════════════════════════════════════════════════════════════════════════
// DEBUG
// ══════════════════════════════════════════════════════════════════════════════

export async function debugListAllGists(token) {
  try {
    const list = await gh('GET', '?per_page=100', null, token)
    if (!Array.isArray(list)) return { error: list }
    return list.map(g => ({
      id:          g.id,
      description: g.description,
      public:      g.public,
      updated_at:  g.updated_at,
      files:       Object.keys(g.files || {}),
    }))
  } catch (err) {
    return { error: err.message }
  }
}

