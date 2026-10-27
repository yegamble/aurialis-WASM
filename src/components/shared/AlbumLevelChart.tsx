import { useId } from "react";
import type { AlbumMasterLevel } from "@/lib/album-levels";

export type MeasuredAlbumMaster = { id: string; title: string; measured: AlbumMasterLevel; requestedLufs: number | null };

const db = (value: number, unit: string) => `${value < 0 ? "−" : ""}${Math.abs(value).toFixed(2)} ${unit}`;
const target = (value: number) => `${value < 0 ? "−" : ""}${String(Math.abs(value))} LUFS`;
// A short album keeps bar-sized slots, centered, rather than stretching one bar across the chart.
const MIN_SLOTS = 6, SLOT = 40;

/** Integrated loudness (bars) and true peak (ticks) measured from each rendered
 * album master; dashed marks show a normalized master's requested level. The
 * table is the accessible summary and carries every charted value. */
export function AlbumLevelChart({ masters }: { masters: readonly MeasuredAlbumMaster[] }) {
  const captionId = useId();
  const values = masters.flatMap((master) => [master.measured.integratedLufs, master.measured.truePeakDbtp, ...(master.requestedLufs === null ? [] : [master.requestedLufs])]);
  const floor = Math.floor(Math.min(...values) - 3), ceiling = Math.max(0, Math.ceil(Math.max(...values)));
  const y = (value: number) => 4 + ((ceiling - value) / (ceiling - floor)) * 152;
  const normalized = masters.some((master) => master.requestedLufs !== null);
  const width = Math.max(MIN_SLOTS, masters.length) * SLOT, start = (width - masters.length * SLOT) / 2;
  return (
    <figure className="mt-5 grid min-w-0 gap-3">
      <svg className="h-40 w-full" viewBox={`0 0 ${String(width)} 160`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
        {masters.map((master, index) => {
          const x = start + index * SLOT, lufs = y(master.measured.integratedLufs), peak = y(master.measured.truePeakDbtp);
          return (
            <g key={master.id}>
              <rect className="fill-moss" x={x + 8} y={lufs} width={24} height={Math.max(1, 156 - lufs)} rx={3} />
              <line className="stroke-ochre-dark" x1={x + 4} x2={x + 36} y1={peak} y2={peak} strokeWidth={3} vectorEffect="non-scaling-stroke" />
              {master.requestedLufs !== null && <line className="stroke-clay-dark" x1={x + 2} x2={x + 38} y1={y(master.requestedLufs)} y2={y(master.requestedLufs)} strokeWidth={2} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />}
            </g>
          );
        })}
        <line className="stroke-line-dark" x1={0} x2={width} y1={156} y2={156} strokeWidth={1} vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption id={captionId} className="text-xs text-ink-soft">
        Measured from each rendered WAV: bars show integrated loudness, solid ticks show true peak{normalized ? ", dashed marks show the requested level" : ""}.
      </figcaption>
      <div className="min-w-0 overflow-x-auto">
        <table className="w-full text-left text-xs tabular-nums" aria-label="Measured album masters" aria-describedby={captionId}>
          <thead>
            <tr><th scope="col" className="py-1 pr-2 font-semibold">Track</th><th scope="col" className="py-1 pr-2 font-semibold">Loudness</th><th scope="col" className="py-1 pr-2 font-semibold">True peak</th>{normalized && <th scope="col" className="py-1 font-semibold">Requested</th>}</tr>
          </thead>
          <tbody>
            {masters.map((master, index) => (
              <tr key={master.id} className="border-t border-line">
                <th scope="row" className="py-2 pr-2 font-normal [overflow-wrap:anywhere]">{String(index + 1).padStart(2, "0")} {master.title}</th>
                <td className="py-2 pr-2 whitespace-nowrap">{db(master.measured.integratedLufs, "LUFS")}</td>
                <td className="py-2 pr-2 whitespace-nowrap">{db(master.measured.truePeakDbtp, "dBTP")}</td>
                {normalized && <td className="py-2 whitespace-nowrap">{master.requestedLufs === null ? "Kept" : target(master.requestedLufs)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
