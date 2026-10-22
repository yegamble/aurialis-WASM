"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

type Point = { x: number; y: number };
const coordinates = (points: string): Point[] => points.split(" ").map((point) => {
  const [x, y] = point.split(",").map(Number);
  return { x: x ?? 0, y: y ?? 60 };
});

function paint(line: SVGPolylineElement | null, fill: SVGPolygonElement | null, points: readonly Point[]): void {
  const value = points.map(({ x, y }) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  line?.setAttribute("points", value);
  fill?.setAttribute("points", `0,60 ${value} 100,60`);
}

/** Only the display moves between measured FFT frames; audio and measurements are unchanged. */
export function SpectrumTrace({ points, playing, gradientId }: { points: string; playing: boolean; gradientId: string }) {
  const line = useRef<SVGPolylineElement>(null);
  const fill = useRef<SVGPolygonElement>(null);
  const initial = useRef(points);
  const visual = useRef(coordinates(points));
  const target = useRef(visual.current);
  const motion = useRef(false);

  useLayoutEffect(() => {
    target.current = coordinates(points);
    if (!playing || !motion.current) {
      visual.current = target.current;
      paint(line.current, fill.current, visual.current);
    }
  }, [points, playing]);

  useEffect(() => {
    if (!playing) return undefined;
    const preference = typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)") : undefined;
    let frame = 0;
    let lastTime = 0;
    let disposed = false;
    const draw = (time: number) => {
      if (disposed || !motion.current) return;
      const elapsed = Math.min(50, lastTime ? time - lastTime : 1000 / 60);
      lastTime = time;
      const changed = target.current.some((next, index) => next.y !== visual.current.at(index)?.y);
      visual.current = target.current.map((next, index) => {
        const previous = visual.current.at(index) ?? next;
        const difference = next.y - previous.y;
        if (difference === 0) return next;
        if (Math.abs(difference) < 0.005) return next;
        // Faster attack retains transients; a slower release reduces visual jitter.
        const weight = 1 - Math.exp(-elapsed / (difference < 0 ? 35 : 100));
        return { x: next.x, y: previous.y + difference * weight };
      });
      if (changed) paint(line.current, fill.current, visual.current);
      frame = requestAnimationFrame(draw);
    };
    const configure = () => {
      cancelAnimationFrame(frame);
      lastTime = 0;
      motion.current = !preference?.matches;
      if (motion.current) frame = requestAnimationFrame(draw);
      else { visual.current = target.current; paint(line.current, fill.current, visual.current); }
    };
    configure();
    preference?.addEventListener("change", configure);
    return () => {
      disposed = true;
      motion.current = false;
      cancelAnimationFrame(frame);
      preference?.removeEventListener("change", configure);
    };
  }, [playing]);

  return <>
    <polygon ref={fill} points={`0,60 ${initial.current} 100,60`} fill={`url(#${gradientId})`} />
    <polyline ref={line} points={initial.current} fill="none" stroke="var(--clay)" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
  </>;
}
