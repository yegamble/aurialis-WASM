package dsp

import (
	"errors"
	"math"
)

type studioStereoPath struct {
	params            StereoParams
	bank              studioLR4Bank
	midGain, sideGain float64
}

func (s *studioStereoPath) process(left, right float64) (float64, float64) {
	if !s.params.Enabled {
		return left, right
	}
	mid, lowSide, highSide := s.bank.process(.5*(left+right), .5*(left-right))
	mid *= s.midGain
	side := highSide
	if !s.params.MonoBass {
		side += lowSide
	}
	side *= s.sideGain * s.params.WidthPct / 100
	return sanitizeSample(mid + side), sanitizeSample(mid - side)
}

// Each transition runs complete old/new stereo paths. A single prepared pending
// edit coalesces rapid control input; no coefficient preparation occurs in process.
// The module adds no buffered delay. The eventual graph owns its fixed latency.
type studioStereo struct {
	rate                  float64
	params                StereoParams
	active, next, pending studioStereoPath
	frame, length         int
	hasPending            bool
}

func prepareStudioStereoPath(rate float64, params StereoParams) (studioStereoPath, error) {
	if !finite(rate) || rate < 8000 || rate > 192000 {
		return studioStereoPath{}, errors.New("invalid studio stereo sample rate")
	}
	base := DefaultParams()
	base.Stereo = params
	if err := ValidateParams(base); err != nil {
		return studioStereoPath{}, err
	}
	return studioStereoPath{params: params, bank: prepareStudioLR4(rate, params.CrossoverHz), midGain: dbToLin(params.MidGainDB), sideGain: dbToLin(params.SideGainDB)}, nil
}

func prepareStudioStereo(rate float64, params StereoParams) (studioStereo, error) {
	path, err := prepareStudioStereoPath(rate, params)
	if err != nil {
		return studioStereo{}, err
	}
	return studioStereo{rate: rate, params: params, active: path}, nil
}

func (s *studioStereo) beginTransition(path studioStereoPath) {
	if s.active.params == path.params {
		return
	}
	if !s.active.params.Enabled && !path.params.Enabled {
		s.active = path
		return
	}
	if s.active.params.Enabled && path.params.Enabled {
		// TPT integrator history remains bounded and current at coefficient
		// changes; old/new banks then evolve independently through the fade.
		coeffs := path.bank.coeffs
		path.bank = s.active.bank
		path.bank.coeffs = coeffs
	}
	s.next = path
	s.frame, s.length = 0, int(math.Ceil(.02*s.rate))
}

func (s *studioStereo) setParams(params StereoParams) error {
	if params == s.params {
		return nil
	}
	path, err := prepareStudioStereoPath(s.rate, params)
	if err != nil {
		return err
	}
	s.params = params
	if s.length > 0 {
		s.pending, s.hasPending = path, true
	} else {
		s.beginTransition(path)
	}
	return nil
}

func (s *studioStereo) resetHistory() {
	path := s.active
	if s.length > 0 {
		path = s.next
	}
	if s.hasPending {
		path = s.pending
	}
	path.bank = studioLR4Bank{coeffs: path.bank.coeffs}
	s.active = path
	s.next, s.pending = studioStereoPath{}, studioStereoPath{}
	s.frame, s.length, s.hasPending = 0, 0, false
}

func (s *studioStereo) process(left, right float64) (float64, float64) {
	if !finite(left) {
		left = 0
	}
	if !finite(right) {
		right = 0
	}
	oldLeft, oldRight := s.active.process(left, right)
	if s.length == 0 {
		return oldLeft, oldRight
	}
	newLeft, newRight := s.next.process(left, right)
	s.frame++
	weight := float64(s.frame) / float64(s.length)
	outLeft, outRight := oldLeft+weight*(newLeft-oldLeft), oldRight+weight*(newRight-oldRight)
	if s.frame >= s.length {
		s.active, s.next = s.next, studioStereoPath{}
		s.frame, s.length = 0, 0
		if s.hasPending {
			pending := s.pending
			s.pending, s.hasPending = studioStereoPath{}, false
			s.beginTransition(pending)
		}
		return newLeft, newRight
	}
	return sanitizeSample(outLeft), sanitizeSample(outRight)
}
