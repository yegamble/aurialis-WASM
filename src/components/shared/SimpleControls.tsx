"use client";

import { useEffect, useRef, useState } from "react";
import { currentMasteringTarget, masteringTargets } from "@/lib/mastering-targets";
import { hasAppliedDeep } from "@/lib/reference-matching";
import { prepareSimpleChange, simpleGenreNames, simpleToneNames, type SimplePatch } from "@/lib/simple-directions";
import { verifyElevatedChange } from "@/lib/simple-verification";
import { useStore } from "@/lib/store";
import type { Track } from "@/lib/types";
import { Button, ChoiceGroup, ControlGroup, SliderField } from "./Primitives";
import { Icon } from "./Icon";

export function SimpleControls({
  track,
  sourceBlob,
  processing,
  sourceReady,
  onApply,
}: {
  track: Track;
  sourceBlob: Blob | null;
  processing: boolean;
  sourceReady: boolean;
  onApply: () => void;
}) {
  const { dispatch } = useStore();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [check, setCheck] = useState<{ owner: Track["advanced"]; source: Blob; lufs: number; peak: number } | null>(null);
  const operation = useRef<{ controller: AbortController; expected: Track; source: Blob } | null>(null);
  const latest = useRef({ track, sourceBlob }); latest.current = { track, sourceBlob };
  function owns(controller: AbortController) { return operation.current?.controller === controller; }
  function cancel() { operation.current?.controller.abort(); operation.current = null; setBusy(false); }
  useEffect(() => () => { operation.current?.controller.abort(); operation.current = null; }, []);
  useEffect(() => {
    if (operation.current && (operation.current.expected !== track || operation.current.source !== sourceBlob)) {
      cancel(); setError("The source or settings changed. Check Elevated again; your newer settings were preserved.");
    }
  }, [track, sourceBlob]);
  async function update(patch: SimplePatch) {
    cancel(); setError(""); setCheck(null);
    if (hasAppliedDeep(track)) { setError("Detach Deep automation before choosing a Simple direction."); return; }
    const change = prepareSimpleChange(track, patch);
    if (change.simpleDirection.style === "elevated" && !change.simpleCustom) {
      if (!sourceReady || !sourceBlob) { setError("Restore the source before checking Elevated."); return; }
      const controller = new AbortController(); operation.current = { controller, expected: track, source: sourceBlob }; setBusy(true);
      try {
        const measured = await verifyElevatedChange(sourceBlob, track, change, controller.signal);
        if (controller.signal.aborted || !owns(controller)) return;
        if (latest.current.track !== track || latest.current.sourceBlob !== sourceBlob) throw new Error("Settings changed. Check Elevated again.");
        operation.current = null; setBusy(false);
        setCheck({ owner: change.advanced, source: sourceBlob, ...measured });
        dispatch({ type: "APPLY_SIMPLE_DIRECTION", expected: track, change });
      } catch (reason) {
        if (!controller.signal.aborted && owns(controller)) {
          operation.current = null; setBusy(false); setError(reason instanceof Error ? reason.message : "Elevated could not be checked. Try again.");
        }
      }
    } else dispatch({ type: "APPLY_SIMPLE_DIRECTION", expected: track, change });
  }
  const activeDirection = track.simpleCustom === false;
  const selectedTarget = currentMasteringTarget(track.advanced.limiter, track.target);
  const targetLufsLabel = String(track.advanced.limiter.targetLufs).replace("-", "−");
  const targetCeilingLabel = String(track.advanced.limiter.ceiling).replace("-", "−");

  const style = track.simpleDirection?.style ?? "precise";
  const depth = track.simpleDirection?.depth ?? false, presence = track.simpleDirection?.presence ?? false;

  return (
    <div className="control-stack">
      <div>
        <h2>Find the feeling</h2>
        <p>Choose a direction to update the shared settings. Input gain and output targets stay in place. Other Advanced edits stay until you choose another direction.</p>
        {!activeDirection && <p className="disclosure" role="status">Custom settings</p>}
        {!activeDirection && track.simpleDirection && <p className="disclosure">Your last direction is remembered. Choosing a direction restores its style and modifiers.</p>}
      </div>
      {hasAppliedDeep(track) && <p className="disclosure">Detach Deep automation before choosing a Simple direction.</p>}
      <fieldset className="m-0 min-w-0 border-0 p-0" disabled={hasAppliedDeep(track)}>
      <legend className="sr-only">Simple mastering direction</legend>
      <ChoiceGroup
        label="Genre"
        value={activeDirection ? track.genre : undefined}
        options={simpleGenreNames.map((item) => ({ value: item, label: item }))}
        onChange={(genre) => { void update({ genre }); }}
      />
      <ChoiceGroup
        label="Tone intention"
        value={activeDirection ? track.tone : undefined}
        options={simpleToneNames.map((item) => ({ value: item, label: item }))}
        onChange={(tone) => { void update({ tone }); }}
      />
      <ChoiceGroup
        label="Mastering style"
        value={activeDirection ? style : undefined}
        options={([["precise", "Precise"], ["organic", "Organic"], ["elevated", "Elevated"]] as const).map(([value, label]) => ({ value, label }))}
        onChange={(next) => { void update({ style: next }); }}
      />
      <p className="disclosure">Precise keeps a restrained curve. Organic eases compression and color. Elevated adds compression after a rendered peak and loudness check; it adds no automatic gain.</p>
      <ControlGroup label="Optional modifiers">
        <div className="choice-grid">
          <button type="button" className={activeDirection && depth ? "choice is-active min-h-[44px]" : "choice min-h-[44px]"}
            aria-pressed={activeDirection && depth} onClick={() => { void update({ depth: !(activeDirection && depth) }); }}>Depth {activeDirection && depth ? "on" : depth ? "last on" : "off"}</button>
          <button type="button" className={activeDirection && presence ? "choice is-active min-h-[44px]" : "choice min-h-[44px]"}
            aria-pressed={activeDirection && presence} onClick={() => { void update({ presence: !(activeDirection && presence) }); }}>Presence {activeDirection && presence ? "on" : presence ? "last on" : "off"}</button>
        </div>
      </ControlGroup>
      <SliderField
        label="Intensity"
        value={track.intensity}
        defaultValue={50}
        min={0}
        max={100}
        step={1}
        unit="%"
        onChange={(intensity) => {
          void update({ intensity });
        }}
      />
      <ControlGroup label="Output target">
        <div className="select-wrap">
          <select
            value={selectedTarget}
            aria-label="Output target"
            onChange={(e) => {
              void update({ target: e.target.value });
            }}
          >
            {selectedTarget === "custom" && <option value="custom" disabled>Custom ({targetLufsLabel} LUFS)</option>}
            {masteringTargets.map((target) => <option value={target.name} key={target.name}>{target.name} ({String(target.targetLufs).replace("-", "−")} LUFS)</option>)}
          </select>
          <Icon name="chevron-down" />
        </div>
      </ControlGroup>
      </fieldset>
      {busy && <div role="status"><p>Checking Elevated on the complete source. Current settings stay audible.</p><Button variant="secondary" onClick={cancel}>Cancel Elevated check</Button></div>}
      {error && <p className="disclosure" role="alert">{error}</p>}
      {check && check.owner === track.advanced && check.source === sourceBlob && <p className="disclosure" role="status">Rendered check: {check.lufs.toFixed(1)} LUFS · {check.peak.toFixed(2)} dBTP.</p>}
      <p className="disclosure">Current target: {targetLufsLabel} LUFS · ceiling {targetCeilingLabel} dBTP. Set target loudness measures these current settings.</p>
      <Button
        className="full-button"
        disabled={processing || busy || !sourceReady || hasAppliedDeep(track)}
        icon={
          <Icon
            name={processing ? "refresh-cw" : "sparkles"}
            className={processing ? "spin" : ""}
          />
        }
        onClick={onApply}
      >
        {processing ? "Setting loudness…" : "Set target loudness"}
      </Button>
    </div>
  );
}

