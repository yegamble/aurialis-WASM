import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AlbumLevelChart } from "../shared/AlbumLevelChart";

afterEach(cleanup);

const master = (id: string) => ({ id, title: id, measured: { integratedLufs: -14, truePeakDbtp: -1 }, requestedLufs: null });

it("keeps a short album's bars bar-sized and centered instead of stretching them across the chart", () => {
  const { container } = render(<AlbumLevelChart masters={[master("one")]} />);
  const width = Number(container.querySelector("svg")?.getAttribute("viewBox")?.split(" ")[2]);
  const bar = container.querySelector("rect");
  const x = Number(bar?.getAttribute("x")), barWidth = Number(bar?.getAttribute("width"));
  expect(barWidth / width).toBeLessThanOrEqual(0.2);
  expect(x + barWidth / 2).toBeCloseTo(width / 2);
});

it("gives every master its own slot once the album fills the chart", () => {
  const masters = Array.from({ length: 9 }, (_, index) => master(`track-${String(index)}`));
  const { container } = render(<AlbumLevelChart masters={masters} />);
  expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 360 160");
  expect(container.querySelectorAll("rect")).toHaveLength(9);
});

it("reports a silent master as silent and keeps the scale set by the audible masters", () => {
  const silent = { id: "silent", title: "Room tone", measured: { integratedLufs: -70, truePeakDbtp: -133.67 }, requestedLufs: null };
  const { getByRole } = render(<AlbumLevelChart masters={[master("loud"), silent]} />);
  const row = getByRole("row", { name: /Room tone/ });
  expect(row.textContent).toContain("Silent");
  expect(row.textContent).not.toContain("133");
  const quiet = { ...master("quiet"), measured: { integratedLufs: -20, truePeakDbtp: -6 } };
  const heights = (masters: Parameters<typeof AlbumLevelChart>[0]["masters"]) => {
    const view = render(<AlbumLevelChart masters={masters} />);
    const values = Array.from(view.container.querySelectorAll("rect")).map((bar) => Number(bar.getAttribute("height")));
    view.unmount();
    return values;
  };
  cleanup();
  // A silent master must not drag the floor to −137 and flatten the audible bars together.
  expect(heights([master("loud"), quiet, silent]).slice(0, 2)).toEqual(heights([master("loud"), quiet]));
});
