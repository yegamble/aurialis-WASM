"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { computeEqMagnitudeDb } from "@/lib/audio-dsp";
import type { EQBandId, EQBandParams, Track } from "@/lib/types";
import { Icon } from "./Icon";

export const formatTime = (seconds: number): string =>
  `${String(Math.floor(seconds / 60))}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;

export const statusLabel = (status: Track["status"]): string =>
  status.replace("-", " ");

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "border-clay bg-clay text-white shadow-[0_7px_18px_rgba(180,84,60,0.16)] hover:enabled:border-clay-dark hover:enabled:bg-clay-dark",
  secondary: "border-line-dark bg-paper text-ink hover:enabled:border-ink",
  ghost: "border-transparent bg-transparent text-ink-soft hover:enabled:bg-paper-deep",
  danger: "border-danger bg-danger text-white hover:enabled:brightness-90",
};

export function buttonClassName(variant: ButtonVariant = "primary", className = ""): string {
  return `button button--${variant} inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full border px-4 py-2.5 text-[13px] font-semibold transition enabled:hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-55 [&_svg]:size-4 ${buttonVariants[variant]} ${className}`.trim();
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
  children,
}: {
  label: string;
  value?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="control-group mt-[18px] grid min-w-0 gap-2">
      <div className="control-label mb-1.5 flex items-center justify-between gap-2.5 text-xs">
        {htmlFor !== undefined ? (
          <label htmlFor={htmlFor}>{label}</label>
        ) : (
          <span>{label}</span>
        )}
        {value !== undefined ? <strong className="font-semibold text-clay-dark tabular-nums">{value}</strong> : null}
      </div>
      {children}
    </div>
  );
}

export function SliderField({
  label,
  value,
  min,
  max,
  step = 1,
  unit = "",
  onChange,
  onCommit,
  ariaLabel,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (next: number) => void;
  onCommit?: () => void;
  ariaLabel?: string;
}) {
  const inputId = useId();
  const formatted = `${String(Number.isInteger(step) ? value : value.toFixed(1))}${
    unit ? ` ${unit}` : ""
  }`;
  return (
    <ControlGroup label={label} value={formatted} htmlFor={inputId}>
      <input
        id={inputId}
        type="range"
        className="min-h-11 w-full cursor-pointer accent-clay-dark"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={ariaLabel ?? label}
        onChange={(e) => {
          onChange(Number(e.target.value));
        }}
        onPointerUp={onCommit}
      />
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
  if (!open) return null;

  return (
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
    </div>
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
  const ratio = controlledRatio ?? internalRatio;
  const currentSec = Math.round(ratio * duration);

  const setRatio = (next: number) => {
    const clamped = Math.max(0, Math.min(1, next));
    setInternalRatio(clamped);
    onSeekRatio?.(clamped);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setRatio(ratio + 0.05);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      setRatio(ratio - 0.05);
    } else if (event.key === "Home") {
      event.preventDefault();
      setRatio(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setRatio(1);
    }
  };

  if (!peaks?.length) {
    return (
      <div className="waveform waveform--empty" role="status">
        <p>Source waveform unavailable. Load audio to see its waveform.</p>
      </div>
    );
  }

  return (
    <div className={`waveform ${compact ? "waveform--compact" : ""}`.trim()}>
      {!compact && (
        <div className="chart-label">
          <span>Source waveform</span>
          <span>
            {formatTime(currentSec)} / {formatTime(duration)}
          </span>
        </div>
      )}
      <div
        className="wave-bars"
        role="slider"
        tabIndex={0}
        aria-label={
          compact ? "Stem waveform position" : "Track playback position"
        }
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={currentSec}
        aria-valuetext={`${formatTime(currentSec)} of ${formatTime(duration)}`}
        onKeyDown={handleKeyDown}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          if (rect.width > 0) {
            setRatio((event.clientX - rect.left) / rect.width);
          }
        }}
      >
        {peaks.map((peak, i) => (
          <i key={i} style={{ height: `${String(Math.max(1, Math.min(100, peak * 100)))}%` }} />
        ))}
        <span
          className="playhead"
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
  return 30 - (clamped / 15) * 24;
}

export function SpectrumChart({
  eqBands,
  activeBandId,
  sampleRate = 48000,
  onSelectBand,
  onBandChange,
}: {
  seed?: number;
  eqBands?: readonly EQBandParams[];
  activeBandId?: EQBandId;
  sampleRate?: number;
  onSelectBand?: (id: EQBandId) => void;
  onBandChange?: (id: EQBandId, patch: Partial<EQBandParams>) => void;
}) {
  const gradientId = useId();
  const instructionsId = useId();
  const plotRef = useRef<HTMLDivElement>(null);
  const maxFrequency = Math.min(20000, sampleRate * 0.47);
  const updateFromPointer = (id: EQBandId, event: ReactPointerEvent<HTMLButtonElement>) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect?.width || !rect.height) return;
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(60, ((event.clientY - rect.top) / rect.height) * 60));
    onBandChange?.(id, {
      freqHz: Math.round(Math.min(maxFrequency, 20 * Math.pow(maxFrequency / 20, x))),
      gainDb: Math.max(-12, Math.min(12, Math.round(((30 - y) / 24) * 15 * 10) / 10)),
    });
  };
  const updateFromKey = (band: EQBandParams, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const gainStep = event.shiftKey ? 1 : 0.5;
    const frequencyFactor = Math.pow(2, event.shiftKey ? 1 : 1 / 12);
    let patch: Partial<EQBandParams>;
    switch (event.key) {
      case "ArrowUp": patch = { gainDb: Math.min(12, band.gainDb + gainStep) }; break;
      case "ArrowDown": patch = { gainDb: Math.max(-12, band.gainDb - gainStep) }; break;
      case "ArrowLeft": patch = { freqHz: Math.max(20, Math.round(band.freqHz / frequencyFactor)) }; break;
      case "ArrowRight": patch = { freqHz: Math.min(maxFrequency, Math.round(band.freqHz * frequencyFactor)) }; break;
      default: return;
    }
    event.preventDefault();
    onBandChange?.(band.id, patch);
  };
  const basePoints = Array.from({ length: 25 }, (_, i) => {
    const x = (i / 24) * 100;
    const freq = 20 * Math.pow(maxFrequency / 20, i / 24);
    const eqDb = eqBands ? computeEqMagnitudeDb(freq, eqBands, sampleRate) : 0;
    const y = Math.max(4, Math.min(56, 30 - eqDb * 1.4));
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");

  const summaryText = eqBands
    ? eqBands
        .map(
          (b) =>
            `${b.label} (${String(b.freqHz)} Hz): ${b.gainDb >= 0 ? "+" : ""}${b.gainDb.toFixed(1)} dB`,
        )
        .join(", ")
    : "No EQ settings loaded";

  return (
    <div className="spectrum">
      <div className="chart-label">
        <span>
          {eqBands ? "Approximate EQ response" : "EQ response unavailable"}
        </span>
        <span>20 Hz — {String(Number((maxFrequency / 1000).toFixed(1)))} kHz</span>
      </div>
      <div className="spectrum-plot" ref={plotRef}>
      <svg
        viewBox="0 0 100 60"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Tonal balance curve: ${summaryText}`}
      >
        <title>{`Tonal balance curve: ${summaryText}`}</title>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--clay)" stopOpacity=".22" />
            <stop offset="1" stopColor="var(--clay)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon
          points={`0,60 ${basePoints} 100,60`}
          fill={`url(#${gradientId})`}
        />
        <polyline
          points={basePoints}
          fill="none"
          stroke="var(--clay)"
          strokeWidth="1.4"
          vectorEffect="non-scaling-stroke"
        />
        {eqBands?.map((band) => {
          const cx = freqToX(band.freqHz, maxFrequency);
          const cy = gainToY(band.gainDb);
          const isSelected = activeBandId === band.id;
          return (
            <circle
              key={band.id}
              cx={cx}
              cy={cy}
              r={isSelected ? 2.6 : 1.9}
              fill={band.enabled ? "var(--clay)" : "var(--ink-soft)"}
              stroke="var(--paper)"
              strokeWidth="0.8"
            />
          );
        })}
      </svg>
        {onBandChange && eqBands?.map((band) => (
          <button
            key={band.id}
            type="button"
            className="eq-handle"
            disabled={!band.enabled}
            aria-label={`${band.label} EQ: ${String(band.freqHz)} Hz, ${band.gainDb.toFixed(1)} dB`}
            aria-describedby={instructionsId}
            aria-pressed={activeBandId === band.id}
            style={{
              left: `clamp(22px, ${String(freqToX(band.freqHz, maxFrequency))}%, calc(100% - 22px))`,
              top: `clamp(22px, ${String((gainToY(band.gainDb) / 60) * 100)}%, calc(100% - 22px))`,
            }}
            onFocus={() => onSelectBand?.(band.id)}
            onClick={() => onSelectBand?.(band.id)}
            onPointerDown={(event) => {
              onSelectBand?.(band.id);
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                updateFromPointer(band.id, event);
              }
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
            }}
            onKeyDown={(event) => { updateFromKey(band, event); }}
          >
            <span className="sr-only">{band.label}</span>
          </button>
        ))}
      </div>
      {onBandChange && (
        <p className="sr-only" id={instructionsId}>
          Drag to change frequency and gain. Arrow left and right change frequency;
          arrow up and down change gain. Hold Shift for larger steps. The band
          controls provide another way to enter exact values.
        </p>
      )}
      <div className="axis">
        <span>Sub</span>
        <span>Low</span>
        <span>Mid</span>
        <span>Presence</span>
        <span>Air</span>
      </div>
    </div>
  );
}
