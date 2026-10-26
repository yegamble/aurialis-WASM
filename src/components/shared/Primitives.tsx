"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { computeEqMagnitudeDb, createDefaultAdvancedParams } from "@/lib/audio-dsp";
import type { EQBandId, EQBandParams, Track } from "@/lib/types";
import type { LiveSpectrum } from "@/lib/live-playback";
import { Icon } from "./Icon";
import { SpectrumTrace } from "./SpectrumTrace";

export const formatTime = (seconds: number): string =>
  `${String(Math.floor(seconds / 60))}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;

export const statusLabel = (status: Track["status"]): string =>
  status.replace("-", " ");

const statusVariants = new Map<Track["status"], string>([
  ["draft", "bg-paper-deep text-ink-soft"],
  ["ready", "bg-moss-wash text-moss-dark"],
  ["mastered", "bg-moss-wash text-moss-dark"],
  ["needs-review", "bg-ochre-wash text-ochre-dark"],
]);

export function StatusBadge({ status }: { status: Track["status"] }) {
  return <span className={`status status--${status} inline-flex w-fit rounded-full px-2 py-1 text-[10px] font-semibold tracking-[0.08em] uppercase ${statusVariants.get(status) ?? "bg-paper-deep text-ink-soft"}`}>{statusLabel(status)}</span>;
}

const chartLabelClassName = "chart-label mb-[18px] flex justify-between gap-2 text-[11px] text-ink-soft";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const buttonVariants = new Map<ButtonVariant, string>([
  ["primary", "border-clay bg-clay text-white shadow-[0_7px_18px_rgba(180,84,60,0.16)] hover:enabled:border-clay-dark hover:enabled:bg-clay-dark"],
  ["secondary", "border-line-dark bg-paper text-ink hover:enabled:border-ink"],
  ["ghost", "border-transparent bg-transparent text-ink-soft hover:enabled:bg-paper-deep"],
  ["danger", "border-danger bg-danger text-white hover:enabled:brightness-90"],
]);

export function buttonClassName(variant: ButtonVariant = "primary", className = ""): string {
  return `button button--${variant} inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-2 rounded-full border px-4 py-2.5 text-[13px] font-semibold transition enabled:hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-55 [&_svg]:size-4 ${buttonVariants.get(variant) ?? ""} ${className}`.trim();
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  icon?: ReactNode;
};

export function Button({
  children,
  variant = "primary",
  icon,
  className = "",
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClassName(variant, className)}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
}

export function Artwork({ seed, index = 0 }: { seed: number; index?: number }) {
  return (
    <div
      className={`artwork artwork--${String((seed + index) % 4)}`}
      aria-hidden="true"
    >
      <span />
      <span />
      <span />
    </div>
  );
}

export function PageTitle({
  eyebrow,
  title,
  copy,
  action,
}: {
  eyebrow: string;
  title: string;
  copy?: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-title mb-9 mt-7 flex flex-wrap items-end justify-between gap-5">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1 className="mt-3 text-[clamp(48px,6vw,82px)] tracking-[-0.05em]">{title}</h1>
        {copy !== undefined ? <p className="mt-4 max-w-[60ch] text-sm leading-relaxed">{copy}</p> : null}
      </div>
      {action}
    </header>
  );
}

export function ControlGroup({
  label,
  value,
  htmlFor,
  labelId,
  children,
}: {
  label: string;
  value?: string;
  htmlFor?: string;
  /** Lets a non-input control name itself with aria-labelledby. */
  labelId?: string;
  children: ReactNode;
}) {
  return (
    <div className="control-group mt-[18px] grid min-w-0 gap-2">
      <div className="control-label mb-1.5 flex items-center justify-between gap-2.5 text-xs">
        {htmlFor !== undefined ? (
          <label htmlFor={htmlFor}>{label}</label>
        ) : (
          <span id={labelId}>{label}</span>
        )}
        {value !== undefined ? <strong className="font-semibold text-clay-dark tabular-nums">{value}</strong> : null}
      </div>
      {children}
    </div>
  );
}

type Choice<T> = {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  /** Id of visible text explaining this choice, such as why it is unavailable. */
  describedBy?: string;
  /** Spans the full row, for a choice that sits apart from an even set. */
  wide?: boolean;
};

/** One labeled single-select group of pressed-state buttons. */
export function ChoiceGroup<T extends string | number | boolean>({
  label,
  value,
  options,
  onChange,
  className = "",
}: {
  label: string;
  value: T | undefined;
  options: readonly Choice<T>[];
  onChange: (next: T) => void;
  /** Extra grid classes, such as a column count for this option set. */
  className?: string;
}) {
  const labelId = useId();
  return (
    <ControlGroup label={label} labelId={labelId}>
      <div className={`choice-grid ${className}`.trim()} role="group" aria-labelledby={labelId}>
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              type="button"
              key={String(option.value)}
              className={`choice${active ? " is-active" : ""}${option.wide ? " col-span-full" : ""}`}
              aria-pressed={active}
              disabled={option.disabled}
              aria-describedby={option.describedBy}
              onClick={() => {
                onChange(option.value);
              }}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </ControlGroup>
  );
}

export function SliderField({
  label,
  value,
  defaultValue,
  min,
  max,
  step = 1,
  unit = "",
  onChange,
  onCommit,
  ariaLabel,
  note,
}: {
  label: string;
  value: number;
  defaultValue: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (next: number) => void;
  onCommit?: () => void;
  ariaLabel?: string;
  /** Visible secondary readout, also announced with the slider. */
  note?: string;
}) {
  const inputId = useId();
  const noteId = useId();
  const hintId = useId();
  const precision = Math.min(6, String(step).split(".")[1]?.length ?? 0);
  const resetValue = Math.max(min, Math.min(max, defaultValue));
  const reset = () => { onChange(resetValue); onCommit?.(); };
  const resetHint = `Double-click or press Backspace to reset to ${String(resetValue)}${unit ? ` ${unit}` : ""}.`;
  const formatted = `${String(precision ? value.toFixed(precision) : value)}${
    unit ? ` ${unit}` : ""
  }`;
  return (
    <ControlGroup label={label} value={formatted} htmlFor={inputId}>
      <input
        id={inputId}
        type="range"
        className="min-h-[44px] w-full cursor-pointer accent-clay-dark"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={ariaLabel ?? label}
        aria-describedby={note ? `${noteId} ${hintId}` : hintId}
        title={resetHint}
        onChange={(e) => {
          onChange(Number(e.target.value));
        }}
        onPointerUp={onCommit}
        onDoubleClick={(event) => { event.preventDefault(); reset(); }}
        onKeyDown={(event) => {
          if (event.key === "Backspace") { event.preventDefault(); reset(); }
        }}
      />
      {note ? <span id={noteId} className="text-xs text-[var(--ink-soft)] tabular-nums">{note}</span> : null}
      <span id={hintId} className="sr-only">{resetHint}</span>
    </ControlGroup>
  );
}

function useDialogFocus(open: boolean, onClose: () => void) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusables = () =>
      Array.from(
        panel.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    (focusables()[0] ?? panel.current)?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
      }
      if (event.key === "Tab") {
        const items = focusables(),
          first = items[0],
          last = items.at(-1);
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            !panel.current?.contains(document.activeElement))
        ) {
          event.preventDefault();
          last?.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last ||
            !panel.current?.contains(document.activeElement))
        ) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      document.body.style.overflow = previousOverflow;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [open]);
  return panel;
}

type DialogProps = {
  open: boolean;
  title: string;
  eyebrow?: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
};

function DialogFrame({
  open,
  title,
  eyebrow,
  onClose,
  children,
  actions,
  sheet = false,
}: DialogProps & { sheet?: boolean }) {
  const titleId = useId();
  const panelRef = useDialogFocus(open, onClose);
  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-60 grid items-end justify-items-center bg-ink/45 backdrop-blur-sm md:place-items-center md:p-4"
      role="presentation"
      onClick={(event: ReactMouseEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`${sheet ? "bottom-sheet" : "modal-panel"} max-h-[88dvh] w-full max-w-[540px] overflow-y-auto rounded-t-3xl border border-line-dark bg-paper px-[18px] py-[22px] shadow-[var(--shadow)] md:max-h-[90dvh] md:rounded-3xl md:p-6`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="mb-5 flex items-start justify-between gap-3.5">
          <div className="min-w-0">
            {eyebrow !== undefined && <span className="eyebrow">{eyebrow}</span>}
            <h2 id={titleId} className="text-3xl wrap-anywhere">{title}</h2>
          </div>
          <button
            type="button"
            className="icon-button shrink-0"
            onClick={onClose}
            aria-label={sheet ? "Close menu" : "Close dialog"}
          >
            <Icon name="x" />
          </button>
        </div>
        <div>{children}</div>
        {actions !== undefined && <div className="mt-6 flex flex-wrap justify-end gap-2.5">{actions}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Modal(props: DialogProps) {
  return <DialogFrame {...props} />;
}

export function BottomSheet(props: Omit<DialogProps, "eyebrow" | "actions">) {
  return <DialogFrame {...props} sheet />;
}

export function Waveform({
  duration,
  compact = false,
  peaks,
  playheadRatio: controlledRatio,
  onSeekRatio,
}: {
  seed: number;
  duration: number;
  compact?: boolean;
  peaks?: number[];
  playheadRatio?: number;
  onSeekRatio?: (ratio: number) => void;
}) {
  const [internalRatio, setInternalRatio] = useState(0);
  const barsRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const hasPeaks = Boolean(peaks?.length);
  useEffect(() => {
    const element = barsRef.current;
    if (!element) return undefined;
    const measure = () => { setWidth(Math.floor(element.getBoundingClientRect().width)); };
    measure();
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => { observer.disconnect(); };
    }
    window.addEventListener("resize", measure);
    return () => { window.removeEventListener("resize", measure); };
  }, [hasPeaks]);
  const visiblePeaks = useMemo(() => {
    if (!peaks?.length) return [];
    const count = Math.min(peaks.length, width > 0 ? Math.max(1, Math.floor((width + 1) / 2.5)) : 512);
    return Array.from({ length: count }, (_, index) => {
      let peak = 0;
      for (let offset = Math.floor(index * peaks.length / count); offset < Math.floor((index + 1) * peaks.length / count); offset++)
        peak = Math.max(peak, peaks.at(offset) ?? 0);
      return peak;
    });
  }, [peaks, width]);
  const ratio = controlledRatio ?? internalRatio;
  const currentSec = Math.floor(ratio * duration);

  const setRatio = (next: number) => {
    const clamped = Math.max(0, Math.min(1, next));
    setInternalRatio(clamped);
    onSeekRatio?.(clamped);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const stepSeconds = event.altKey ? 0.1 : event.shiftKey ? 10 : 1;
    const stepRatio = duration > 0 ? stepSeconds / duration : 0;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setRatio(ratio + stepRatio);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      setRatio(ratio - stepRatio);
    } else if (event.key === "Home") {
      event.preventDefault();
      setRatio(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setRatio(1);
    } else if (event.key === "Backspace") {
      event.preventDefault();
      setRatio(0);
    }
  };

  if (!peaks?.length) {
    return (
      <div className="waveform waveform--empty grid min-h-[130px] place-items-center rounded-[18px] border border-line bg-paper p-[18px] text-center" role="status">
        <p className="max-w-[34ch] text-[13px]">Source waveform unavailable. Load audio to see its waveform.</p>
      </div>
    );
  }

  return (
    <div className={`waveform min-w-0 ${compact ? "waveform--compact my-[13px] border-0 bg-transparent px-0 py-[5px]" : "rounded-[18px] border border-line bg-paper p-[18px]"}`}>
      {!compact && (
        <div className={chartLabelClassName}>
          <span>Source waveform</span>
          <span>
            {formatTime(currentSec)} / {formatTime(duration)}
          </span>
        </div>
      )}
      <div
        ref={barsRef}
        className={`wave-bars relative flex min-w-0 cursor-pointer items-center gap-px overflow-hidden ${compact ? "h-[52px]" : "h-[140px]"}`}
        role="slider"
        tabIndex={0}
        aria-label={
          compact ? "Stem waveform position" : "Track playback position"
        }
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={currentSec}
        aria-valuetext={`${formatTime(currentSec)} of ${formatTime(duration)}`}
        aria-description="Arrow keys seek one second; Shift seeks ten seconds; Alt seeks one tenth of a second. Double-click or press Backspace to return to the beginning."
        onKeyDown={handleKeyDown}
        onDoubleClick={(event) => { event.preventDefault(); setRatio(0); }}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          if (rect.width > 0) {
            setRatio((event.clientX - rect.left) / rect.width);
          }
        }}
      >
        {visiblePeaks.map((peak, i) => (
          <i key={i} className="block min-w-0 flex-1 rounded-full" style={{
            height: `${String(Math.max(1, Math.min(100, peak * 100)))}%`,
            backgroundColor: ratio > 0 && i / visiblePeaks.length < ratio ? "var(--clay)" : "var(--line-dark)",
          }} />
        ))}
        <span
          className="playhead absolute inset-y-0 w-px bg-clay-dark"
          style={{ left: `${String(ratio * 100)}%` }}
        />
      </div>
    </div>
  );
}

function freqToX(freqHz: number, maxFrequency = 20000): number {
  const minLog = Math.log10(20);
  const maxLog = Math.log10(maxFrequency);
  const clamped = Math.max(20, Math.min(maxFrequency, freqHz));
  return ((Math.log10(clamped) - minLog) / (maxLog - minLog)) * 100;
}

function gainToY(gainDb: number): number {
  const clamped = Math.max(-15, Math.min(15, gainDb));
  return 30 - clamped * 2;
}

function chartFrequencyTicks(maxFrequency: number): number[] {
  return [...new Set([
    ...[20, 50, 100, 200, 500, 1000, 2000, 5000, 10000].filter((frequency) => frequency < maxFrequency),
    maxFrequency,
  ])];
}

function FrequencyAxis({ maxFrequency }: { maxFrequency: number }) {
  const labeledFrequencies = new Set([20, 100, 1000, maxFrequency]);
  return (
    <div aria-hidden="true" className="absolute right-[22px] bottom-0 left-8 h-[14px] text-[9px] text-ink-soft tabular-nums">
      {chartFrequencyTicks(maxFrequency).filter((frequency) => labeledFrequencies.has(frequency)).map((frequency) => (
        <span key={frequency} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${String(freqToX(frequency, maxFrequency))}%` }}>
          {frequency >= 1000 ? `${String(Number((frequency / 1000).toFixed(1)))}k` : String(Math.round(frequency))} Hz
        </span>
      ))}
    </div>
  );
}

function LevelAxis({ levels, levelToY, top = 12 }: { levels: readonly number[]; levelToY: (level: number) => number; top?: number }) {
  return (
    <>
      <span aria-hidden="true" className="absolute top-0 left-0 text-[9px] text-ink-soft">dB</span>
      <div aria-hidden="true" className="absolute bottom-6 left-0 w-6 text-[9px] text-ink-soft tabular-nums" style={{ top }}>
        {levels.map((level) => (
          <span key={level} className="absolute right-0 -translate-y-1/2" style={{ top: `${String((levelToY(level) / 60) * 100)}%` }}>
            {level > 0 ? `+${String(level)}` : String(level)}
          </span>
        ))}
      </div>
    </>
  );
}

function FrequencyGrid({ maxFrequency, levels, levelToY }: { maxFrequency: number; levels: readonly number[]; levelToY: (level: number) => number }) {
  return (
    <g aria-hidden="true">
      {chartFrequencyTicks(maxFrequency).map((frequency) => (
        <line key={frequency} x1={freqToX(frequency, maxFrequency)} x2={freqToX(frequency, maxFrequency)} y1="0" y2="60" stroke="var(--line)" strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
      ))}
      {levels.map((level) => (
        <line key={level} x1="0" x2="100" y1={levelToY(level)} y2={levelToY(level)} stroke={level === 0 ? "var(--line-dark)" : "var(--line)"} strokeWidth={level === 0 ? "1" : "0.6"} vectorEffect="non-scaling-stroke" />
      ))}
    </g>
  );
}

function eqCurvePoints(
  bands: readonly EQBandParams[],
  sampleRate: number,
  axisMaxFrequency: number,
): string {
  const visibleMaxFrequency = Math.min(axisMaxFrequency, sampleRate * 0.47);
  const frequencies = Array.from(
    { length: 65 },
    (_, i) => 20 * Math.pow(axisMaxFrequency / 20, i / 64),
  ).filter((frequency) => frequency <= visibleMaxFrequency);
  if ((frequencies.at(-1) ?? 0) < visibleMaxFrequency) {
    frequencies.push(visibleMaxFrequency);
  }
  return frequencies.map((frequency) => {
    const gainDb = computeEqMagnitudeDb(frequency, bands, sampleRate);
    return `${freqToX(frequency, axisMaxFrequency).toFixed(2)},${gainToY(gainDb).toFixed(2)}`;
  }).join(" ");
}

function describeEqBands(bands: readonly EQBandParams[]): string {
  return bands.map((band) =>
    `${band.label} (${String(band.freqHz)} Hz): ${band.type === "highpass" ? `high-pass, Q ${String(band.q)}, gain unavailable` : `${band.gainDb >= 0 ? "+" : ""}${band.gainDb.toFixed(1)} dB`}${band.enabled ? "" : " (bypassed)"}`,
  ).join(", ");
}

export function SpectrumChart({
  eqBands,
  activeBandId,
  sampleRate = 48000,
  referenceBands,
  referenceSampleRate = sampleRate,
  referenceLabel = "Reference EQ",
  onSelectBand,
  onBandChange,
}: {
  seed?: number;
  eqBands?: readonly EQBandParams[];
  activeBandId?: EQBandId;
  sampleRate?: number;
  referenceBands?: readonly EQBandParams[];
  referenceSampleRate?: number;
  referenceLabel?: string;
  onSelectBand?: (id: EQBandId) => void;
  onBandChange?: (id: EQBandId, patch: Partial<EQBandParams>) => void;
}) {
  const gradientId = useId();
  const instructionsId = useId();
  const plotRef = useRef<HTMLDivElement>(null);
  const maxFrequency = Math.min(20000, sampleRate * 0.47);
  const resetBand = (band: EQBandParams) => {
    const defaults = createDefaultAdvancedParams().eqBands.find((item) => item.id === band.id);
    if (defaults) onBandChange?.(band.id, { freqHz: Math.min(maxFrequency, defaults.freqHz), ...(band.type === "highpass" ? {} : { gainDb: defaults.gainDb }) });
  };
  const updateFromPointer = (band: EQBandParams, event: ReactPointerEvent<HTMLButtonElement>) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect?.width || !rect.height) return;
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(60, ((event.clientY - rect.top) / rect.height) * 60));
    onBandChange?.(band.id, {
      freqHz: Math.round(Math.min(maxFrequency, 20 * Math.pow(maxFrequency / 20, x))),
      ...(band.type === "highpass" ? {} : { gainDb: Math.max(-12, Math.min(12, Math.round(((30 - y) / 2) * 10) / 10)) }),
    });
  };
  const updateFromKey = (band: EQBandParams, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const gainStep = event.shiftKey ? 1 : 0.5;
    const frequencyFactor = Math.pow(2, event.shiftKey ? 1 : 1 / 12);
    if (band.type === "highpass" && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      return;
    }
    let patch: Partial<EQBandParams>;
    switch (event.key) {
      case "Backspace": event.preventDefault(); resetBand(band); return;
      case "ArrowUp": patch = { gainDb: Math.min(12, band.gainDb + gainStep) }; break;
      case "ArrowDown": patch = { gainDb: Math.max(-12, band.gainDb - gainStep) }; break;
      case "ArrowLeft": patch = { freqHz: Math.max(20, Math.round(band.freqHz / frequencyFactor)) }; break;
      case "ArrowRight": patch = { freqHz: Math.min(maxFrequency, Math.round(band.freqHz * frequencyFactor)) }; break;
      default: return;
    }
    event.preventDefault();
    onBandChange?.(band.id, patch);
  };
  const basePoints = eqCurvePoints(eqBands ?? [], sampleRate, maxFrequency);
  const referencePoints = referenceBands
    ? eqCurvePoints(referenceBands, referenceSampleRate, maxFrequency)
    : undefined;
  const referenceMaxFrequency = Math.min(maxFrequency, referenceSampleRate * 0.47);
  const sourceSummary = eqBands ? describeEqBands(eqBands) : "No EQ settings loaded";
  const referenceSummary = referenceBands
    ? `${referenceLabel}: ${describeEqBands(referenceBands)}. Evaluated at ${String(referenceSampleRate)} Hz; shown up to ${String(Math.round(referenceMaxFrequency))} Hz`
    : "";
  const summaryText = `Source EQ: ${sourceSummary}${referenceSummary ? `. ${referenceSummary}` : ""}`;

  const gainTicks = [12, 6, 0, -6, -12];

  return (
    <div className="spectrum rounded-[18px] border border-line bg-paper p-3 md:p-4">
      <div className="chart-label mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[11px] text-ink-soft">
        <span>{eqBands ? "Approximate EQ response" : "EQ response unavailable"}</span>
        <span>20 Hz — {String(Number((maxFrequency / 1000).toFixed(1)))} kHz</span>
      </div>
      <div className="spectrum-plot relative h-[148px] md:h-[176px]">
        <LevelAxis levels={gainTicks} levelToY={gainToY} />
        <div className="eq-plot-bounds absolute top-3 right-[22px] bottom-6 left-8" ref={plotRef}>
          <svg
            className="absolute inset-0 block size-full overflow-visible"
            viewBox="0 0 100 60"
            preserveAspectRatio="none"
            role="img"
            aria-label={`Approximate EQ response, logarithmic frequency axis, gain range minus 15 to plus 15 dB. ${summaryText}`}
          >
            <title>{`Approximate EQ response: ${summaryText}`}</title>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--clay)" stopOpacity=".12" />
                <stop offset="1" stopColor="var(--clay)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <FrequencyGrid maxFrequency={maxFrequency} levels={gainTicks} levelToY={gainToY} />
            <polygon points={`0,60 ${basePoints} 100,60`} fill={`url(#${gradientId})`} />
            <polyline points={basePoints} fill="none" stroke="var(--clay)" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
            {referencePoints !== undefined && (
              <polyline points={referencePoints} fill="none" stroke="var(--moss)" strokeWidth="1.8" strokeDasharray="5 3" vectorEffect="non-scaling-stroke">
                <title>{referenceSummary}</title>
              </polyline>
            )}
          </svg>
          {eqBands?.map((band) => {
            const isSelected = activeBandId === band.id;
            const position = {
              left: `${String(freqToX(band.freqHz, maxFrequency))}%`,
              top: `${String((gainToY(band.type === "highpass" ? 0 : band.gainDb) / 60) * 100)}%`,
              zIndex: isSelected ? 2 : 1,
            };
            const marker = (
              <span aria-hidden="true" className={`eq-marker block shrink-0 rounded-full border-2 border-paper ${isSelected ? "size-[12px] ring-2 ring-clay-dark ring-offset-2 ring-offset-paper" : "size-[10px] ring-1 ring-clay-dark"} ${band.enabled ? "bg-clay" : "bg-ink-soft"}`} />
            );
            if (!onBandChange || !isSelected) {
              return <span key={band.id} aria-hidden="true" className="eq-static-marker pointer-events-none absolute -translate-x-1/2 -translate-y-1/2" style={position}>{marker}</span>;
            }
            return (
              <button
                key={band.id}
                type="button"
                className="eq-handle absolute grid size-[44px] -translate-x-1/2 -translate-y-1/2 touch-none cursor-grab place-items-center rounded-full border-0 bg-transparent p-0 hover:bg-clay-wash/30 active:cursor-grabbing focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-clay-dark disabled:cursor-not-allowed"
                disabled={!band.enabled}
                aria-label={`${band.label} EQ: ${String(band.freqHz)} Hz, ${band.type === "highpass" ? `high-pass, Q ${String(band.q)}, gain unavailable` : `${band.gainDb.toFixed(1)} dB`}`}
                aria-describedby={instructionsId}
                aria-pressed={isSelected}
                style={position}
                onFocus={() => onSelectBand?.(band.id)}
                onClick={() => onSelectBand?.(band.id)}
                onDoubleClick={(event) => { event.preventDefault(); resetBand(band); }}
                onPointerDown={(event) => {
                  onSelectBand?.(band.id);
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) updateFromPointer(band, event);
                }}
                onPointerUp={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onKeyDown={(event) => { updateFromKey(band, event); }}
              >
                {marker}
              </button>
            );
          })}
        </div>
        <FrequencyAxis maxFrequency={maxFrequency} />
      </div>
      {onBandChange && (
        <p className="sr-only" id={instructionsId}>
          Select a band using the band controls, then drag its node to change
          frequency and gain. Arrow left and right change frequency;
          arrow up and down change gain. Hold Shift for larger steps. The band
          controls provide another way to enter exact values. High-pass nodes change
          frequency only and retain gain. Double-click a node or press Backspace to
          reset its frequency and, for other filter types, gain.
        </p>
      )}
      {referenceBands && (
        <p className="mt-2 text-[11px] text-ink-soft">
          Source EQ: solid line. {referenceLabel}: dashed line.
          {referenceMaxFrequency < maxFrequency && ` Reference ends at ${String(Math.round(referenceMaxFrequency))} Hz for its source sample rate.`}
        </p>
      )}
    </div>
  );
}


const spectrumFloorDb = -100;
const spectrumLevelToY = (decibels: number): number =>
  (Math.max(spectrumFloorDb, Math.min(0, decibels)) / spectrumFloorDb) * 60;

function measuredSpectrumPoints(frame: LiveSpectrum, maxFrequency: number): { points: string; peakDb: number } {
  let peakDb = Number.NEGATIVE_INFINITY;
  const points = Array.from({ length: 160 }, (_, index) => {
    const ratio = index / 159;
    const frequency = 20 * Math.pow(maxFrequency / 20, ratio);
    const lower = 20 * Math.pow(maxFrequency / 20, Math.max(0, (index - 0.5) / 159));
    const upper = 20 * Math.pow(maxFrequency / 20, Math.min(1, (index + 0.5) / 159));
    const firstBin = Math.max(0, Math.floor((lower * frame.fftSize) / frame.sampleRate));
    const lastBin = Math.min(frame.dbBins.length - 1, Math.ceil((upper * frame.fftSize) / frame.sampleRate));
    let level = spectrumFloorDb;
    for (let bin = firstBin; bin <= lastBin; bin++) {
      const value = frame.dbBins.at(bin);
      if (value !== undefined && Number.isFinite(value)) {
        level = Math.max(level, value);
        peakDb = Math.max(peakDb, value);
      }
    }
    return `${freqToX(frequency, maxFrequency).toFixed(2)},${spectrumLevelToY(level).toFixed(2)}`;
  }).join(" ");
  return { points, peakDb };
}

export function LiveSpectrumChart({ frame, playing }: { frame?: LiveSpectrum | null; playing: boolean }) {
  const gradientId = useId();
  const validFrame = frame && Number.isFinite(frame.sampleRate) && Number.isFinite(frame.fftSize)
    && frame.sampleRate > 0 && frame.fftSize > 0 && frame.dbBins.length > 1
    && ((frame.dbBins.length - 1) * frame.sampleRate) / frame.fftSize > 20
    && frame.dbBins.some((value) => Number.isFinite(value) || value === Number.NEGATIVE_INFINITY)
    ? frame : null;
  const maxFrequency = validFrame
    ? Math.min(20000, ((validFrame.dbBins.length - 1) * validFrame.sampleRate) / validFrame.fftSize)
    : 20000;
  const measured = validFrame ? measuredSpectrumPoints(validFrame, maxFrequency) : null;
  const peakLabel = measured && measured.peakDb > spectrumFloorDb
    ? `${measured.peakDb.toFixed(1)} dB max bin` : "Below −100 dB";
  const status = playing ? validFrame ? "Playing" : "Waiting for analyser data" : validFrame ? "Paused · last frame" : "Waiting for playback";
  const levels = [0, -20, -40, -60, -80, -100];
  const summary = validFrame
    ? `${status}. Actual audible output FFT, ${String(validFrame.fftSize)} samples at ${String(validFrame.sampleRate)} Hz. ${peakLabel}. Frequency range 20 to ${String(Math.round(maxFrequency))} Hz; level range minus 100 to zero dB.`
    : "No live frequency data yet. Play the source or processed audio to see its measured output spectrum.";

  return (
    <section className="live-spectrum rounded-[18px] border border-line bg-paper p-3 md:p-4" aria-label="Live output spectrum">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[11px] text-ink-soft">
        <span>Live output spectrum</span>
        <span role="status">{status}</span>
      </div>
      <div className="relative h-[148px] md:h-[176px]">
        <LevelAxis levels={levels} levelToY={spectrumLevelToY} top={24} />
        <div className="absolute top-6 right-[22px] bottom-6 left-8">
          <svg className={`absolute inset-0 block size-full ${playing ? "opacity-100" : "opacity-55"}`} viewBox="0 0 100 60" preserveAspectRatio="none" role="img" aria-label={summary}>
            <title>{summary}</title>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--clay)" stopOpacity=".22" />
                <stop offset="1" stopColor="var(--clay)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <FrequencyGrid maxFrequency={maxFrequency} levels={levels} levelToY={spectrumLevelToY} />
            {measured && <SpectrumTrace points={measured.points} playing={playing} gradientId={gradientId} />}
          </svg>
          {!measured && <div className="absolute inset-0 grid place-items-center"><p className="max-w-[28ch] bg-paper/90 p-2 text-center text-[11px] text-ink-soft">Play audio to see the live output spectrum.</p></div>}
        </div>
        <FrequencyAxis maxFrequency={maxFrequency} />
      </div>
      {measured && <p className="mt-2 text-[10px] text-ink-soft tabular-nums">{peakLabel} · {validFrame?.fftSize} point FFT · 20 Hz–{Number((maxFrequency / 1000).toFixed(1))} kHz</p>}
    </section>
  );
}
