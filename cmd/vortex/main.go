package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	version    = "1.0.0"
	baseDomain = "hackersfun369.github.io"
	apiBase    = "https://hackersfun369.github.io"
	configDir  = ".vortex"
	configFile = "config.toon"
)

func main() {
	if len(os.Args) < 2 {
		printHelp()
		os.Exit(1)
	}
	switch os.Args[1] {
	case "--help", "-h", "help":
		printHelp()
	case "--version", "-v", "version":
		fmt.Printf("vortex v%s (%s/%s)\n", version, runtime.GOOS, runtime.GOARCH)
	case "uninstall":
		runUninstall()
	default:
		runTunnel(parseArgs())
	}
}

// ── Config (TOON format on disk) ──────────────────────────────────────────

type Config struct {
	APIKey string
	Token  string
}

func loadConfig() Config {
	home, _ := os.UserHomeDir()
	path := filepath.Join(home, configDir, configFile)
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}
	}
	cfg := Config{}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "api_key:") {
			cfg.APIKey = strings.TrimSpace(strings.TrimPrefix(line, "api_key:"))
		}
		if strings.HasPrefix(line, "token:") {
			cfg.Token = strings.TrimSpace(strings.TrimPrefix(line, "token:"))
		}
	}
	return cfg
}

func saveConfig(cfg Config) {
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, configDir)
	os.MkdirAll(dir, 0700)
	content := fmt.Sprintf("# Vortex config\napi_key: %s\ntoken: %s\n", cfg.APIKey, cfg.Token)
	os.WriteFile(filepath.Join(dir, configFile), []byte(content), 0600)
}

// ── Args ──────────────────────────────────────────────────────────────────

type Args struct {
	Port      int
	Subdomain string
	Privacy   bool
	Reserve   bool
	Token     string
	APIKey    string
}

func parseArgs() Args {
	a   := Args{}
	cfg := loadConfig()
	a.APIKey = cfg.APIKey
	a.Token  = cfg.Token

	args := os.Args[1:]
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "-s", "--subdomain":
			if i+1 < len(args) { i++; a.Subdomain = args[i] }
		case "-t", "--token":
			if i+1 < len(args) { i++; a.Token = args[i] }
		case "-k", "--api-key":
			if i+1 < len(args) { i++; a.APIKey = args[i] }
		case "-p", "--privacy":
			a.Privacy = true
		case "-r", "--reserve":
			a.Reserve = true
		default:
			if n, err := strconv.Atoi(args[i]); err == nil && a.Port == 0 {
				a.Port = n
			}
		}
	}

	if os.Getenv("VORTEX_PRIVACY") == "1"  { a.Privacy = true }
	if k := os.Getenv("VORTEX_API_KEY"); k != "" && a.APIKey == "" { a.APIKey = k }
	if t := os.Getenv("VORTEX_TOKEN");   t != "" && a.Token == ""  { a.Token  = t }

	return a
}

// ── API types ─────────────────────────────────────────────────────────────

type CreateReq struct {
	Subdomain string `json:"subdomain,omitempty"`
	Port      int    `json:"port,omitempty"`
	Privacy   bool   `json:"privacy"`
	Reserve   bool   `json:"reserve,omitempty"`
}

type CreateRes struct {
	OK              bool   `json:"ok"`
	Subdomain       string `json:"subdomain"`
	URL             string `json:"url"`
	Token           string `json:"token"`
	Reserved        bool   `json:"reserved"`
	Private         bool   `json:"private"`
	CreatedAt       string `json:"created_at"`
	CloudflaredCmd  string `json:"cloudflared_cmd"`
	InstallCmd      string `json:"install_cmd"`
}

type ErrorRes struct {
	Error string `json:"error"`
}

// ── Register tunnel ───────────────────────────────────────────────────────

func registerTunnel(a Args) (*CreateRes, error) {
	body, _ := json.Marshal(CreateReq{
		Subdomain: a.Subdomain,
		Port:      a.Port,
		Privacy:   a.Privacy,
		Reserve:   a.Reserve,
	})

	req, _ := http.NewRequest("POST", apiBase+"/tunnel/create", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	if a.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+a.APIKey)
	} else if a.Token != "" {
		req.Header.Set("Authorization", "Bearer "+a.Token)
	}
	if a.Privacy {
		req.Header.Set("X-Vortex-Privacy", "1")
	}

	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("API unreachable: %w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)

	switch resp.StatusCode {
	case 201:
		var r CreateRes
		if err := json.Unmarshal(data, &r); err != nil {
			return nil, fmt.Errorf("invalid response: %w", err)
		}
		return &r, nil
	case 401:
		return nil, fmt.Errorf("authentication required — use -k <api-key>")
	case 403:
		return nil, fmt.Errorf("API access not approved — apply at https://%s/dashboard", baseDomain)
	case 409:
		var e map[string]interface{}
		json.Unmarshal(data, &e)
		return nil, fmt.Errorf("subdomain taken: %v", e["error"])
	case 429:
		var e map[string]interface{}
		json.Unmarshal(data, &e)
		return nil, fmt.Errorf("rate limit: %v (retry after %v seconds)", e["error"], e["retry_after"])
	default:
		var e ErrorRes
		json.Unmarshal(data, &e)
		return nil, fmt.Errorf("API error %d: %s", resp.StatusCode, e.Error)
	}
}

// ── Heartbeat ─────────────────────────────────────────────────────────────

func sendHeartbeat(subdomain, token string) {
	req, _ := http.NewRequest("POST",
		fmt.Sprintf("%s/tunnel/heartbeat/%s", apiBase, subdomain), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	(&http.Client{Timeout: 10 * time.Second}).Do(req)
}

func startHeartbeat(subdomain, token string, stop <-chan struct{}) {
	ticker := time.NewTicker(60 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			sendHeartbeat(subdomain, token)
		}
	}
}

// ── Deregister ────────────────────────────────────────────────────────────

func deregister(subdomain, token string) {
	req, _ := http.NewRequest("DELETE",
		fmt.Sprintf("%s/tunnel/%s", apiBase, subdomain), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	(&http.Client{Timeout: 5 * time.Second}).Do(req)
}

// ── Main tunnel runner ────────────────────────────────────────────────────

func runTunnel(a Args) {
	if a.Port == 0 {
		fmt.Fprintln(os.Stderr, "error: port required. usage: vortex <port> [flags]")
		os.Exit(1)
	}
	if _, err := exec.LookPath("cloudflared"); err != nil {
		fmt.Fprintf(os.Stderr, "cloudflared not found. install:\n  curl -fsSL https://%s/install.sh | sh\n", baseDomain)
		os.Exit(1)
	}

	printBanner()

	privLabel := "tracked  (registered in public board)"
	if a.Privacy { privLabel = "private  (no logs, no registry)" }

	printLine()
	fmt.Printf("  %-20s registering...\n", "Subdomain")
	fmt.Printf("  %-20s %s\n", "Privacy", privLabel)
	printLine()

	reg, err := registerTunnel(a)
	if err != nil {
		fmt.Fprintf(os.Stderr, "\n  error: %v\n", err)
		os.Exit(1)
	}

	// Save token to config for reuse
	if reg.Reserved {
		cfg := loadConfig()
		cfg.Token = reg.Token
		saveConfig(cfg)
	}

	// Launch cloudflared
	cmd := exec.Command("cloudflared",
		"tunnel", "--url", fmt.Sprintf("http://localhost:%d", a.Port),
		"--hostname", reg.Subdomain+"."+baseDomain,
		"--no-autoupdate",
	)
	cmd.Env = append(os.Environ(), "NO_COLOR=1")
	stderr, _ := cmd.StderrPipe()

	if err := cmd.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "failed to start cloudflared: %v\n", err)
		deregister(reg.Subdomain, reg.Token)
		os.Exit(1)
	}

	// Signals
	sigs := make(chan os.Signal, 1)
	stop := make(chan struct{})
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-sigs
		fmt.Println("\n\n  Shutting down vortex...")
		close(stop)
		deregister(reg.Subdomain, reg.Token)
		cmd.Process.Kill()
		os.Exit(0)
	}()

	// Heartbeat
	go startHeartbeat(reg.Subdomain, reg.Token, stop)

	// Print final status
	fmt.Printf("\033[4A\033[J") // clear last 4 lines
	printLine()
	fmt.Printf("  %-20s \033[32m●\033[0m online\n", "Status")
	fmt.Printf("  %-20s \033[1m%s\033[0m\n", "URL", reg.URL)
	fmt.Printf("  %-20s http://localhost:%d\n", "Forwarding", a.Port)
	fmt.Printf("  %-20s %s\n", "Privacy", privLabel)
	if reg.Reserved {
		fmt.Printf("  %-20s permanent (reserved)\n", "Subdomain")
		fmt.Printf("  %-20s %s\n", "Token saved", "~/.vortex/config.toon")
	}
	printLine()
	fmt.Printf("\n  %-12s %-8s %-32s %-8s %s\n", "Time", "Method", "Path", "Status", "Duration")
	printLine()

	// Stream cloudflared request logs
	go streamLogs(stderr)
	cmd.Wait()
	close(stop)
	deregister(reg.Subdomain, reg.Token)
}

// ── Log streaming ─────────────────────────────────────────────────────────

var logRe = regexp.MustCompile(
	`(\d{2}:\d{2}:\d{2}).*method=(\w+).*path=([^\s]+).*status=(\d+).*duration=([\d.]+\w+)`,
)

func streamLogs(r io.Reader) {
	buf := make([]byte, 8192)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			if m := logRe.FindStringSubmatch(string(buf[:n])); len(m) == 6 {
				path := m[3]
				if len(path) > 30 { path = path[:27] + "..." }
				color := "\033[32m"
				if s, _ := strconv.Atoi(m[4]); s >= 400 && s < 500 {
					color = "\033[33m"
				} else if s >= 500 {
					color = "\033[31m"
				}
				fmt.Printf("  %-12s %-8s %-32s %s%-8s\033[0m %s\n",
					m[1], m[2], path, color, m[4], m[5])
			}
		}
		if err != nil { break }
	}
}

// ── Uninstall ─────────────────────────────────────────────────────────────

func runUninstall() {
	for _, b := range []string{"/usr/local/bin/vortex", "/usr/local/bin/cloudflared"} {
		if err := os.Remove(b); err == nil {
			fmt.Printf("  removed %s\n", b)
		}
	}
	home, _ := os.UserHomeDir()
	os.RemoveAll(filepath.Join(home, configDir))
	fmt.Println("  vortex uninstalled.")
}

// ── UI helpers ────────────────────────────────────────────────────────────

func printBanner() {
	fmt.Println(`
 ██╗   ██╗ ██████╗ ██████╗ ████████╗███████╗██╗  ██╗
 ██║   ██║██╔═══██╗██╔══██╗╚══██╔══╝██╔════╝╚██╗██╔╝
 ╚██╗ ██╔╝██║   ██║██████╔╝   ██║   █████╗   ╚███╔╝
  ╚████╔╝ ╚██████╔╝██║  ██║   ██║   ███████╗██╔╝ ██╗
   ╚═══╝   ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝`)
	fmt.Printf("\n  vortex v%s\n\n", version)
}

func printLine() { fmt.Println("  " + strings.Repeat("─", 62)) }

func printHelp() {
	fmt.Printf("vortex v%s — instant secure tunnels\n\n", version)
	fmt.Println("usage:")
	fmt.Println("  vortex <port> [flags]")
	fmt.Println()
	fmt.Println("examples:")
	fmt.Println("  vortex 3000                        random subdomain, tracked")
	fmt.Println("  vortex 3000 -s myapp               custom subdomain")
	fmt.Println("  vortex 3000 -s myapp --privacy     private, no registry")
	fmt.Println("  vortex 3000 -s myapp --reserve     permanent reservation (API key required)")
	fmt.Println("  vortex 3000 -s myapp -t <token>    reclaim your subdomain")
	fmt.Println()
	fmt.Println("flags:")
	fmt.Println("  -s, --subdomain <name>   preferred subdomain")
	fmt.Println("  -p, --privacy            private mode — no logs, no registry")
	fmt.Println("  -r, --reserve            reserve subdomain permanently")
	fmt.Println("  -t, --token <token>      your subdomain token")
	fmt.Println("  -k, --api-key <key>      your vortex API key")
	fmt.Println("      --version            print version")
	fmt.Println("      --help               show this help")
	fmt.Println()
	fmt.Println("environment:")
	fmt.Println("  VORTEX_PRIVACY=1         same as --privacy")
	fmt.Println("  VORTEX_TOKEN=<token>     same as -t")
	fmt.Println("  VORTEX_API_KEY=<key>     same as -k")
	fmt.Println()
	fmt.Printf("  portal:    https://%s/portal\n", baseDomain)
	fmt.Printf("  dashboard: https://%s/dashboard\n", baseDomain)
	fmt.Printf("  docs:      https://%s/docs\n", baseDomain)
}

// suppress unused import warning
var _ = sha256.New
