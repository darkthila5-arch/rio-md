package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

const testID = "0123456789abcdef01234567"

func needFFmpeg(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
}

// makeClip builds a 3 second test video with a sine tone.
func makeClip(t *testing.T, withAudio bool) string {
	t.Helper()
	out := filepath.Join(t.TempDir(), "clip.mp4")
	args := []string{"-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=3"}
	if withAudio {
		args = append(args, "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "aac")
	}
	args = append(args, "-c:v", "libx264", "-pix_fmt", "yuv420p", out)
	if b, err := exec.Command("ffmpeg", args...).CombinedOutput(); err != nil {
		t.Fatalf("could not build the test clip: %v\n%s", err, b)
	}
	return out
}

func nalTypes(unit []byte) []int {
	var out []int
	for i := 0; i+3 < len(unit); i++ {
		if unit[i] == 0 && unit[i+1] == 0 && unit[i+2] == 1 {
			out = append(out, int(unit[i+3]&0x1f))
			i += 2
		}
	}
	return out
}

func has(list []int, v int) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func TestSplitAccessUnitsSynthetic(t *testing.T) {
	// two units: AUD+SPS+PPS+IDR (4-byte start codes) then AUD+P (3-byte start codes)
	data := []byte{0, 0, 0, 1, 0x09, 0xf0, 0, 0, 0, 1, 0x67, 1, 2, 0, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 4, 5, 0, 0, 1, 0x09, 0xf0, 0, 0, 1, 0x41, 6}
	units := splitAccessUnits(data)
	if len(units) != 2 {
		t.Fatalf("want 2 units, got %d", len(units))
	}
	if !has(nalTypes(units[0]), 5) || has(nalTypes(units[1]), 5) {
		t.Fatalf("unexpected NAL layout: %v / %v", nalTypes(units[0]), nalTypes(units[1]))
	}
	if total := len(units[0]) + len(units[1]); total != len(data) {
		t.Fatalf("units must cover the whole stream: %d vs %d", total, len(data))
	}
	if got := splitAccessUnits([]byte{1, 2, 3}); len(got) != 0 {
		t.Fatalf("garbage must give no units")
	}
}

func TestConvertVideoAndAudio(t *testing.T) {
	needFFmpeg(t)
	dir := t.TempDir()
	if err := saveMedia(dir, "video", makeClip(t, true)); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "video.h264"))
	if err != nil {
		t.Fatal(err)
	}
	units := splitAccessUnits(data)
	if len(units) < 40 || len(units) > 50 { // 3 s at 15 fps = 45 frames
		t.Fatalf("expected about 45 access units, got %d", len(units))
	}
	first := nalTypes(units[0])
	if first[0] != 9 || !has(first, 7) || !has(first, 8) || !has(first, 5) {
		t.Fatalf("first unit must be AUD+SPS+PPS+IDR, got %v", first)
	}
	if has(nalTypes(units[1]), 5) {
		t.Fatalf("second unit should be a delta frame")
	}
	if !fileExists(filepath.Join(dir, "video.wav")) {
		t.Fatal("video.wav (the clip's own sound) is missing")
	}
	if d := wavDuration(filepath.Join(dir, "video.wav")); d < 2500*time.Millisecond || d > 3500*time.Millisecond {
		t.Fatalf("wav duration looks wrong: %v", d)
	}

	if err := saveMedia(dir, "audio", makeClip(t, true)); err != nil {
		t.Fatal(err)
	}
	if !fileExists(filepath.Join(dir, "audio.wav")) {
		t.Fatal("audio.wav missing")
	}
	removeMedia(dir, "video")
	if fileExists(filepath.Join(dir, "video.h264")) || fileExists(filepath.Join(dir, "video.wav")) {
		t.Fatal("removeMedia(video) left files behind")
	}
}

func TestVideoWithoutSoundStillWorks(t *testing.T) {
	needFFmpeg(t)
	dir := t.TempDir()
	if err := saveMedia(dir, "video", makeClip(t, false)); err != nil {
		t.Fatalf("silent video must be accepted: %v", err)
	}
	if !fileExists(filepath.Join(dir, "video.h264")) || fileExists(filepath.Join(dir, "video.wav")) {
		t.Fatal("expected video.h264 only")
	}
}

func TestHTTPAPI(t *testing.T) {
	needFFmpeg(t)
	m := &manager{dir: t.TempDir(), sessions: map[string]*session{}, saved: map[string]savedSession{}}
	srv := httptest.NewServer(m.routes("test-secret-0123456789"))
	defer srv.Close()

	do := func(method, path, auth string, body []byte) (int, map[string]any) {
		req, _ := http.NewRequest(method, srv.URL+path, bytes.NewReader(body))
		if auth != "" {
			req.Header.Set("Authorization", "Bearer "+auth)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}
	const s = "test-secret-0123456789"

	if code, _ := do("GET", "/health", "", nil); code != 401 {
		t.Fatalf("missing token must be 401, got %d", code)
	}
	if code, _ := do("GET", "/health", "wrong", nil); code != 401 {
		t.Fatalf("wrong token must be 401, got %d", code)
	}
	if code, _ := do("GET", "/sessions/not-an-id", s, nil); code != 400 {
		t.Fatalf("bad id must be 400, got %d", code)
	}
	if code, out := do("GET", "/sessions/"+testID, s, nil); code != 200 || out["linked"] != false {
		t.Fatalf("fresh session: %d %v", code, out)
	}
	if code, _ := do("POST", "/sessions/"+testID+"/pair", s, []byte(`{"phone":"abc"}`)); code != 400 {
		t.Fatalf("bad phone must be 400, got %d", code)
	}

	cfg := []byte(`{"enabled":true,"loop":false,"hangup":true,"skip":["94700000000"]}`)
	if code, out := do("POST", "/sessions/"+testID+"/config", s, cfg); code != 200 || out["enabled"] != true {
		t.Fatalf("config: %d %v", code, out)
	}
	if got := m.getCfg(testID); !got.Enabled || len(got.Skip) != 1 {
		t.Fatalf("config not stored: %+v", got)
	}
	// state survives a "restart"
	m2 := &manager{dir: m.dir, sessions: map[string]*session{}, saved: map[string]savedSession{}}
	b, err := os.ReadFile(m2.stateFile())
	if err != nil || json.Unmarshal(b, &m2.saved) != nil || !m2.getCfg(testID).Enabled {
		t.Fatalf("state was not persisted: %v", err)
	}

	clip, _ := os.ReadFile(makeClip(t, true))
	if code, out := do("PUT", "/sessions/"+testID+"/media/video", s, clip); code != 200 || out["hasVideo"] != true {
		t.Fatalf("video upload: %d %v", code, out)
	}
	if code, out := do("PUT", "/sessions/"+testID+"/media/audio", s, clip); code != 200 || out["hasAudio"] != true {
		t.Fatalf("audio upload: %d %v", code, out)
	}
	if code, _ := do("PUT", "/sessions/"+testID+"/media/gif", s, clip); code != 400 {
		t.Fatalf("unknown kind must be 400, got %d", code)
	}
	if code, _ := do("PUT", "/sessions/"+testID+"/media/audio", s, []byte("this is not media")); code != 422 {
		t.Fatalf("garbage upload must be 422, got %d", code)
	}
	if code, out := do("DELETE", "/sessions/"+testID+"/media/video", s, nil); code != 200 || out["hasVideo"] != false {
		t.Fatalf("delete video: %d %v", code, out)
	}
	if code, _ := do("DELETE", "/sessions/"+testID, s, nil); code != 200 {
		t.Fatalf("delete session: %d", code)
	}
	if fileExists(filepath.Join(m.mediaDir(testID), "audio.wav")) {
		t.Fatal("session delete must remove its media")
	}
}
