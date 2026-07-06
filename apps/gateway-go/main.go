package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"sync"
)

var (
	upstreamBaseURL string
	gatewayMode     string
	hashCache       sync.Map
)

func main() {
	// Environment variables
	upstreamBaseURL = os.Getenv("UPSTREAM_BASE_URL")
	if upstreamBaseURL == "" {
		upstreamBaseURL = "http://localhost:9000"
	}

	gatewayMode = os.Getenv("GATEWAY_MODE")
	if gatewayMode == "" {
		gatewayMode = "buffered"
	}

	mux := http.NewServeMux()

	// Health check
	mux.HandleFunc("GET /health", healthHandler)

	// Ping
	mux.HandleFunc("GET /ping", pingHandler)

	// Proxy routes
	mux.HandleFunc("GET /proxy/small", proxyHandler)
	mux.HandleFunc("POST /json/large", proxyHandler)
	mux.HandleFunc("POST /upload/file", uploadFileHandler)
	mux.HandleFunc("POST /upload/instant/init", instantInitHandler)
	mux.HandleFunc("GET /response/text", proxyHandler)
	mux.HandleFunc("GET /response/bin", proxyHandler)

	log.Printf("Gateway starting on :8080 (mode=%s, upstream=%s)", gatewayMode, upstreamBaseURL)
	if err := http.ListenAndServe(":8080", mux); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

// healthHandler returns 200 OK.
func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}

// pingHandler returns {"ok":true}.
func pingHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

// newReverseProxy creates an httputil.ReverseProxy targeting the given path on the upstream.
func newReverseProxy(path string) *httputil.ReverseProxy {
	targetURL := upstreamBaseURL + path
	u, err := url.Parse(targetURL)
	if err != nil {
		return nil
	}
	return &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = u.Scheme
			req.URL.Host = u.Host
			req.URL.Path = u.Path
			if u.RawQuery != "" {
				req.URL.RawQuery = u.RawQuery
			}
			req.Host = u.Host
		},
		ModifyResponse: func(resp *http.Response) error {
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			http.Error(w, "proxy error", http.StatusBadGateway)
		},
	}
}

// doRequest performs a manual HTTP request to the upstream using http.Client.
func doRequest(w http.ResponseWriter, r *http.Request, path string) {
	targetURL := upstreamBaseURL + path
	if r.URL.RawQuery != "" {
		targetURL += "?" + r.URL.RawQuery
	}

	proxyReq, err := http.NewRequest(r.Method, targetURL, r.Body)
	if err != nil {
		http.Error(w, "proxy error", http.StatusBadGateway)
		return
	}

	// Copy headers
	for k, v := range r.Header {
		proxyReq.Header[k] = v
	}

	client := &http.Client{}
	resp, err := client.Do(proxyReq)
	if err != nil {
		http.Error(w, "upstream error", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Copy response headers
	for k, v := range resp.Header {
		w.Header()[k] = v
	}
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

// proxyHandler is a catch-all handler for simple proxy routes.
// Routes based on request path and method, then delegates to newReverseProxy or doRequest.
func proxyHandler(w http.ResponseWriter, r *http.Request) {
	targetPath := ""
	switch {
	case r.URL.Path == "/proxy/small":
		targetPath = "/small"
	case r.URL.Path == "/json/large":
		targetPath = "/echo-json"
	case r.URL.Path == "/response/text":
		targetPath = "/text"
	case r.URL.Path == "/response/bin":
		targetPath = "/bin"
	default:
		http.Error(w, "unknown route", http.StatusNotFound)
		return
	}

	proxy := newReverseProxy(targetPath)
	if proxy != nil {
		proxy.ServeHTTP(w, r)
	} else {
		doRequest(w, r, targetPath)
	}
}

// uploadFileHandler handles POST /upload/file.
// Respects GATEWAY_MODE (buffered vs streaming) when proxying the request body.
func uploadFileHandler(w http.ResponseWriter, r *http.Request) {
	if gatewayMode == "streaming" {
		// Streaming mode: use ReverseProxy directly for zero-copy streaming
		proxy := newReverseProxy("/upload")
		if proxy != nil {
			proxy.ServeHTTP(w, r)
			return
		}
		// Fallback to manual forwarding
	}

	// Buffered mode: read the entire body into memory before forwarding
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "failed to read body", http.StatusInternalServerError)
		return
	}
	defer r.Body.Close()

	targetURL := upstreamBaseURL + "/upload"
	proxyReq, err := http.NewRequest(r.Method, targetURL, bytes.NewReader(body))
	if err != nil {
		http.Error(w, "proxy error", http.StatusBadGateway)
		return
	}

	// Copy headers
	for k, v := range r.Header {
		proxyReq.Header[k] = v
	}

	client := &http.Client{}
	resp, err := client.Do(proxyReq)
	if err != nil {
		http.Error(w, "upstream error", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Copy response headers
	for k, v := range resp.Header {
		w.Header()[k] = v
	}
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

// instantInitHandler handles POST /upload/instant/init.
// Accepts a JSON body with a file hash, checks sync.Map for duplicates, and returns result.
func instantInitHandler(w http.ResponseWriter, r *http.Request) {
	var reqBody struct {
		Hash string `json:"hash"`
	}
	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}

	// Check local cache first
	if _, ok := hashCache.Load(reqBody.Hash); ok {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]bool{"instant": true})
		return
	}

	// Cache miss: query upstream
	verifyURL := upstreamBaseURL + "/instant/verify?hash=" + url.QueryEscape(reqBody.Hash)
	resp, err := http.Get(verifyURL)
	if err != nil {
		http.Error(w, "upstream error", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusOK {
		// Upstream confirmed: cache and return upstream response
		hashCache.Store(reqBody.Hash, struct{}{})
		for k, v := range resp.Header {
			w.Header()[k] = v
		}
		w.WriteHeader(resp.StatusCode)
		io.Copy(w, resp.Body)
		return
	}

	// Upstream does not know this hash
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"instant": false,
		"known":   false,
	})
}
