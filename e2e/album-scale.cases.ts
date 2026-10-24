/* Paths belong to the bounded Playwright fixture/artifact scope, never audio filenames. */
/* eslint-disable security/detect-non-literal-fs-filename */
import { expect, test, type BrowserContext } from "@playwright/test";
import { scaleNetworkObservation } from "../scripts/qualification/network-observation.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { observeAlbum, workspace, openAlbum, report } from "./album-cases";
import { beforeOwnedWork, admitDisk, scaleSource, canonicalBytes, totalEncodedBytes, memoryProfile, retainScaleDownload } from "./album-scale-tools";

const inventories = new WeakMap<BrowserContext, ReturnType<typeof scaleNetworkObservation>>();
test.afterEach(async ({ context }, info) => {
  const observation = inventories.get(context);
  if (observation) {
    observation.close();
    await info.attach("network-inventory.json", { body: observation.serialize(info.status === "passed"), contentType: "application/json" });
    observation.assert();
  }
});

test("three real 180-second 48 kHz tracks use bounded durable delivery beyond the old aggregate cache", async ({ page, context }, info) => {
  test.setTimeout(1_800_000); await observeAlbum(page); await memoryProfile(page, 8);
  const directory = resolve(process.env.AURIALIS_ALBUM_SCALE_SOURCES ?? "artifacts/album-scale-shared-sources"); await mkdir(info.outputDir, { recursive: true });
  const observation = scaleNetworkObservation(context); inventories.set(context, observation); const network = observation.requests;
  const sources = [], disk = [];
  for (let index = 0; index < 3; index++) {
    const source = await scaleSource(directory, index); sources.push(source); disk.push(await admitDisk(info.outputDir, canonicalBytes * 2));
    await page.goto("/"); await beforeOwnedWork(); await page.getByLabel("Upload audio file").setInputFiles(source.path); await expect(page).toHaveURL(/\/master\/track-/u, { timeout: 130_000 }); await expect(page.getByRole("button", { name: "A Processed", exact: true })).toBeEnabled({ timeout: 130_000 });
    const track = (await workspace(page)).tracks.find((item) => item.title === `source ${String(index)}`); expect(track?.sourceIdentity).toEqual({ pcmHash: source.pcmHash, sampleRate: 48000, frames: source.frames });
  }
  const original = (await workspace(page)).tracks; await openAlbum(page, ["source 0", "source 1", "source 2"]); await page.getByRole("combobox", { name: "Album target", exact: true }).selectOption("-18"); disk.push(await admitDisk(info.outputDir, totalEncodedBytes * 2));
  await beforeOwnedWork(); await page.getByRole("button", { name: "Render album masters", exact: true }).click(); await expect(page.getByText("3 of 3 verified masters.", { exact: true })).toBeVisible({ timeout: 1_200_000 }); await expect(page.getByRole("button", { name: "Render album masters", exact: true })).toBeEnabled();
  const first = await report(page); expect(first.complete).toBe(true); expect(first.tracks.reduce((sum, row) => sum + row.output.bytes, 0)).toBe(totalEncodedBytes); expect(totalEncodedBytes).toBeGreaterThan(128 * 1024 * 1024); const files = [];
  for (const [index, row] of first.tracks.entries()) files.push(await retainScaleDownload(page, info, row, index, true));
  await page.getByRole("button", { name: "Save album report", exact: true }).click(); await expect.poll(async () => (await workspace(page)).albums[0]?.report?.bindingHash).toBe(first.bindingHash); await page.reload(); await expect(page.getByRole("region", { name: "Rendered album downloads" })).toBeVisible(); await expect(page.getByRole("button", { name: /^Download source /u })).toHaveCount(0);
  const authorizedBeforeAll: string[] = []; const observer = page.evaluate(() => {
    const violations: string[] = []; (window as Window & { albumEarlyAuthority?: string[] }).albumEarlyAuthority = violations;
    new MutationObserver(() => { if (document.body.textContent.includes("Verifying stored master")) { const downloads = Array.from(document.querySelectorAll("button")).filter((button) => /^Download source /u.test(button.textContent)); if (downloads.length) violations.push("Output appeared during incomplete stored-prefix verification"); } }).observe(document.body, { childList: true, subtree: true });
  }); await observer;
  await beforeOwnedWork(); await page.getByRole("button", { name: "Render album masters", exact: true }).click(); await expect(page.getByText("3 of 3 verified masters.", { exact: true })).toBeVisible({ timeout: 1_200_000 }); await expect(page.getByRole("button", { name: "Render album masters", exact: true })).toBeEnabled();
  const recovered = await report(page); expect(recovered.tracks.map((row) => row.output)).toEqual(first.tracks.map((row) => row.output)); authorizedBeforeAll.push(...await page.evaluate(() => (window as Window & { albumEarlyAuthority?: string[] }).albumEarlyAuthority ?? [])); expect(authorizedBeforeAll).toEqual([]);
  const repeated = []; for (const [index, row] of recovered.tracks.entries()) repeated.push(await retainScaleDownload(page, info, row, index, false)); expect((await workspace(page)).tracks).toEqual(original);
  if (info.project.name === "album-browser-scale") { expect(network.filter((entry) => !["GET", "HEAD"].includes(entry.method) || entry.bytes)).toEqual([]); expect(network.every((entry) => new URL(entry.url).origin === new URL(page.url()).origin)).toBe(true); }
  const expected = resolve(directory, "native-output-hashes.json"), hashes = files.map((file) => file.sha256);
  if (info.project.name === "album-native-scale") await writeFile(expected, JSON.stringify(hashes)); else expect(hashes).toEqual(JSON.parse(await readFile(expected, "utf8")));
  observation.assert();
  const receipt = JSON.stringify({ policyProfile: 8, physical8GBQualified: false, first, recovered, sources, files, repeated, authorizedBeforeAll, disk, network });
  if (Buffer.byteLength(receipt) > 1024 * 1024) throw new Error("Full Album QA receipt exceeds its 1 MiB publication allowance");
  await info.attach("full-album-delivery.json", { body: receipt, contentType: "application/json" });
});
