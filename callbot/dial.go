//go:build dial

package main

import (
	"errors"

	"github.com/polymorfa/hypermeow/types"
	"github.com/purpshell/meowcaller"
)

var errDialUnsupported = errors.New("outgoing calls are not supported by this build")

// startOutgoing places a call. The meowcaller call below is the ONE line to check against the
// meowcaller version you build with (the name / signature of the "start a call" function).
func (s *session) startOutgoing(phone string, video bool) (*meowcaller.Call, error) {
	peer := types.NewJID(phone, types.DefaultUserServer)
	return s.mc.StartCall(peer, video) // <-- adjust if meowcaller names it differently
}
