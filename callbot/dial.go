//go:build dial

package main

import (
	"context"
	"errors"

	"github.com/purpshell/meowcaller"
)

var errDialUnsupported = errors.New("outgoing calls are not supported by this build")

// startOutgoing places a call with meowcaller's Client.Call(ctx, target).
// The video part is added by play() (call.StartVideo) once the other side has answered.
func (s *session) startOutgoing(phone string, video bool) (*meowcaller.Call, error) {
	// context.Background(): the call must not end when this function returns.
	return s.mc.Call(context.Background(), phone+"@s.whatsapp.net")
}
