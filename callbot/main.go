// callbot: answers real WhatsApp calls and streams a saved audio / video clip into them.
//
// It is a small companion service for RIO X MD. The Node bot (Baileys) cannot answer calls, so this
// service links itself as a second WhatsApp "linked device" on the same number (hypermeow, a whatsmeow fork) and uses
// meowcaller for the call media. The Node bot talks to it over a localhost HTTP API.
package main

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	whatsmeow "github.com/polymorfa/hypermeow"
	"github.com/polymorfa/hypermeow/store"
	"github.com/polymorfa/hypermeow/store/sqlstore"
	"github.com/polymorfa/hypermeow/types"
	"github.com/polymorfa/hypermeow/types/events"
	waLog "github.com/polymorfa/hypermeow/util/log"
	"github.com/purpshell/meowcaller"
	_ "modernc.org/sqlite"
)

var (
	idRe    = regexp.MustCompile(`^[a-f0-9]{24}$`)
	phoneRe = regexp.MustCompile(`^[0-9]{8,15}$`)
)

type Config struct {
	Enabled bool     `json:"enabled"` // answer calls and play the clip
	Loop    bool     `json:"loop"`    // repeat the clip until the caller hangs up
	Hangup  bool     `json:"hangup"`  // hang up after the clip has finished
	Skip    []string `json:"skip"`    // numbers that are never answered (the owner)
}

type savedSession struct {
	JID string `json:"jid,omitempty"`
	Cfg Config `json:"cfg"`
}

type manager struct {
	mu        sync.Mutex
	dir       string
	container *sqlstore.Container
	sessions  map[string]*session
	saved     map[string]savedSession
}

type session struct {
	id       string
	m        *manager
	cli      *whatsmeow.Client
	mc       *meowcaller.Client
	mu       sync.Mutex
	pairCode string
	qrOnce   sync.Once
	qrCh     chan struct{}
}

/* ---------- manager ---------- */

func newManager(dir string) (*manager, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	dsn := "file:" + filepath.Join(dir, "whatsmeow.db") + "?_pragma=foreign_keys(1)&_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // sqlite: one writer at a time
	container := sqlstore.NewWithDB(db, "sqlite3", waLog.Stdout("DB", "WARN", true))
	if err := container.Upgrade(context.Background()); err != nil {
		return nil, fmt.Errorf("database upgrade: %w", err)
	}
	m := &manager{dir: dir, container: container, sessions: map[string]*session{}, saved: map[string]savedSession{}}
	if b, err := os.ReadFile(m.stateFile()); err == nil {
		if err := json.Unmarshal(b, &m.saved); err != nil {
			log.Printf("state file unreadable, starting clean: %v", err)
			m.saved = map[string]savedSession{}
		}
	}
	return m, nil
}

func (m *manager) stateFile() string         { return filepath.Join(m.dir, "state.json") }
func (m *manager) mediaDir(id string) string { return filepath.Join(m.dir, "media", id) }

func (m *manager) persistLocked() {
	b, err := json.MarshalIndent(m.saved, "", "  ")
	if err != nil {
		return
	}
	tmp := m.stateFile() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err == nil {
		_ = os.Rename(tmp, m.stateFile())
	}
}

func (m *manager) getCfg(id string) Config {
	m.mu.Lock()
	defer m.mu.Unlock()
	if sv, ok := m.saved[id]; ok {
		return sv.Cfg
	}
	return Config{Hangup: true}
}

func (m *manager) setCfg(id string, cfg Config) {
	m.mu.Lock()
	defer m.mu.Unlock()
	sv := m.saved[id]
	sv.Cfg = cfg
	m.saved[id] = sv
	m.persistLocked()
}

// restore reconnects every device that was linked before a restart.
func (m *manager) restore() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.saved))
	for id, sv := range m.saved {
		if sv.JID != "" {
			ids = append(ids, id)
		}
	}
	m.mu.Unlock()
	for _, id := range ids {
		m.mu.Lock()
		jidStr := m.saved[id].JID
		m.mu.Unlock()
		jid, err := types.ParseJID(jidStr)
		if err != nil {
			log.Printf("[%s] bad saved JID %q: %v", id, jidStr, err)
			continue
		}
		dev, err := m.container.GetDevice(context.Background(), jid)
		if err != nil || dev == nil {
			log.Printf("[%s] linked device not found in the database (%v); it needs to be linked again", id, err)
			continue
		}
		m.mu.Lock()
		s := m.newSession(id, dev)
		m.sessions[id] = s
		m.mu.Unlock()
		go func(s *session) {
			if err := s.cli.Connect(); err != nil {
				log.Printf("[%s] connect error: %v", s.id, err)
			}
		}(s)
		time.Sleep(1500 * time.Millisecond)
	}
	log.Printf("restored %d linked session(s)", len(ids))
}

// newSession builds a whatsmeow client + meowcaller client. The caller stores it in m.sessions.
func (m *manager) newSession(id string, dev *store.Device) *session {
	cli := whatsmeow.NewClient(dev, waLog.Stdout("WA-"+id[:6], "WARN", true))
	s := &session{id: id, m: m, cli: cli, qrCh: make(chan struct{})}
	s.mc = meowcaller.NewClient(cli)
	s.mc.OnIncomingCall(s.onCall)
	cli.AddEventHandler(func(evt any) {
		switch e := evt.(type) {
		case *events.QR:
			s.qrOnce.Do(func() { close(s.qrCh) })
		case *events.PairSuccess:
			log.Printf("[%s] linked as %s", id, e.ID.User)
			m.bind(id, e.ID)
			s.mu.Lock()
			s.pairCode = ""
			s.mu.Unlock()
		case *events.LoggedOut:
			log.Printf("[%s] logged out from WhatsApp, forgetting the device", id)
			m.forget(id, s)
		}
	})
	return s
}

func (m *manager) bind(id string, jid types.JID) {
	m.mu.Lock()
	defer m.mu.Unlock()
	sv := m.saved[id]
	sv.JID = jid.String()
	m.saved[id] = sv
	m.persistLocked()
}

func (m *manager) forget(id string, s *session) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sessions[id] == s {
		delete(m.sessions, id)
	}
	sv := m.saved[id]
	sv.JID = ""
	m.saved[id] = sv
	m.persistLocked()
}

// pair starts linking this service as a second device on the given phone number and returns the 8 character code.
func (m *manager) pair(id, phone string) (string, error) {
	m.mu.Lock()
	if old := m.sessions[id]; old != nil {
		if old.cli.Store.ID != nil {
			m.mu.Unlock()
			return "", errors.New("this number is already linked to the call service")
		}
		old.cli.Disconnect() // abandoned earlier attempt
		delete(m.sessions, id)
	}
	s := m.newSession(id, m.container.NewDevice())
	m.sessions[id] = s
	m.mu.Unlock()

	fail := func(err error) (string, error) {
		s.cli.Disconnect()
		m.mu.Lock()
		if m.sessions[id] == s {
			delete(m.sessions, id)
		}
		m.mu.Unlock()
		return "", err
	}
	if err := s.cli.Connect(); err != nil {
		return fail(fmt.Errorf("connect: %w", err))
	}
	select {
	case <-s.qrCh:
	case <-time.After(30 * time.Second):
		return fail(errors.New("WhatsApp did not answer in time, try again"))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	code, err := s.cli.PairPhone(ctx, phone, true, whatsmeow.PairClientChrome, "Chrome (Linux)")
	if err != nil {
		return fail(fmt.Errorf("pair code: %w", err))
	}
	s.mu.Lock()
	s.pairCode = code
	s.mu.Unlock()
	time.AfterFunc(5*time.Minute, func() { // unfinished pairing attempts expire
		if s.cli.Store.ID == nil {
			s.cli.Disconnect()
			m.mu.Lock()
			if m.sessions[id] == s {
				delete(m.sessions, id)
			}
			m.mu.Unlock()
		}
	})
	return code, nil
}

func (m *manager) remove(id string) {
	m.mu.Lock()
	s := m.sessions[id]
	delete(m.sessions, id)
	delete(m.saved, id)
	m.persistLocked()
	m.mu.Unlock()
	if s != nil {
		if s.cli.Store.ID != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			_ = s.cli.Logout(ctx)
			cancel()
		}
		s.cli.Disconnect()
	}
	_ = os.RemoveAll(m.mediaDir(id))
}

/* ---------- calls ---------- */

func (s *session) onCall(call *meowcaller.Call) {
	cfg := s.m.getCfg(s.id)
	if !cfg.Enabled {
		return // the Node bot decides what to do with the call
	}
	peer := call.Peer().User
	if s.cli.Store.ID != nil && peer == s.cli.Store.ID.User {
		return
	}
	for _, n := range cfg.Skip {
		if n != "" && n == peer {
			log.Printf("[%s] call from owner %s ignored", s.id, peer)
			return
		}
	}

	dir := s.m.mediaDir(s.id)
	audioWav, videoWav, videoRaw := filepath.Join(dir, "audio.wav"), filepath.Join(dir, "video.wav"), filepath.Join(dir, "video.h264")
	var audioPath, videoPath string
	if call.IsVideo() && fileExists(videoRaw) {
		videoPath = videoRaw
		if fileExists(videoWav) {
			audioPath = videoWav
		} else if fileExists(audioWav) {
			audioPath = audioWav
		}
	} else if fileExists(audioWav) {
		audioPath = audioWav
	} else if fileExists(videoWav) {
		audioPath = videoWav
	}
	if audioPath == "" && videoPath == "" {
		log.Printf("[%s] call from %s but no clip is saved, rejecting", s.id, peer)
		_ = call.Reject()
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	var restart int32
	var once sync.Once
	start := func() {
		once.Do(func() { go s.play(ctx, cancel, call, cfg, audioPath, videoPath, &restart) })
	}
	call.OnEnd(func(reason string) {
		log.Printf("[%s] call from %s ended (%s)", s.id, peer, reason)
		cancel()
	})
	call.OnVideoKeyframeRequest(func() { atomic.StoreInt32(&restart, 1) })
	call.OnReady(start)

	log.Printf("[%s] answering %s call from %s (audio=%v video=%v)", s.id, map[bool]string{true: "video", false: "voice"}[call.IsVideo()], peer, audioPath != "", videoPath != "")
	if err := call.Answer(); err != nil {
		log.Printf("[%s] answer failed: %v", s.id, err)
		cancel()
		return
	}
	time.AfterFunc(4*time.Second, start) // if OnReady never fires, start anyway
}

func (s *session) play(ctx context.Context, cancel context.CancelFunc, call *meowcaller.Call, cfg Config, audioPath, videoPath string, restart *int32) {
	var wg sync.WaitGroup
	if videoPath != "" {
		data, err := os.ReadFile(videoPath)
		units := splitAccessUnits(data)
		if err != nil || len(units) == 0 {
			log.Printf("[%s] video clip unreadable (%v, %d frames)", s.id, err, len(units))
		} else {
			if err := call.StartVideo(); err != nil {
				log.Printf("[%s] StartVideo: %v", s.id, err)
			}
			wg.Add(1)
			go func() {
				defer wg.Done()
				sendVideo(ctx, call, units, cfg.Loop, restart)
			}()
		}
	}
	if audioPath != "" {
		wg.Add(1)
		go func() {
			defer wg.Done()
			playAudio(ctx, call, audioPath, cfg.Loop)
		}()
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
		return
	}
	if cfg.Hangup {
		select {
		case <-time.After(1500 * time.Millisecond):
		case <-ctx.Done():
			return
		}
		if err := call.Hangup(); err != nil {
			log.Printf("[%s] hangup: %v", s.id, err)
		}
	}
	cancel()
}

func playAudio(ctx context.Context, call *meowcaller.Call, path string, loop bool) {
	for {
		src, err := meowcaller.WAVFile(path)
		if err != nil {
			log.Printf("audio clip error: %v", err)
			return
		}
		player := call.Play(src)
		finished := make(chan struct{})
		var once sync.Once
		player.OnFinish(func() { once.Do(func() { close(finished) }) })
		select {
		case <-finished:
		case <-time.After(wavDuration(path) + 4*time.Second): // safety net if OnFinish never fires
		case <-ctx.Done():
			player.Stop()
			return
		}
		if !loop {
			return
		}
	}
}

func sendVideo(ctx context.Context, call *meowcaller.Call, units [][]byte, loop bool, restart *int32) {
	frame := time.Second / videoFPS
	t := time.NewTicker(frame)
	defer t.Stop()
	i := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if atomic.CompareAndSwapInt32(restart, 1, 0) {
			i = 0 // the clip starts with a keyframe, so the peer can resync
		}
		if i >= len(units) {
			if !loop {
				return
			}
			i = 0
		}
		if err := call.SendVideoWithDuration(units[i], frame); err != nil {
			log.Printf("send video frame: %v", err)
			return
		}
		i++
	}
}

/* ---------- HTTP API (localhost only, bearer secret) ---------- */

type statusResp struct {
	Exists    bool   `json:"exists"`
	Linked    bool   `json:"linked"`
	Connected bool   `json:"connected"`
	Phone     string `json:"phone,omitempty"`
	PairCode  string `json:"pairCode,omitempty"`
	Enabled   bool   `json:"enabled"`
	HasAudio  bool   `json:"hasAudio"`
	HasVideo  bool   `json:"hasVideo"`
	FFmpeg    bool   `json:"ffmpeg"`
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func (m *manager) status(id string) statusResp {
	st := statusResp{FFmpeg: ffmpegAvailable()}
	m.mu.Lock()
	s := m.sessions[id]
	m.mu.Unlock()
	cfg := m.getCfg(id)
	st.Enabled = cfg.Enabled
	dir := m.mediaDir(id)
	st.HasAudio = fileExists(filepath.Join(dir, "audio.wav"))
	st.HasVideo = fileExists(filepath.Join(dir, "video.h264"))
	if s != nil {
		st.Exists = true
		if s.cli.Store.ID != nil {
			st.Linked = true
			st.Phone = s.cli.Store.ID.User
		}
		st.Connected = s.cli.IsConnected()
		s.mu.Lock()
		st.PairCode = s.pairCode
		s.mu.Unlock()
	}
	return st
}

func (m *manager) routes(secret string) http.Handler {
	mux := http.NewServeMux()
	validID := func(w http.ResponseWriter, r *http.Request) (string, bool) {
		id := r.PathValue("id")
		if !idRe.MatchString(id) {
			writeErr(w, http.StatusBadRequest, "invalid session id")
			return "", false
		}
		return id, true
	}

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		n := len(m.sessions)
		m.mu.Unlock()
		writeJSON(w, 200, map[string]any{"ok": true, "sessions": n, "ffmpeg": ffmpegAvailable()})
	})
	mux.HandleFunc("GET /sessions/{id}", func(w http.ResponseWriter, r *http.Request) {
		if id, ok := validID(w, r); ok {
			writeJSON(w, 200, m.status(id))
		}
	})
	mux.HandleFunc("POST /sessions/{id}/pair", func(w http.ResponseWriter, r *http.Request) {
		id, ok := validID(w, r)
		if !ok {
			return
		}
		var body struct {
			Phone string `json:"phone"`
		}
		_ = json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body)
		phone := strings.TrimLeft(strings.TrimSpace(body.Phone), "+")
		if !phoneRe.MatchString(phone) {
			writeErr(w, http.StatusBadRequest, "invalid phone number")
			return
		}
		code, err := m.pair(id, phone)
		if err != nil {
			log.Printf("[%s] pair error: %v", id, err)
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, 200, map[string]string{"code": code})
	})
	mux.HandleFunc("POST /sessions/{id}/config", func(w http.ResponseWriter, r *http.Request) {
		id, ok := validID(w, r)
		if !ok {
			return
		}
		cfg := m.getCfg(id)
		var in struct {
			Enabled *bool     `json:"enabled"`
			Loop    *bool     `json:"loop"`
			Hangup  *bool     `json:"hangup"`
			Skip    *[]string `json:"skip"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&in); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if in.Enabled != nil {
			cfg.Enabled = *in.Enabled
		}
		if in.Loop != nil {
			cfg.Loop = *in.Loop
		}
		if in.Hangup != nil {
			cfg.Hangup = *in.Hangup
		}
		if in.Skip != nil {
			cfg.Skip = *in.Skip
		}
		m.setCfg(id, cfg)
		writeJSON(w, 200, m.status(id))
	})
	mux.HandleFunc("PUT /sessions/{id}/media/{kind}", func(w http.ResponseWriter, r *http.Request) {
		id, ok := validID(w, r)
		if !ok {
			return
		}
		kind := r.PathValue("kind")
		if kind != "audio" && kind != "video" {
			writeErr(w, http.StatusBadRequest, "kind must be audio or video")
			return
		}
		tmp, err := os.CreateTemp("", "callbot-upload-*")
		if err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		defer os.Remove(tmp.Name())
		n, err := io.Copy(tmp, http.MaxBytesReader(w, r.Body, 60<<20))
		tmp.Close()
		if err != nil || n == 0 {
			writeErr(w, http.StatusBadRequest, "upload failed or empty")
			return
		}
		if err := saveMedia(m.mediaDir(id), kind, tmp.Name()); err != nil {
			log.Printf("[%s] save %s: %v", id, kind, err)
			writeErr(w, http.StatusUnprocessableEntity, err.Error())
			return
		}
		writeJSON(w, 200, m.status(id))
	})
	mux.HandleFunc("DELETE /sessions/{id}/media/{kind}", func(w http.ResponseWriter, r *http.Request) {
		id, ok := validID(w, r)
		if !ok {
			return
		}
		removeMedia(m.mediaDir(id), r.PathValue("kind"))
		writeJSON(w, 200, m.status(id))
	})
	mux.HandleFunc("DELETE /sessions/{id}", func(w http.ResponseWriter, r *http.Request) {
		if id, ok := validID(w, r); ok {
			m.remove(id)
			writeJSON(w, 200, map[string]bool{"ok": true})
		}
	})

	m.packRoutes(mux)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		given := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if subtle.ConstantTimeCompare([]byte(given), []byte(secret)) != 1 {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func ffmpegAvailable() bool {
	_, err := lookPath("ffmpeg")
	return err == nil
}

func main() {
	secret := os.Getenv("CALLBOT_SECRET")
	if len(secret) < 16 {
		log.Fatal("CALLBOT_SECRET must be set (16+ characters)")
	}
	dir := os.Getenv("CALLBOT_DIR")
	if dir == "" {
		dir = "./data"
	}
	port := os.Getenv("CALLBOT_PORT")
	if port == "" {
		port = "8099"
	}
	if !ffmpegAvailable() {
		log.Printf("WARNING: ffmpeg not found, saving audio/video clips will fail")
	}
	m, err := newManager(dir)
	if err != nil {
		log.Fatalf("start: %v", err)
	}
	go m.restore()

	srv := &http.Server{Addr: "127.0.0.1:" + port, Handler: m.routes(secret), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		log.Printf("callbot listening on %s", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("http: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Printf("shutting down")
	m.mu.Lock()
	for _, s := range m.sessions {
		s.cli.Disconnect()
	}
	m.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}
