package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

const (
	videoFPS      = 15
	maxClipSecs   = 180
	ffmpegTimeout = 3 * time.Minute
)

// runFFmpeg runs ffmpeg with the given args and returns stderr on failure.
func runFFmpeg(args ...string) error {
	bin, err := lookPath("ffmpeg")
	if err != nil {
		return errors.New("ffmpeg is not installed on this server")
	}
	ctx, cancel := context.WithTimeout(context.Background(), ffmpegTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, append([]string{"-hide_banner", "-loglevel", "error", "-y"}, args...)...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := stderr.String()
		if len(msg) > 400 {
			msg = msg[:400]
		}
		return fmt.Errorf("ffmpeg failed: %v: %s", err, msg)
	}
	return nil
}

// convertAudio turns any audio/video file into 16 kHz mono 16-bit WAV (what meowcaller plays).
func convertAudio(in, out string) error {
	return runFFmpeg("-i", in, "-vn", "-t", fmt.Sprint(maxClipSecs), "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", out)
}

// convertVideo turns any video into raw H.264 Annex B (baseline, 15 fps, keyframe every second,
// SPS/PPS repeated on every keyframe and an access-unit delimiter in front of every frame).
func convertVideo(in, out string) error {
	return runFFmpeg("-i", in, "-an", "-t", fmt.Sprint(maxClipSecs),
		"-vf", fmt.Sprintf("scale=480:-2,fps=%d", videoFPS),
		"-c:v", "libx264", "-profile:v", "baseline", "-level", "3.0", "-pix_fmt", "yuv420p",
		"-preset", "veryfast", "-tune", "zerolatency", "-g", fmt.Sprint(videoFPS), "-keyint_min", fmt.Sprint(videoFPS), "-bf", "0",
		"-x264-params", "aud=1:repeat-headers=1:annexb=1",
		"-f", "h264", out)
}

// saveMedia converts an uploaded clip and stores the playable files under dir.
// kind "audio" -> audio.wav ; kind "video" -> video.h264 (+ video.wav with the clip's own sound, when it has any).
func saveMedia(dir, kind, uploaded string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	switch kind {
	case "audio":
		return atomicConvert(filepath.Join(dir, "audio.wav"), func(tmp string) error { return convertAudio(uploaded, tmp) })
	case "video":
		if err := atomicConvert(filepath.Join(dir, "video.h264"), func(tmp string) error { return convertVideo(uploaded, tmp) }); err != nil {
			return err
		}
		wav := filepath.Join(dir, "video.wav")
		if err := atomicConvert(wav, func(tmp string) error { return convertAudio(uploaded, tmp) }); err != nil {
			_ = os.Remove(wav) // the clip simply has no sound track
		}
		return nil
	}
	return fmt.Errorf("unknown media kind %q", kind)
}

func atomicConvert(final string, fn func(tmp string) error) error {
	tmp := final + ".tmp"
	_ = os.Remove(tmp)
	if err := fn(tmp); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, final)
}

func removeMedia(dir, kind string) {
	switch kind {
	case "audio":
		_ = os.Remove(filepath.Join(dir, "audio.wav"))
	case "video":
		_ = os.Remove(filepath.Join(dir, "video.h264"))
		_ = os.Remove(filepath.Join(dir, "video.wav"))
	}
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// wavDuration estimates the length of a 16 kHz mono 16-bit WAV file.
func wavDuration(path string) time.Duration {
	st, err := os.Stat(path)
	if err != nil || st.Size() <= 44 {
		return 0
	}
	return time.Duration(float64(st.Size()-44) / (16000 * 2) * float64(time.Second))
}

// splitAccessUnits cuts an Annex B stream into access units. Every unit starts at an
// access-unit delimiter (NAL type 9), which convertVideo asks x264 to emit before each frame.
func splitAccessUnits(data []byte) [][]byte {
	type nal struct{ start, typ int }
	var nals []nal
	for i := 0; i+3 < len(data); i++ {
		if data[i] == 0 && data[i+1] == 0 && data[i+2] == 1 {
			start := i
			if i > 0 && data[i-1] == 0 { // 4-byte start code
				start = i - 1
			}
			nals = append(nals, nal{start: start, typ: int(data[i+3] & 0x1f)})
			i += 2
		}
	}
	var units [][]byte
	begin := -1
	for _, n := range nals {
		if n.typ == 9 {
			if begin >= 0 {
				units = append(units, data[begin:n.start])
			}
			begin = n.start
		}
	}
	if begin >= 0 {
		units = append(units, data[begin:])
	}
	return units
}

// lookPath is a variable so it is easy to stub in tests.
var lookPath = exec.LookPath
