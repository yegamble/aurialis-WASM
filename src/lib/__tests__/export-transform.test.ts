import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readScriptV2 } from "../deep-mastering";
import { exportScript } from "../engine-params";

// S5 cross-layer parity: Go writes this golden (go test ./internal/mastering -run
// TestExportTransform -update) from the transform its Deep prediction renders.
const golden = JSON.parse(readFileSync("internal/mastering/testdata/export-transform.golden.json", "utf8")) as { name: string; input: unknown; export: unknown }[];

describe("export transform parity with the Go prediction", () => {
  it("covers a plain proposal and one with input dither", () => {
    expect(golden.map((item) => item.name)).toEqual(["proposal", "input dither"]);
  });
  it.each(golden)("maps the golden $name case to exactly the script Go predicts", ({ input: raw, export: expected }) => {
    const input = readScriptV2(raw);
    expect(input).toEqual(raw);
    expect(exportScript(input)).toEqual(expected);
    expect(input.chainParams.limiter.truePeak).toBe(false);
  });
});
