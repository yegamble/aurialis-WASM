"use client";

import { clampAdvancedToSampleRate, createDefaultAdvancedParams } from "@/lib/audio-dsp";
import { useStore } from "@/lib/store";
import type { EQBandParams, EQFilterType, Track } from "@/lib/types";
import { Icon } from "./Icon";
import { ControlGroup, SliderField } from "./Primitives";

const filterTypes: { value: EQFilterType; label: string }[] = [
  { value: "highpass", label: "High-pass" },
  { value: "lowshelf", label: "Low shelf" },
  { value: "peaking", label: "Bell" },
  { value: "highshelf", label: "High shelf" },
];

export function EQBandControls({ track, band }: { track: Track; band: EQBandParams }) {
  const { dispatch } = useStore();
  const defaults = clampAdvancedToSampleRate(createDefaultAdvancedParams(), track.sampleRate);
  const defaultBand = defaults.eqBands.find((item) => item.id === band.id) ?? defaults.eqBands[1];
  const update = (patch: Partial<Omit<EQBandParams, "id" | "label">>) => {
    dispatch({ type: "UPDATE_EQ_BAND", trackId: track.id, bandId: band.id, patch });
  };
  const highPass = band.type === "highpass";
  return <>
    <label className="check-row">
      <input type="checkbox" checked={band.enabled} onChange={(event) => { update({ enabled: event.target.checked }); }} />
      <span><Icon name="check" /></span>Enable {band.label} band
    </label>
    <ControlGroup label={`${band.label} filter type`}>
      <div className="select-wrap">
        <select aria-label={`${band.label} filter type`} value={band.type} onChange={(event) => {
          const type = filterTypes.find((item) => item.value === event.target.value)?.value;
          if (type) update({ type });
        }}>
          {filterTypes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
        <Icon name="chevron-down" />
      </div>
    </ControlGroup>
    <fieldset disabled={highPass} className="min-w-0 border-0 p-0 disabled:opacity-60">
      <SliderField label={`${band.label} gain`} value={band.gainDb} defaultValue={defaultBand.gainDb} min={-12} max={12} step={0.5} unit="dB" onChange={(gainDb) => { update({ gainDb }); }} />
    </fieldset>
    {highPass && <p className="text-xs text-[var(--ink-soft)]">High-pass uses frequency and Q. Gain is retained for the other filter types.</p>}
    <SliderField label={`${band.label} frequency`} value={Math.min(band.freqHz, Math.floor(track.sampleRate * 0.47))} defaultValue={defaultBand.freqHz} min={20} max={Math.min(18000, Math.floor(track.sampleRate * 0.47))} step={1} unit="Hz" onChange={(freqHz) => { update({ freqHz }); }} />
    <SliderField label={`${band.label} Q`} value={band.q} defaultValue={defaultBand.q} min={0.3} max={8} step={0.001} onChange={(q) => { update({ q }); }} />
  </>;
}

export function LimiterReleaseControl({ track }: { track: Track }) {
  const { dispatch } = useStore();
  return <SliderField label="Limiter release" value={track.advanced.limiter.release} defaultValue={createDefaultAdvancedParams().limiter.release} min={10} max={1000} step={5} unit="ms" onChange={(release) => {
    dispatch({ type: "UPDATE_LIMITER", trackId: track.id, patch: { release } });
  }} />;
}
