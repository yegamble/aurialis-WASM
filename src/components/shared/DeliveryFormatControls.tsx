"use client";

import { useId } from "react";
import type { DeliveryFormat } from "@/lib/delivery-format";
import { formatRate, type ExportRateChoice } from "@/lib/export-rates";
import { ChoiceGroup } from "./Primitives";

/** The one delivery-format control: Export, Release Check and album masters render what it selects. */
export function DeliveryFormatControls({ value, rateChoices, rateNote = "", sourceLabel, onChange }: {
  /** The format actually rendered, after any unavailable rate fell back to the source. */
  value: DeliveryFormat;
  rateChoices: readonly ExportRateChoice[];
  /** Visible reason for every unavailable rate, or "". */
  rateNote?: string;
  /** Label of the "source" choice when it is not one rate, such as an album's. */
  sourceLabel?: string;
  onChange: (next: DeliveryFormat) => void;
}) {
  const noteId = useId();
  return <>
    <ChoiceGroup
      label="Bit depth"
      value={value.bitDepth}
      options={([16, 24, 32] as const).map((depth) => ({ value: depth, label: depth === 32 ? "32-bit Float" : `${String(depth)}-bit PCM` }))}
      onChange={(bitDepth) => { onChange({ ...value, bitDepth }); }}
    />
    <ChoiceGroup
      label="Sample rate"
      className="choice-grid--pairs"
      value={value.sampleRate}
      options={rateChoices.map((choice) => ({
        value: choice.value,
        label: choice.value === "source" ? sourceLabel ?? `${formatRate(choice.hz)} (source)` : formatRate(choice.hz),
        // A source choice outside the even set of rates sits on its own row.
        wide: choice.value === "source" && rateChoices.length % 2 === 1,
        disabled: choice.unavailable !== undefined,
        ...(choice.unavailable && rateNote ? { describedBy: noteId } : {}),
      }))}
      onChange={(sampleRate) => { onChange({ ...value, sampleRate }); }}
    />
    {rateNote && <p id={noteId} className="disclosure">{rateNote}</p>}
    {value.bitDepth !== 32 && (
      <ChoiceGroup
        label="Dither"
        className="choice-grid--pairs"
        value={value.dither}
        options={[{ value: true, label: "TPDF" }, { value: false, label: "Off" }]}
        onChange={(dither) => { onChange({ ...value, dither }); }}
      />
    )}
  </>;
}
