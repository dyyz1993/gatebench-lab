package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// --- config ---

var port = env("PORT", "9000")

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

// --- hash store for instant upload (秒传) ---

var knownHashes sync.Map

func init() {
	// Pre-populate 1000 known hashes for the instant upload test.
	// k6 controls hit rate by choosing known vs random hashes.
	for i := 0; i < 1000; i++ {
		h := sha256.Sum256([]byte(fmt.Sprintf("known-file-%d", i)))
		knownHashes.Store(hex.EncodeToString(h[:]), true)
	}
}

// --- 1KB JSON response ---

func smallHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	// Generate ~1KB JSON payload
	data := make(map[string]interface{})
	data["message"] = strings.Repeat("hello-", 50)
	data["id"] = 42
	data["timestamp"] = time.Now().Unix()
	data["nested"] = map[string]interface{}{
		"a": strings.Repeat("x", 200),
		"b": strings.Repeat("y", 200),
		"c": strings.Repeat("z", 200),
	}
	json.NewEncoder(w).Encode(data)
}

// --- echo JSON body ---

func echoJSONHandler(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "read error", 500)
		return
	}
	defer r.Body.Close()

	w.Header().Set("Content-Type", "application/json")
	// Validate it's valid JSON
	var v interface{}
	if err := json.Unmarshal(body, &v); err != nil {
		http.Error(w, "invalid json", 400)
		return
	}
	w.Write(body)
}

// --- file upload ---

func uploadHandler(w http.ResponseWriter, r *http.Request) {
	// Support both multipart and raw body upload
	contentType := r.Header.Get("Content-Type")

	var size int64
	if strings.HasPrefix(contentType, "multipart/form-data") {
		if err := r.ParseMultipartForm(100 << 20); err != nil {
			http.Error(w, "multipart parse error: "+err.Error(), 400)
			return
		}
		for _, headers := range r.MultipartForm.File {
			for _, fh := range headers {
				f, err := fh.Open()
				if err != nil {
					continue
				}
				n, _ := io.Copy(io.Discard, f)
				size += n
				f.Close()
			}
		}
		// Also count form fields
		for k, v := range r.MultipartForm.Value {
			size += int64(len(k))
			for _, sv := range v {
				size += int64(len(sv))
			}
		}
	} else {
		n, _ := io.Copy(io.Discard, r.Body)
		size = n
		r.Body.Close()
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status": "ok",
		"size":   size,
	})
}

// Pre-generated large text payload for H6 — avoids per-request chunk+flush loop.
var textPayload []byte

func init() {
	line := []byte("the quick brown fox jumps over the lazy dog\n")
	const targetSize = 10 * 1024 * 1024
	textPayload = bytes.Repeat(line, targetSize/len(line))
}

// --- large text response ---

func textHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(textPayload)))
	w.Write(textPayload)
}

// --- binary response ---

func binHandler(w http.ResponseWriter, r *http.Request) {
	sizeStr := r.URL.Query().Get("size")
	size := 10 * 1024 * 1024 // default 10MB
	if sizeStr != "" {
		if p, err := strconv.Atoi(sizeStr); err == nil && p > 0 {
			size = p
		}
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.Itoa(size))

	// Use a pre-generated random chunk to avoid crypto overhead per chunk
	rng := rand.New(rand.NewSource(42))
	chunk := make([]byte, 64*1024)
	rng.Read(chunk)

	written := 0
	for written < size {
		n := size - written
		if n > len(chunk) {
			n = len(chunk)
		}
		w.Write(chunk[:n])
		written += n
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}
}

// --- instant upload hash verification ---

func instantVerifyHandler(w http.ResponseWriter, r *http.Request) {
	hash := r.URL.Query().Get("hash")
	if hash == "" {
		http.Error(w, "missing hash", 400)
		return
	}

	if _, ok := knownHashes.Load(hash); ok {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"known": true,
			"hash":  hash,
		})
	} else {
		http.Error(w, "hash not found", 404)
	}
}

// --- WebSocket ---

var wsUpgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

// WS echo: echo back whatever is sent
func wsEchoHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade error: %v", err)
		return
	}
	defer conn.Close()
	conn.SetPongHandler(func(string) error { return conn.WriteMessage(websocket.PongMessage, nil) })
	for {
		mt, msg, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if err := conn.WriteMessage(mt, msg); err != nil {
			break
		}
	}
}

// WS broadcast hub: maintains connections, broadcasts each message to all
var (
	mu         sync.Mutex
	hubConns   []*websocket.Conn
)

func wsBroadcastHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws broadcast upgrade error: %v", err)
		return
	}
	mu.Lock()
	hubConns = append(hubConns, conn)
	mu.Unlock()

	defer func() {
		mu.Lock()
		for i, c := range hubConns {
			if c == conn {
				hubConns = append(hubConns[:i], hubConns[i+1:]...)
				break
			}
		}
		mu.Unlock()
		conn.Close()
	}()

	for {
		mt, msg, err := conn.ReadMessage()
		if err != nil {
			break
		}
		mu.Lock()
		for _, c := range hubConns {
			c.WriteMessage(mt, msg)
		}
		mu.Unlock()
	}
}

// WS heartbeat: responds to ping with pong
func wsHeartbeatHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws heartbeat upgrade error: %v", err)
		return
	}
	defer conn.Close()
	conn.SetPingHandler(func(string) error {
		return conn.WriteMessage(websocket.PongMessage, nil)
	})
	for {
		_, _, err := conn.ReadMessage()
		if err != nil {
			break
		}
	}
}

// --- health ---

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// --- logging middleware ---

func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start))
	})
}

func main() {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", healthHandler)
	mux.HandleFunc("GET /small", smallHandler)
	mux.HandleFunc("POST /echo-json", echoJSONHandler)
	mux.HandleFunc("POST /upload", uploadHandler)
	mux.HandleFunc("GET /text", textHandler)
	mux.HandleFunc("GET /bin", binHandler)
		mux.HandleFunc("GET /instant/verify", instantVerifyHandler)
	mux.HandleFunc("GET /ws/echo", wsEchoHandler)
	mux.HandleFunc("GET /ws/broadcast", wsBroadcastHandler)
	mux.HandleFunc("GET /ws/heartbeat", wsHeartbeatHandler)

	handler := loggingMiddleware(mux)

	log.Printf("upstream-echo listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, handler))
}
