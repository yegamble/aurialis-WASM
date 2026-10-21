import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { decode, fixture } from "./audio-fixture";

type Parameters = Record<string, unknown>;

// Independent stereo bursts expose frequency, envelope and stereo changes.
function controlFixture() {
  const wav = fixture(1000, 2);
  for (let i = 0; i < 96000; i++) {
    const time = i / 48000;
    const envelope = i % 8192 < 3072 ? 0.85 : 0.08;
    for (const [channel, phase] of [[0, 0], [1, 1]] as const) {
      const sample = envelope * (
        0.30 * Math.sin(2 * Math.PI * 80 * time + phase * 0.9)
        + 0.25 * Math.sin(2 * Math.PI * 997 * time + phase * 0.3)
        + 0.15 * Math.sin(2 * Math.PI * 7000 * time + phase * 1.2)
      );
      wav.writeInt16LE(Math.round(sample * 32767), 44 + i * 4 + channel * 2);
    }
  }
  return wav;
}

function changedFields(before: Parameters, after: Parameters, prefix = ""): string[] {
  return Object.keys(before).flatMap((key) => {
    const a = before[key];
    const b = after[key];
    if (typeof a === "object" && a !== null && typeof b === "object" && b !== null)
      return changedFields(a as Parameters, b as Parameters, `${prefix}${key}.`);
    return a === b ? [] : [`${prefix}${key}`];
  });
}

// Inspect the actual bundled UI's request and download, without reusing its
// parameter mapping or DSP to construct the expected samples.
async function exported(page: Page) {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "32-bit Float", exact: true }).click();
  const responsePending = page.waitForResponse((response) => response.url().endsWith("/api/master/render") && response.request().method() === "POST");
  const downloadPending = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click();
  const response = await responsePending;
  expect(response.status()).toBe(200);
  const request = response.request();
  const body = request.postDataBuffer();
  if (!body) throw new Error("Missing native render request");
  const form = await new Response(new Uint8Array(body), {
    headers: { "Content-Type": request.headers()["content-type"] ?? "" },
  }).formData();
  const raw = form.get("params");
  if (typeof raw !== "string") throw new Error("Missing native render parameters");
  const params = JSON.parse(raw) as Parameters;
  const download = await downloadPending;
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  if (!path) throw new Error("Missing native WAV download");
  const pcm = decode(await readFile(path));
  expect(pcm.bits).toBe(32);
  expect(pcm.rate).toBe(48000);
  expect(pcm.left).toHaveLength(96000);
  expect(pcm.right).toHaveLength(96000);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  return { params, pcm };
}

test("all 31 visible audio controls independently change actual exported PCM", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await page.goto("/");
  await page.getByLabel("Upload audio file").setInputFiles({ name: "qa-control-bursts.wav", mimeType: "audio/wav", buffer: controlFixture() });
  await expect(page).toHaveURL(/\/master\/track-/, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Export", exact: true })).toBeEnabled({ timeout: 30_000 });
  const results: { name: string; changes: string[]; maximumSampleDifference: number }[] = [];
  const slider = (name: string, value: number) => () => page.getByRole("slider", { name, exact: true }).fill(String(value));
  const toggle = (name: string) => () => page.getByLabel(name, { exact: true }).click();
  const reset = () => page.getByRole("button", { name: "Reset modules", exact: true }).click();
  async function check(name: string, action: () => Promise<unknown>, expected: string[]) {
    await test.step(name, async () => {
      const before = await exported(page);
      await action();
      const after = await exported(page);
      const changes = changedFields(before.params, after.params).sort();
      expect(changes, `${name} changed unrelated native parameters`).toEqual(expected.sort());
      let maximumSampleDifference = 0;
      for (const channel of ["left", "right"] as const) {
        for (let i = 0; i < before.pcm[channel].length; i++)
          maximumSampleDifference = Math.max(maximumSampleDifference, Math.abs(before.pcm[channel][i]! - after.pcm[channel][i]!));
      }
      expect(maximumSampleDifference, `${name} had no measured PCM effect`).toBeGreaterThan(1e-5);
      results.push({ name, changes, maximumSampleDifference });
    });
  }
  await check("Input gain", slider("Input gain", 3), ["inputGainDb"]);
  for (const [index, band] of ["Sub", "Low", "Mid", "Presence", "Air"].entries()) {
    await reset();
    await page.getByRole("tab", { name: band, exact: true }).click();
    await check(`${band} gain`, slider(`${band} gain`, 6), [`bands.${index}.gainDb`]);
    const frequency = Number(await page.getByRole("slider", { name: `${band} frequency`, exact: true }).inputValue());
    await check(`${band} frequency`, slider(`${band} frequency`, Math.min(18000, Math.round(frequency * 1.5 / 10) * 10)), [`bands.${index}.freqHz`]);
    await check(`${band} Q`, slider(`${band} Q`, 3), [`bands.${index}.q`]);
  }
  await check("EQ enable", toggle("Enable EQ"), ["eqEnabled"]);
  await reset();
  await slider("Ratio", 3)();
  await slider("Threshold", -20)();
  await check("Compressor threshold", slider("Threshold", -30), ["compressor.thresholdDb"]);
  await check("Compressor ratio", slider("Ratio", 6), ["compressor.ratio"]);
  await check("Compressor attack", slider("Attack", 80), ["compressor.attackMs"]);
  await check("Compressor release", slider("Release", 450), ["compressor.releaseMs"]);
  await check("Compressor enable", toggle("Enable compressor"), ["compressor.enabled"]);
  await reset();
  await check("Saturation drive", slider("Saturation", 30), ["saturation.amount"]);
  await check("Saturation Thick", () => page.getByRole("button", { name: "Thick", exact: true }).click(), ["saturation.character"]);
  await check("Saturation Crisp", () => page.getByRole("button", { name: "Crisp", exact: true }).click(), ["saturation.character"]);
  await check("Saturation enable", toggle("Enable saturation"), ["saturation.enabled"]);
  await reset();
  await check("Stereo width", slider("Stereo width", 150), ["stereo.widthPct"]);
  await check("Mono bass", toggle("Mono bass below 110 Hz"), ["stereo.monoBass"]);
  await check("Stereo enable", toggle("Enable stereo"), ["stereo.enabled"]);
  await reset();
  await slider("Input gain", 6)();
  await slider("Limiter ceiling", -3)();
  await check("Limiter enable", toggle("Enable limiter"), ["limiter.enabled"]);
  await check("Limiter ceiling", slider("Limiter ceiling", -1), ["limiter.ceilingDbtp"]);
  expect(results).toHaveLength(31);
  await testInfo.attach("independent-audio-controls", { body: JSON.stringify(results, null, 2), contentType: "application/json" });
});
