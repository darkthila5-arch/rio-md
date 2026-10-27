//go:build !dial

package main

import (
	"errors"

	"github.com/purpshell/meowcaller"
)

var errDialUnsupported = errors.New("outgoing calls are not compiled into this build of the call service (build with -tags dial, see README)")

func (s *session) startOutgoing(phone string, video bool) (*meowcaller.Call, error) {
	return nil, errDialUnsupported
}
