"use client";

import { createDefaultAdvancedParams, clampAdvancedToSampleRate } from "@/lib/audio-dsp";
import { applyMasteringShortcut, type MasteringShortcut } from "@/lib/mastering-shortcuts";
import { useStore } from "@/lib/store";
import type { MultibandBandParams, Track } from "@/lib/types";
import { DSPModule } from "./DSPModule";
import { Icon } from "./Icon";
import { Button, SliderField } from "./Primitives";

function ModuleToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="check-row"><input type="checkbox" checked={checked} onChange={(event) => { onChange(event.target.checked); }} /><span><Icon name="check" /></span>{label}</label>;
}

export function MasteringShortcuts({ track }: { track: Track }) {
  const { dispatch } = useStore();
  const shortcuts: { id: MasteringShortcut; label: string; detail: string }[] = [
    { id: "air", label: "Add Air", detail: "Air shelf: +1 dB at 12 kHz." },
    { id: "mud", label: "Cut Mud", detail: "Low bell: −1.5 dB at 250 Hz, Q 0.8." },
    { id: "tape", label: "Tape Warmth", detail: "Enable Tape saturation at 10% drive." },
    { id: "glue", label: "Glue Comp", detail: "Compressor: −18 dB, 2:1, 30 ms attack, automatic release, 90 Hz sidechain, 6 dB knee, zero makeup." },
  ];
  return <DSPModule title="Starting points">
    <p className="text-sm text-[var(--ink-soft)]">Apply a starting point, then refine its settings below. Reapplying a shortcut does not add more processing.</p>
    <div className="grid grid-cols-2 gap-2">{shortcuts.map((shortcut) => <Button key={shortcut.id} variant="secondary" title={shortcut.detail} onClick={() => {
      dispatch({ type: "UPDATE_TRACK", id: track.id, patch: { advanced: applyMasteringShortcut(track.advanced, shortcut.id, track.sampleRate) } });
    }}>{shortcut.label}</Button>)}</div>
    <ul className="space-y-1 text-xs text-[var(--ink-soft)]">{shortcuts.map((shortcut) => <li key={shortcut.id}><strong>{shortcut.label}:</strong> {shortcut.detail}</li>)}</ul>
  </DSPModule>;
}

export function ExtendedCompressorControls({ track }: { track: Track }) {
  const { dispatch } = useStore();
  const value = track.advanced.compressor;
  const defaults = createDefaultAdvancedParams().compressor;
  return <>
    <SliderField label="Knee" value={value.knee} defaultValue={defaults.knee} min={0} max={24} step={0.5} unit="dB" onChange={(knee) => { dispatch({ type: "UPDATE_COMPRESSOR", trackId: track.id, patch: { knee } }); }} />
    <SliderField label="Makeup gain" value={value.makeup} defaultValue={defaults.makeup} min={-24} max={36} step={0.5} unit="dB" onChange={(makeup) => { dispatch({ type: "UPDATE_COMPRESSOR", trackId: track.id, patch: { makeup } }); }} />
    <SliderField label="Sidechain HPF" value={value.sidechainHpfHz} defaultValue={defaults.sidechainHpfHz} min={0} max={1000} step={5} unit="Hz" onChange={(sidechainHpfHz) => { dispatch({ type: "UPDATE_COMPRESSOR", trackId: track.id, patch: { sidechainHpfHz } }); }} />
    <p className="text-xs text-[var(--ink-soft)]">Filters the compressor detector, leaving the audible bass intact. Set to 0 Hz to turn the filter off.</p>
    <ModuleToggle label="Auto release" checked={value.autoRelease} onChange={(autoRelease) => { dispatch({ type: "UPDATE_COMPRESSOR", trackId: track.id, patch: { autoRelease } }); }} />
    <p className="text-xs text-[var(--ink-soft)]">Automatic release adapts recovery to the signal; Manual Release is retained until automatic release is turned off.</p>
  </>;
}

export function ExtendedStereoControls({ track }: { track: Track }) {
  const { dispatch } = useStore();
  const value = track.advanced.stereo;
  const defaults = createDefaultAdvancedParams().stereo;
  return <>
    <SliderField label="Bass mono frequency" value={value.crossoverHz} defaultValue={defaults.crossoverHz} min={20} max={1000} step={5} unit="Hz" onChange={(crossoverHz) => { dispatch({ type: "UPDATE_STEREO", trackId: track.id, patch: { crossoverHz } }); }} />
    <p className="text-xs text-[var(--ink-soft)]">Bass narrowing applies only when Mono bass is enabled.</p>
    <SliderField label="Mid channel gain" value={value.midGainDb} defaultValue={defaults.midGainDb} min={-24} max={24} step={0.5} unit="dB" onChange={(midGainDb) => { dispatch({ type: "UPDATE_STEREO", trackId: track.id, patch: { midGainDb } }); }} />
    <SliderField label="Side channel gain" value={value.sideGainDb} defaultValue={defaults.sideGainDb} min={-24} max={24} step={0.5} unit="dB" onChange={(sideGainDb) => { dispatch({ type: "UPDATE_STEREO", trackId: track.id, patch: { sideGainDb } }); }} />
  </>;
}

const bandFields: { key: keyof MultibandBandParams; label: string; min: number; max: number; step: number; unit: string }[] = [
  { key: "thresholdDb", label: "threshold", min: -60, max: 0, step: 0.5, unit: "dB" },
  { key: "ratio", label: "ratio", min: 1, max: 8, step: 0.1, unit: ":1" },
  { key: "attackMs", label: "attack", min: 1, max: 200, step: 1, unit: "ms" },
  { key: "releaseMs", label: "release", min: 20, max: 2000, step: 5, unit: "ms" },
  { key: "makeupDb", label: "makeup", min: -12, max: 12, step: 0.5, unit: "dB" },
];
const bandNames = ["Low", "Mid", "High"] as const;

export function FrequencyDynamicsControls({ track }: { track: Track }) {
  const { dispatch } = useStore();
  const defaults = clampAdvancedToSampleRate(createDefaultAdvancedParams(), track.sampleRate);
  const deHarsh = track.advanced.deHarsh;
  const multiband = track.advanced.multiband;
  const frequencyMax = Math.min(12000, Math.floor(track.sampleRate * 0.47));
  return <>
    <DSPModule title="De-Harsh">
      <ModuleToggle label="Enable De-Harsh" checked={deHarsh.enabled} onChange={(enabled) => { dispatch({ type: "UPDATE_DE_HARSH", trackId: track.id, patch: { enabled } }); }} />
      <p className="text-sm text-[var(--ink-soft)]">Reduce the selected upper-frequency region only when its level exceeds the threshold.</p>
      <SliderField label="De-Harsh frequency" value={deHarsh.frequencyHz} defaultValue={defaults.deHarsh.frequencyHz} min={1000} max={frequencyMax} step={10} unit="Hz" onChange={(frequencyHz) => { dispatch({ type: "UPDATE_DE_HARSH", trackId: track.id, patch: { frequencyHz } }); }} />
      <SliderField label="De-Harsh threshold" value={deHarsh.thresholdDb} defaultValue={defaults.deHarsh.thresholdDb} min={-60} max={0} step={0.5} unit="dB" onChange={(thresholdDb) => { dispatch({ type: "UPDATE_DE_HARSH", trackId: track.id, patch: { thresholdDb } }); }} />
      <SliderField label="De-Harsh range" value={deHarsh.rangeDb} defaultValue={defaults.deHarsh.rangeDb} min={0} max={12} step={0.5} unit="dB" onChange={(rangeDb) => { dispatch({ type: "UPDATE_DE_HARSH", trackId: track.id, patch: { rangeDb } }); }} />
    </DSPModule>
    <DSPModule title="Multiband compressor">
      <ModuleToggle label="Enable multiband" checked={multiband.enabled} onChange={(enabled) => { dispatch({ type: "UPDATE_MULTIBAND", trackId: track.id, patch: { enabled } }); }} />
      <p className="text-sm text-[var(--ink-soft)]">Control low, mid and high dynamics independently. Start with gentle ratios and compare against bypass.</p>
      <SliderField label="Low / Mid crossover" value={multiband.lowMidHz} defaultValue={defaults.multiband.lowMidHz} min={40} max={1000} step={10} unit="Hz" onChange={(lowMidHz) => { dispatch({ type: "UPDATE_MULTIBAND", trackId: track.id, patch: { lowMidHz } }); }} />
      <SliderField label="Mid / High crossover" value={multiband.midHighHz} defaultValue={defaults.multiband.midHighHz} min={1500} max={frequencyMax} step={10} unit="Hz" onChange={(midHighHz) => { dispatch({ type: "UPDATE_MULTIBAND", trackId: track.id, patch: { midHighHz } }); }} />
      {([0, 1, 2] as const).map((index) => {
        // These indices and field keys are compile-time tuples, never external property names.
        // eslint-disable-next-line security/detect-object-injection
        const name = bandNames[index];
        // eslint-disable-next-line security/detect-object-injection
        const band = multiband.bands[index];
        // eslint-disable-next-line security/detect-object-injection
        const defaultBand = defaults.multiband.bands[index];
        return <fieldset key={index} className="flex min-w-0 flex-col gap-4 border-t border-[var(--line)] pt-3">
          <legend className="px-1 text-sm font-semibold">{name} band</legend>
          {bandFields.map((field) => {
            const value = band[field.key];
            const defaultValue = defaultBand[field.key];
            return <SliderField key={field.key} label={`${name} band ${field.label}`} value={value} defaultValue={defaultValue} min={field.min} max={field.max} step={field.step} unit={field.unit} onChange={(next) => { dispatch({ type: "UPDATE_MULTIBAND_BAND", trackId: track.id, index, patch: { [field.key]: next } }); }} />;
          })}
        </fieldset>;
      })}
    </DSPModule>
  </>;
}
