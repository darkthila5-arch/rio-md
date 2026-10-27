package main

// Media packs + outgoing calls.
// A pack is a named audio + video set stored under <mediaDir>/packs/<name>/ (audio.wav, video.h264, video.wav).
// "dial" calls a number and streams one pack into the call once the other person picks up.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/purpshell/meowcaller"
)

var packRe = regexp.MustCompile(`^[a-z0-9_-]{1,20}$`)

const ringTimeout = 45 * time.Second // hang up if the other side does not answer

type packInfo struct {
	HasAudio bool `json:"hasAudio"`
	HasVideo bool `json:"hasVideo"`
}

func (m *manager) packDir(id, pack string) string {
	return filepath.Join(m.mediaDir(id), "packs", pack)
}

func (m *manager) listPacks(id string) map[string]packInfo {
	out := map[string]packInfo{}
	entries, err := os.ReadDir(filepath.Join(m.mediaDir(id), "packs"))
	if err != nil {
		return out
	}
	for _, e := range entries {
		if !e.IsDir() || !packRe.MatchString(e.Name()) {
			continue
		}
		d := m.packDir(id, e.Name())
		out[e.Name()] = packInfo{
			HasAudio: fileExists(filepath.Join(d, "audio.wav")),
			HasVideo: fileExists(filepath.Join(d, "video.h264")),
		}
	}
	return out
}

// dialPack calls `phone` and streams the pack into the call after it was answered.
func (s *session) dialPack(phone, pack string, video bool) error {
	dir := s.m.packDir(s.id, pack)
	audioWav, videoWav, videoRaw := filepath.Join(dir, "audio.wav"), filepath.Join(dir, "video.wav"), filepath.Join(dir, "video.h264")
	var audioPath, videoPath string
	if video && fileExists(videoRaw) {
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
		return fmt.Errorf("pack %q has nothing to play for a %s call", pack, map[bool]string{true: "video", false: "voice"}[video])
	}
	video = video && videoPath != ""

	call, err := s.startOutgoing(phone, video)
	if err != nil {
		return err
	}
	cfg := s.m.getCfg(s.id)
	cfg.Hangup = true // always hang up when the pack has finished

	ctx, cancel := context.WithCancel(context.Background())
	var restart, ready, accepted, started int32
	var once sync.Once
	start := func() {
		once.Do(func() { go s.play(ctx, cancel, call, cfg, audioPath, videoPath, &restart) })
	}
	// start when the other side picked up AND the media path is ready
	maybeStart := func() {
		if atomic.LoadInt32(&ready) == 1 && atomic.LoadInt32(&accepted) == 1 {
			atomic.StoreInt32(&started, 1)
			start()
		}
	}
	call.OnEnd(func(reason string) {
		log.Printf("[%s] outgoing call to %s ended (%s)", s.id, phone, reason)
		cancel()
	})
	call.OnVideoKeyframeRequest(func() { atomic.StoreInt32(&restart, 1) })
	call.OnPeerAccept(func() {
		atomic.StoreInt32(&accepted, 1)
		maybeStart()
	})
	call.OnReady(func() {
		atomic.StoreInt32(&ready, 1)
		maybeStart()
		// safety net: if the "peer accepted" signal never arrives, start 6 s after the media is ready
		time.AfterFunc(6*time.Second, func() {
			if atomic.LoadInt32(&started) == 0 {
				start()
			}
		})
	})
	time.AfterFunc(ringTimeout, func() {
		if atomic.LoadInt32(&ready) == 0 && atomic.LoadInt32(&accepted) == 0 {
			log.Printf("[%s] %s did not answer, hanging up", s.id, phone)
			_ = call.Hangup()
			cancel()
		}
	})
	log.Printf("[%s] calling %s with pack %q (video=%v)", s.id, phone, pack, video)
	return nil
}

func (m *manager) packRoutes(mux *http.ServeMux) {
	validID := func(w http.ResponseWriter, r *http.Request) (string, bool) {
		id := r.PathValue("id")
		if !idRe.MatchString(id) {
			writeErr(w, http.StatusBadRequest, "invalid session id")
			return "", false
		}
		return id, true
	}
	validPack := func(w http.ResponseWriter, r *http.Request) (string, bool) {
		p := r.PathValue("pack")
		if !packRe.MatchString(p) {
			writeErr(w, http.StatusBadRequest, "invalid pack name (a-z, 0-9, _ or -, max 20)")
			return "", false
		}
		return p, true
	}

	mux.HandleFunc("GET /sessions/{id}/packs", func(w http.ResponseWriter, r *http.Request) {
		if id, ok := validID(w, r); ok {
			writeJSON(w, 200, map[string]any{"packs": m.listPacks(id)})
		}
	})
	mux.HandleFunc("PUT /sessions/{id}/packs/{pack}/media/{kind}", func(w http.ResponseWriter, r *http.Request) {
		id, ok := validID(w, r)
		if !ok {
			return
		}
		pack, ok := validPack(w, r)
		if !ok {
			return
		}
		kind := r.PathValue("kind")
		if kind != "audio" && kind != "video" {
			writeErr(w, http.StatusBadRequest, "kind must be audio or video")
			return
		}
		tmp, err := os.CreateTemp("", "callbot-pack-*")
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
		if err := saveMedia(m.packDir(id, pack), kind, tmp.Name()); err != nil {
			log.Printf("[%s] save pack %s/%s: %v", id, pack, kind, err)
			writeErr(w, http.StatusUnprocessableEntity, err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"packs": m.listPacks(id)})
	})
	mux.HandleFunc("DELETE /sessions/{id}/packs/{pack}", func(w http.ResponseWriter, r *http.Request) {
		id, ok := validID(w, r)
		if !ok {
			return
		}
		pack, ok := validPack(w, r)
		if !ok {
			return
		}
		_ = os.RemoveAll(m.packDir(id, pack))
		writeJSON(w, 200, map[string]any{"packs": m.listPacks(id)})
	})
	mux.HandleFunc("POST /sessions/{id}/dial", func(w http.ResponseWriter, r *http.Request) {
		id, ok := validID(w, r)
		if !ok {
			return
		}
		var in struct {
			Phone string `json:"phone"`
			Pack  string `json:"pack"`
			Video bool   `json:"video"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&in); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		phone := strings.TrimLeft(strings.TrimSpace(in.Phone), "+")
		if !phoneRe.MatchString(phone) {
			writeErr(w, http.StatusBadRequest, "invalid phone number")
			return
		}
		if !packRe.MatchString(in.Pack) {
			writeErr(w, http.StatusBadRequest, "invalid pack name")
			return
		}
		m.mu.Lock()
		s := m.sessions[id]
		m.mu.Unlock()
		if s == nil || s.cli.Store.ID == nil || !s.cli.IsConnected() {
			writeErr(w, http.StatusConflict, "the call service is not linked / connected")
			return
		}
		if phone == s.cli.Store.ID.User {
			writeErr(w, http.StatusBadRequest, "you cannot call your own number")
			return
		}
		if err := s.dialPack(phone, in.Pack, in.Video); err != nil {
			code := http.StatusBadGateway
			if errors.Is(err, errDialUnsupported) {
				code = http.StatusNotImplemented
			}
			writeErr(w, code, err.Error())
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
}

var _ = (*meowcaller.Call)(nil) // keeps the import used by startOutgoing implementations
