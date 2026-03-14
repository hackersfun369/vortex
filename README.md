# ⬡ Vortex

> Instant secure tunnels — free forever, no credit card, no server, no limits.

Expose any local port, API, web page, or service to the internet in seconds via a named subdomain on your own domain. Built entirely on free infrastructure.

---

## How it works

```
Your machine                    Cloudflare Edge
localhost:3000  ←── tunnel ───  myapp.hackersfun369.github.io
                  cloudflared                         ↑
                  (outbound TLS)               Visitor's request
```

1. Run `vortex 3000 -s myapp`
2. Get `https://myapp.hackersfun369.github.io` — live in seconds
3. All traffic flows directly through Cloudflare — Vortex never sees your payload

---

## Quick start

```sh
# Install
curl -fsSL https://hackersfun369.github.io/install.sh | sh

# Expose a port
vortex 3000

# Custom subdomain
vortex 3000 -s myapp

# Private mode (no logs, not listed)
vortex 3000 --privacy

# Reserve subdomain permanently (requires API key)
vortex 3000 -s myapp --reserve -k vrtx_yourkey
```

**No install? Use the portal:** https://hackersfun369.github.io/portal

---

## CLI reference

```
vortex <port> [flags]

Flags:
  -s, --subdomain <n>   preferred subdomain (auto-generates if omitted)
  -p, --privacy            private mode — no logs, no public registry
  -r, --reserve            reserve subdomain permanently (API key required)
  -t, --token <token>      your subdomain token (to reclaim)
  -k, --api-key <key>      your Vortex API key
      --version            print version
      --help               show help

Environment:
  VORTEX_PRIVACY=1         same as --privacy
  VORTEX_TOKEN=<token>     same as -t
  VORTEX_API_KEY=<key>     same as -k
```

---

## REST API

**Base URL:** `https://hackersfun369.github.io`

### Create a tunnel
```http
POST /tunnel/create
Content-Type: application/json
Authorization: Bearer vrtx_yourkey   (optional — required for reserve)

{
  "subdomain": "myapp",
  "port": 3000,
  "privacy": false,
  "reserve": true
}
```

Response:
```json
{
  "ok": true,
  "subdomain": "myapp",
  "url": "https://myapp.hackersfun369.github.io",
  "token": "save-this-to-delete-later",
  "reserved": true,
  "cloudflared_cmd": "cloudflared tunnel --url http://localhost:3000 --hostname myapp.hackersfun369.github.io",
  "install_cmd": "curl -fsSL https://hackersfun369.github.io/install.sh | sh"
}
```

### Get tunnel info
```http
GET /tunnel/:subdomain
```

### Delete a tunnel
```http
DELETE /tunnel/:subdomain
Authorization: Bearer <your-token>
```

### List active tunnels
```http
GET /tunnels
```

### Heartbeat (keep alive)
```http
POST /tunnel/heartbeat/:subdomain
Authorization: Bearer <your-token>
```

### My tunnels (authenticated)
```http
GET /my/tunnels
Authorization: Bearer vrtx_yourkey
```

### Apply for API access
```http
POST /my/apply-api-access
Authorization: Bearer vrtx_yourkey
Content-Type: application/json

{ "reason": "building a mobile app" }
```

---

## Subdomain lifecycle

```
AVAILABLE → ACTIVE → INACTIVE (7 days no heartbeat) → EXPIRED
                                                            ↓
                                              reserved? 30-day grace period
                                                            ↓
                                                    FREED (anyone can claim)
```

- **Inactivity timeout:** 30 days (configurable via `INACTIVITY_DAYS` env var)
- **Grace period** (reserved subdomains): 30 days after expiry before anyone else can claim
- **Non-reserved:** freed immediately on expiry
- **Token holders:** can reclaim their subdomain during grace period

---

## Privacy mode

Pass `--privacy` or `"privacy": true` in the API:
- Tunnel stored as a **secret Gist** (not publicly listed)
- Excluded from `/tunnels` board
- No metadata stored beyond the subdomain and token hash

---

## User types

| Type | Access | How to get |
|---|---|---|
| Guest | Portal only — copy one command | Visit the site |
| Registered | Dashboard + subdomain ownership | GitHub OAuth login |
| API user | Full REST API | GitHub OAuth + owner approval |

---

## Free infrastructure stack

| Component | Service | Cost |
|---|---|---|
| Tunnel transport | Cloudflare Tunnel | Free |
| REST API | Cloudflare Workers | Free (100k req/day) |
| Registry storage | GitHub Gist (TOON format) | Free |
| Landing page + binaries | GitHub Pages | Free |
| Binary builds | GitHub Actions | Free |
| DNS + wildcard TLS | Cloudflare Free Plan | Free |

---

## One-time owner setup

> Replace `hackersfun369` everywhere with your actual GitHub username.

### 1. Create the GitHub repo
```
Repo name: hackersfun369.github.io
Visibility: Public
```

Enable GitHub Pages:
- Settings → Pages → Source: Deploy from branch → Branch: `main` → Folder: `/docs`

### 2. Create a GitHub Personal Access Token
```
github.com → Settings → Developer settings → Personal access tokens → Fine-grained
Scopes: Gists (read + write)
```
Save this — it's your `GITHUB_TOKEN`.

### 3. Create a GitHub OAuth App
```
github.com → Settings → Developer settings → OAuth Apps → New OAuth App

Application name:     Vortex
Homepage URL:         https://hackersfun369.github.io
Authorization callback URL: https://hackersfun369.github.io/auth/callback
```
Save the `Client ID` and `Client Secret`.

### 4. Set up Cloudflare

1. Sign up at cloudflare.com (free)
2. Add site: `hackersfun369.github.io`
3. Update nameservers at GitHub:
   - Your repo → Settings → Pages → Custom domain → enter `hackersfun369.github.io`
   - Follow Cloudflare's nameserver instructions
4. In Cloudflare DNS, add wildcard record:
   ```
   Type: CNAME
   Name: *
   Target: hackersfun369.github.io
   Proxy: ✓ (orange cloud)
   ```

### 5. Deploy the Cloudflare Worker

```sh
cd worker
npm install
npx wrangler login

# Create and deploy
npx wrangler deploy

# Set secrets (one by one — you'll be prompted for each value)
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put GITHUB_OAUTH_CLIENT_ID
npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET        # any random 32+ char string
npx wrangler secret put OWNER_TOKEN          # your master admin token
npx wrangler secret put LIVE_BOARD_PASSWORD  # password for /live board
```

### 6. Replace the placeholder

Find and replace `hackersfun369` in every file with your real GitHub username:

```sh
# Linux / macOS
grep -rl 'hackersfun369' . | xargs sed -i 's/hackersfun369/yourusername/g'
```

### 7. Push and release

```sh
git add .
git commit -m "init vortex"
git push origin main

# Create first release to trigger binary builds
git tag v1.0.0
git push origin v1.0.0
```

---

## Data formats

| Component | Format |
|---|---|
| API request / response | JSON |
| Gist tunnel storage | TOON |
| CLI config (`~/.vortex/config.toon`) | TOON |
| Worker config (`wrangler.toml`) | TOML |

TOON (Token-Oriented Object Notation) is used for storage and config — compact, human-readable, minimal punctuation.

---

## Project structure

```
vortex/
├── cmd/vortex/
│   └── main.go                  # CLI binary (Go)
├── worker/
│   ├── src/
│   │   ├── index.js             # main router
│   │   ├── tunnel.js            # tunnel CRUD
│   │   ├── auth.js              # GitHub OAuth + API keys
│   │   ├── gist.js              # GitHub Gist storage (TOON)
│   │   ├── ratelimit.js         # IP rate limiting
│   │   └── utils.js             # shared helpers
│   ├── wrangler.toml
│   └── package.json
├── scripts/
│   └── install.sh               # curl | sh installer
├── docs/                        # GitHub Pages
│   ├── index.html               # landing page
│   ├── portal.html              # no-install tunnel creator
│   ├── dashboard.html           # user dashboard
│   ├── live.html                # password-protected live board
│   ├── expired.html             # expired tunnel page
│   ├── css/style.css
│   └── js/                      # (reserved for future widgets)
├── .github/workflows/
│   ├── release.yml              # build + publish binaries
│   └── pages.yml                # deploy GitHub Pages
├── go.mod
└── README.md
```

---

## License

MIT — free to use, fork, and self-host.
