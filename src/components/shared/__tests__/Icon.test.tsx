import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { Icon, type IconName } from "../Icon"

describe("Icon custom inline SVG primitive", () => {
  const allNames: IconName[] = [
    "album",
    "arrow-down-to-line",
    "arrow-left",
    "arrow-right",
    "audio-lines",
    "check",
    "chevron-down",
    "circle-alert",
    "clock",
    "disc",
    "file-audio",
    "gauge",
    "headphones",
    "library",
    "menu",
    "more-horizontal",
    "pause",
    "play",
    "plus",
    "refresh-cw",
    "rotate-ccw",
    "scissors",
    "search",
    "settings",
    "sliders-horizontal",
    "sparkles",
    "trash",
    "upload",
    "wand-sparkles",
    "x",
  ]

  it("renders every hand-crafted inline SVG icon without external libraries", () => {
    for (const name of allNames) {
      const { container, unmount } = render(<Icon name={name} title={name} />)
      const svg = container.querySelector("svg")
      expect(svg).not.toBeNull()
      expect(svg?.getAttribute("role")).toBe("img")
      unmount()
    }
  })
})
