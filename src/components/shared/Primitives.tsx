"use client"

import {
  useEffect,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react"
import {
  computeEqMagnitudeDb,
} from "@/lib/audio-dsp"
import type {
  EQBandId,
  EQBandParams,
  MasteringScript,
  Move,
  MoveLane,
  Track,
} from "@/lib/types"
import { Icon } from "./Icon"

export const formatTime = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`

export const statusLabel = (status: Track["status"]): string =>
  status.replace("-", " ")

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger"
  icon?: ReactNode
}

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
      className={`button button--${variant} ${className}`.trim()}
      {...props}
    >
      {icon}
      {children}
    </button>
  )
}

export function Artwork({ seed, index = 0 }: { seed: number; index?: number }) {
  return (
    <div
      className={`artwork artwork--${(seed + index) % 4}`}
      aria-hidden="true"
    >
      <span />
      <span />
      <span />
    </div>
  )
}

export function PageTitle({
  eyebrow,
  title,
  copy,
  action,
}: {
  eyebrow: string
  title: string
  copy?: string
  action?: ReactNode
}) {
  return (
    <header className="page-title">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {copy !== undefined ? <p>{copy}</p> : null}
      </div>
      {action}
    </header>
  )
}

export function ControlGroup({
  label,
  value,
  htmlFor,
  children,
}: {
  label: string
  value?: string
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <div className="control-group">
      <div className="control-label">
        {htmlFor !== undefined ? (
          <label htmlFor={htmlFor}>{label}</label>
        ) : (
          <span>{label}</span>
        )}
        {value !== undefined ? <strong>{value}</strong> : null}
      </div>
      {children}
    </div>
  )
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
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  onChange: (next: number) => void
  onCommit?: () => void
  ariaLabel?: string
}) {
  const inputId = useId()
  const formatted = `${Number.isInteger(step) ? value : value.toFixed(1)}${
    unit ? ` ${unit}` : ""
  }`
  return (
    <ControlGroup label={label} value={formatted} htmlFor={inputId}>
      <input
        id={inputId}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={ariaLabel ?? label}
        onChange={(e) => {
          onChange(Number(e.target.value))
        }}
        onPointerUp={onCommit}
      />
    </ControlGroup>
  )
}

export function Modal({
  open,
  title,
  eyebrow,
  onClose,
  children,
  actions,
}: {
  open: boolean
  title: string
  eyebrow?: string
  onClose: () => void
  children: ReactNode
  actions?: ReactNode
}) {
  const titleId = useId()

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [open, onClose])

  if (!open) return null

  const handleBackdropClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onClose()
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={handleBackdropClick}
    >
      <div
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal-header">
          <div>
            {eyebrow !== undefined ? (
              <span className="eyebrow">{eyebrow}</span>
            ) : null}
            <h2 id={titleId}>{title}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <Icon name="x" />
          </button>
        </div>
        <div>{children}</div>
        {actions !== undefined ? (
          <div className="modal-actions">{actions}</div>
        ) : null}
      </div>
    </div>
  )
}

export function BottomSheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}) {
  const titleId = useId()

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="bottom-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close menu"
          >
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function bars(seed: number, count = 84): number[] {
  return Array.from(
    { length: count },
    (_, index) => 14 + ((seed * (index + 3) * 17 + index * index * 3) % 72),
  )
}

export function Waveform({
  seed,
  duration,
  compact = false,
  peaks,
  playheadRatio: controlledRatio,
  onSeekRatio,
}: {
  seed: number
  duration: number
  compact?: boolean
  peaks?: number[]
  playheadRatio?: number
  onSeekRatio?: (ratio: number) => void
}) {
  const [internalRatio, setInternalRatio] = useState(0.28)
  const ratio = controlledRatio ?? internalRatio
  const currentSec = Math.round(ratio * duration)

  const setRatio = (next: number) => {
    const clamped = Math.max(0, Math.min(1, next))
    setInternalRatio(clamped)
    onSeekRatio?.(clamped)
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight") {
      event.preventDefault()
      setRatio(ratio + 0.05)
    } else if (event.key === "ArrowLeft") {
      event.preventDefault()
      setRatio(ratio - 0.05)
    } else if (event.key === "Home") {
      event.preventDefault()
      setRatio(0)
    } else if (event.key === "End") {
      event.preventDefault()
      setRatio(1)
    }
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
        aria-label={compact ? "Stem waveform position" : "Track playback position"}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={currentSec}
        aria-valuetext={`${formatTime(currentSec)} of ${formatTime(duration)}`}
        onKeyDown={handleKeyDown}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          if (rect.width > 0) {
            setRatio((event.clientX - rect.left) / rect.width)
          }
        }}
      >
        {(peaks ? peaks.map(peak => Math.max(1, Math.min(100, peak * 100))) : bars(seed, compact ? 52 : 96)).map((height, i) => (
          <i key={i} style={{ height: `${height}%` }} />
        ))}
        <span className="playhead" style={{ left: `${ratio * 100}%` }} />
      </div>
    </div>
  )
}

function freqToX(freqHz: number): number {
  const minLog = Math.log10(20)
  const maxLog = Math.log10(20000)
  const clamped = Math.max(20, Math.min(20000, freqHz))
  return ((Math.log10(clamped) - minLog) / (maxLog - minLog)) * 100
}

function gainToY(gainDb: number): number {
  const clamped = Math.max(-15, Math.min(15, gainDb))
  return 30 - (clamped / 15) * 24
}

export function SpectrumChart({
  seed,
  eqBands,
  activeBandId,
  onSelectBand,
}: {
  seed: number
  eqBands?: readonly EQBandParams[]
  activeBandId?: EQBandId
  onSelectBand?: (bandId: EQBandId) => void
}) {
  const gradientId = useId()
  const basePoints = Array.from({ length: 25 }, (_, i) => {
    const x = (i / 24) * 100
    const freq = 20 * Math.pow(1000, i / 24)
    const baseY = eqBands ? 30 : 38 - ((seed * (i + 2) * 7 + i * 11) % 20)
    const eqDb = eqBands ? computeEqMagnitudeDb(freq, eqBands, 48000) : 0
    const y = Math.max(4, Math.min(56, baseY - eqDb * 1.4))
    return `${x.toFixed(2)},${y.toFixed(2)}`
  }).join(" ")

  const summaryText = eqBands
    ? eqBands
        .map(
          (b) =>
            `${b.label} (${b.freqHz} Hz): ${b.gainDb >= 0 ? "+" : ""}${b.gainDb.toFixed(1)} dB`,
        )
        .join(", ")
    : "Tonal balance across 20 Hz to 20 kHz"

  return (
    <div className="spectrum">
      <div className="chart-label">
        <span>{eqBands ? "Approximate EQ response" : "Illustrative tonal curve"}</span>
        <span>20 Hz — 20 kHz</span>
      </div>
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
        <polygon points={`0,60 ${basePoints} 100,60`} fill={`url(#${gradientId})`} />
        <polyline
          points={basePoints}
          fill="none"
          stroke="var(--clay)"
          strokeWidth="1.4"
          vectorEffect="non-scaling-stroke"
        />
        {eqBands?.map((band) => {
          const cx = freqToX(band.freqHz)
          const cy = gainToY(band.gainDb)
          const isSelected = activeBandId === band.id
          return (
            <circle
              key={band.id}
              cx={cx}
              cy={cy}
              r={isSelected ? 2.6 : 1.9}
              fill={band.enabled ? "var(--clay)" : "var(--ink-soft)"}
              stroke="var(--paper)"
              strokeWidth="0.8"
              style={{ cursor: onSelectBand ? "pointer" : "default" }}
              onClick={() => {
                onSelectBand?.(band.id)
              }}
            />
          )
        })}
      </svg>
      <div className="axis">
        <span>Sub</span>
        <span>Low</span>
        <span>Mid</span>
        <span>Presence</span>
        <span>Air</span>
      </div>
    </div>
  )
}

export function DeepTimeline({
  script,
  onSelect,
}: {
  script: MasteringScript
  onSelect: (move: Move) => void
}) {
  const lanes: MoveLane[] = [
    "Volume",
    "EQ",
    "Comp/Sat",
    "Width",
    "AI Repair",
  ]
  const firstFinding = script.findings[0]
  return (
    <div className="deep-summary">
      <div className="deep-summary-head">
        <span>Script v{script.version}</span>
        <span>
          {script.sections.length} sections · {script.moves.length} moves
        </span>
      </div>
      <div className="section-strip" aria-label="Detected song sections">
        {script.sections.map((section) => (
          <span key={section.id} style={{ flex: section.end - section.start }}>
            {section.type}
          </span>
        ))}
      </div>
      <div className="lane-table">
        {lanes.map((lane) => (
          <div className="lane" key={lane}>
            <strong>{lane}</strong>
            <div className="lane-track">
              {script.moves
                .filter((move) => move.lane === lane)
                .map((move) => {
                  const stateBadge = move.muted
                    ? " (Muted)"
                    : move.edited
                      ? " (Edited)"
                      : ""
                  return (
                    <button
                      type="button"
                      key={move.id}
                      className={`${move.edited ? "is-edited" : ""} ${
                        move.muted ? "is-muted" : ""
                      }`.trim()}
                      style={{
                        left: `${(move.start / script.duration) * 100}%`,
                        width: `${((move.end - move.start) / script.duration) * 100}%`,
                      }}
                      onClick={() => {
                        onSelect(move)
                      }}
                      aria-label={`Edit ${move.parameter}${stateBadge}`}
                      title={`${move.parameter}: ${move.value.toFixed(1)}${stateBadge}`}
                    >
                      <span className="lane-pill" aria-hidden="true">
                        {move.muted ? "M" : move.edited ? "E" : move.value.toFixed(1)}
                      </span>
                    </button>
                  )
                })}
            </div>
          </div>
        ))}
      </div>
      {firstFinding !== undefined && (
        <div className="finding">
          <Icon name="circle-alert" />
          <span>
            <strong>Artifact indicator</strong>
            <small>
              {firstFinding.stem}: {Math.round(firstFinding.confidence * 100)}%
              confidence. This is a spectral heuristic, not proof of AI
              generation.
            </small>
          </span>
        </div>
      )}
    </div>
  )
}
