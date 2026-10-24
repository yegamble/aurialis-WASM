"""One QA-parent absolute clock, narrowed for startup/work/cleanup observations."""
import math
import time

_absolute = None
_phase = None


def configure(absolute):
    global _absolute, _phase
    if absolute is not None and (not isinstance(absolute, (int, float)) or not math.isfinite(absolute)):
        raise RuntimeError("Finite qualification deadline required")
    _absolute = absolute
    _phase = absolute


def phase(deadline):
    global _phase
    previous = _phase
    _phase = min(deadline, _absolute) if _absolute is not None else deadline
    return previous


def remaining(maximum):
    if maximum <= 0: raise RuntimeError("Qualification phase/absolute deadline exhausted")
    if _phase is None:
        return maximum
    value = min(maximum, _phase - time.monotonic())
    if value <= 0:
        raise RuntimeError("Qualification phase/absolute deadline exhausted")
    return value
