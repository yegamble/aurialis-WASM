// Hosted-Linux audio-backend probe. Uses a real Firefox AudioContext and clock;
// the product matrix separately verifies speaker energy and processed PCM.
import { firefox } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

const phase = process.argv[2];
assert.ok(phase === "before" || phase === "after", "choose before or after provisioning");
const directory = process.env.AURIALIS_AUDIO_DIAGNOSTICS ?? "artifacts/browser-engines";
await mkdir(directory, { recursive: true });
const diagnostics = { phase, platform: process.platform, console: [], errors: [], samples: [] };
const browser = await firefox.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.on("console", (message) => diagnostics.console.push({ type: message.type(), text: message.text() }));
  page.on("pageerror", (error) => diagnostics.errors.push(error.message));
  await page.setContent('<button type="button">Start audio clock</button>');
  await page.evaluate(() => {
    document.querySelector("button").onclick = () => {
      const context = new AudioContext({ sampleRate: 48000 });
      const oscillator = context.createOscillator(), gain = context.createGain();
      gain.gain.value = 0; oscillator.connect(gain); gain.connect(context.destination); oscillator.start();
      window.audioProbe = { context, resume: "pending" };
      void context.resume().then(() => { window.audioProbe.resume = "resolved"; }, (error) => { window.audioProbe.resume = String(error); });
    };
  });
  await page.getByRole("button", { name: "Start audio clock" }).click();
  // Observe a bounded real wall-clock interval even when resume never settles.
  const started = performance.now();
  do {
    diagnostics.samples.push(await page.evaluate(() => {
      const probe = window.audioProbe;
      return { state: probe.context.state, time: probe.context.currentTime, sampleRate: probe.context.sampleRate, resume: probe.resume };
    }));
    const sample = diagnostics.samples.at(-1);
    if (sample.state === "running" && sample.resume === "resolved" && sample.time > 0.1) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (performance.now() - started < 5000);
  const last = diagnostics.samples.at(-1);
  diagnostics.available = last.state === "running" && last.resume === "resolved" && last.time > 0.1;
  await page.evaluate(() => { void window.audioProbe.context.close(); });
} finally {
  await browser.close();
  await writeFile(`${directory}/firefox-audio-${phase}.json`, JSON.stringify(diagnostics, null, 2));
  console.log(JSON.stringify(diagnostics));
}
if (phase === "after") assert.equal(diagnostics.available, true, "Firefox must advance a real AudioContext clock after CI audio provisioning");
