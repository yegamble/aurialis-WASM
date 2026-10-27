import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readScriptV2 } from "../deep-mastering";
import { exportScript } from "../engine-params";

// S5 cross-layer parity: Go writes this golden (go test ./internal/mastering -run
// TestExportTransform -update) from the transform its Deep prediction renders.
const golden = JSON.parse(readFileSync("internal/mastering/testdata/export-transform.golden.json", "utf8")) as { input: unknown; export: unknown };

describe("export transform parity with the Go prediction", () => {
  it("maps the golden proposal to exactly the script Go predicts", () => {
    const input = readScriptV2(golden.input);
    expect(input).toEqual(golden.input);
    expect(exportScript(input)).toEqual(golden.export);
    expect(input.chainParams.limiter.truePeak).toBe(false);
  });
});
