"use client";

import { useState } from "react";
import { summarizeAlbum, type AlbumReading } from "@/lib/album-consistency";

type View = "Loudness" | "Tone" | "Dynamics";
export function AlbumConsistencyChart({ readings }: { readings: AlbumReading[] }) {
  const [view, setView] = useState<View>("Loudness");
  const summary = readings.length ? summarizeAlbum(readings) : null;
  const values = readings.map((row) => view === "Loudness" ? row.metrics.integratedLufs : view === "Dynamics" ? row.metrics.dynamicRangeDb
    : summary?.tracks.find((item) => item.id === row.id)?.tonalDeviationDb ?? null);
  const available = values.filter((value): value is number => value !== null);
  const low = available.length ? Math.min(...available) : 0, high = available.length ? Math.max(...available) : 0;
  const unit = view === "Loudness" ? "LUFS" : "dB";
  return <section className="paper-panel consistency" aria-label="Measured album consistency">
    <div className="section-heading"><div><span className="eyebrow">Across the album</span><h2>Listen to the transitions.</h2></div></div>
    <div className="platforms" role="group" aria-label="Consistency view">{(["Loudness", "Tone", "Dynamics"] as const).map((name) => <button className={`chip min-h-[44px]${view === name ? " is-active" : ""}`} type="button" key={name} aria-pressed={view === name} onClick={() => { setView(name); }}>{name}</button>)}</div>
    <p className="disclosure">{view === "Loudness" ? `Median track loudness ${summary?.medianTrackLufs?.toFixed(1) ?? "unavailable"} LUFS; measured spread ${summary?.loudnessSpreadLu?.toFixed(1) ?? "unavailable"} LU. This is not album-integrated loudness.`
      : view === "Dynamics" ? "Crest factor is sample peak minus RMS; it is not loudness range (LRA). A 3 dB difference is a working listening flag."
      : `Tone compares relative power fractions across ${String(summary?.commonBands.length ?? 0)} full, nonzero bands shared by all audible tracks. Fewer than two shared bands means unavailable.`}</p>
    <div className="consistency-chart" role="img" aria-label={`${view} comparison of measured final encoded album masters; readings are listed below`}>
      {readings.length ? readings.map((row, index) => {
        const value = values.at(index) ?? null;
        return <div key={row.id}><span style={{ height: value === null ? "0%" : `${String(high === low ? 50 : 15 + (value - low) / (high - low) * 70)}%` }}><i>{value?.toFixed(1) ?? "—"}</i></span><small>{index + 1}</small></div>;
      }) : <p>Render the sequence to compare measured final audio.</p>}
    </div>
    <ol className="album-reading-list mt-4 space-y-2 [overflow-wrap:anywhere]" aria-label={`${view} text readings`}>{readings.map((row, index) => <li key={row.id}><strong>{row.title}</strong>: {values.at(index)?.toFixed(2) ?? "Unavailable"} {unit}</li>)}</ol>
    <p className="disclosure">These descriptive comparisons do not score quality or automatically change tone, dynamics or your intended sequence.</p>
  </section>;
}
