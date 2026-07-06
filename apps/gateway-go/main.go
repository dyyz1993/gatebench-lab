package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"sync"
	"time"
)

var (
	upstreamBaseURL string
	gatewayMode     string
	hashCache       sync.Map
	sharedReverseProxy *httputil.ReverseProxy // shared, connection-pooled proxy
)

func main() {
	upstreamBaseURL = os.Getenv("UPSTREAM_BASE_URL")
	if upstreamBaseURL == "" {
		upstreamBaseURL = "http://localhost:9000"
	}

	gatewayMode = os.Getenv("GATEWAY_MODE")
	if gatewayMode == "" {
		gatewayMode = "buffered"
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	// Create a shared, optimized HTTP transport
	transport := &http.Transport{
		MaxIdleConns:        1000,
		MaxIdleConnsPerHost: 100,
		IdleConnTimeout:     90 * time.Second,
		DisableCompression:  true,
		DisableKeepAlives:   false,
	}

	// Create shared reverse proxy
	upstreamURL, _ := url.Parse(upstreamBaseURL)
	sharedReverseProxy = &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(upstreamURL)
			r.Out.Host = upstreamURL.Host
			// Preserve original path and query
			r.Out.URL.Path = r.In.URL.Path
			r.Out.URL.RawQuery = r.In.URL.RawQuery
		},
		Transport: transport,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			http.Error(w, "proxy error", http.StatusBadGateway)
		},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", healthHandler)
	mux.HandleFunc("GET /ping", pingHandler)
	mux.HandleFunc("GET /proxy/small", proxyViaReverseProxy)
	mux.HandleFunc("POST /json/large", proxyViaReverseProxy)
	mux.HandleFunc("POST /upload/file", uploadFileHandler)
	mux.HandleFunc("POST /upload/instant/init", instantInitHandler)
	mux.HandleFunc("GET /response/text", proxyViaReverseProxy)
	mux.HandleFunc("GET /response/bin", proxyViaReverseProxy)

	log.Printf("Go gateway (optimized) on :%s (mode=%s, upstream=%s)", port, gatewayMode, upstreamBaseURL)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}

func pingHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

// proxyViaReverseProxy uses the shared, connection-pooled ReverseProxy
func proxyViaReverseProxy(w http.ResponseWriter, r *http.Request) {
	sharedReverseProxy.ServeHTTP(w, r)
}

// uploadFileHandler uses ReverseProxy with mode awareness
func uploadFileHandler(w http.ResponseWriter, r *http.Request) {
	// For streaming mode, disable request buffering
	if gatewayMode == "streaming" {
		// Create a one-off proxy with buffering off for uploads
		upstreamURL, _ := url.Parse(upstreamBaseURL)
		streamProxy := &httputil.ReverseProxy{
			Rewrite: func(r *httputil.ProxyRequest) {
				r.SetURL(upstreamURL)
				r.Out.Host = upstreamURL.Host
				r.Out.URL.Path = "/upload"
			},
			Transport: sharedReverseProxy.Transport, // reuse transport
		}
		streamProxy.ServeHTTP(w, r)
		return
	}
	// Buffered mode: use standard reverse proxy
	sharedReverseProxy.ServeHTTP(w, r)
}

// instantInitHandler has custom logic (hash cache)
func instantInitHandler(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Hash string `json:"hash"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}
	io.Copy(io.Discard, r.Body)
	r.Body.Close()

	// Check local cache
	if _, ok := hashCache.Load(body.Hash); ok {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]bool{"instant": true})
		return
	}

	// Miss: forward to upstream
	proxyReq, _ := http.NewRequest("GET", upstreamBaseURL+"/instant/verify?hash="+body.Hash, nil)
	client := &http.Client{Transport: sharedReverseProxy.Transport}
	resp, err := client.Do(proxyReq)
	if err != nil {
		http.Error(w, `{"error":"upstream"}`, http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusOK {
		hashCache.Store(body.Hash, true)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}
