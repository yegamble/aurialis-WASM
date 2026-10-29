/* Test-owned download paths never originate in audio filenames. */
/* eslint-disable security/detect-non-literal-fs-filename */
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { decode, fixture } from "./audio-fixture";
import { uploadProject } from "./workflow-fixture";

type ReferenceReply = { status?: string; error?: unknown; referenceProposal?: { baseline: { algorithmVersion: number }; params: { algorithmVersion: number }; width?: { applied: boolean } } };
for (const [quality, algorithm] of [["Classic", 2], ["Oversampled", 3]] as const) {
  test(`Reference measures and applies the actual ${quality} export chain`, async ({ page }, info) => {
    test.setTimeout(60_000); const replies: ReferenceReply[] = [];
    page.on("response", (response) => {
      if (response.request().method() !== "GET" || !new URL(response.url()).pathname.startsWith("/api/jobs/")) return;
      void response.json().then((reply: ReferenceReply) => { if (reply.referenceProposal || reply.status === "failed") replies.push(reply); }).catch(() => undefined);
    });
    const id = await uploadProject(page, "reference-source.wav", 1, fixture(997, 1));
    await page.getByRole("button", { name: quality, exact: true }).click();
    const reference = await uploadProject(page, "reference-target.wav", 1, fixture(2800, 1));
    await page.goto(`/reference/${id}`); await page.getByRole("combobox", { name: "Reference track", exact: true }).selectOption(reference);
    await page.getByRole("checkbox", { name: "Include width", exact: true }).check();
    await page.getByRole("button", { name: "Analyze reference audio", exact: true }).click();
    try {
      await expect.poll(async () => {
        const errors = (await page.getByRole("alert").allTextContents()).filter(Boolean); if (errors.length) throw new Error(errors.join("; "));
        return page.getByRole("button", { name: "Apply measured proposal", exact: true }).isEnabled();
      }, { timeout: 30_000 }).toBe(true);
      await expect.poll(() => replies.find((reply) => reply.referenceProposal)?.referenceProposal?.baseline.algorithmVersion).toBe(algorithm);
      expect(replies.find((reply) => reply.referenceProposal)?.referenceProposal?.params.algorithmVersion).toBe(algorithm);
      expect(replies.find((reply) => reply.referenceProposal)?.referenceProposal?.width).toBeDefined();
      await page.getByRole("button", { name: "Apply measured proposal", exact: true }).click();
      await expect(page.getByText(/Measured proposal applied/u)).toBeVisible();
      await page.goto(`/master/${id}`);
      await page.getByRole("button", { name: "Export", exact: true }).click();
      const dialog = page.getByRole("dialog"); await dialog.getByRole("button", { name: "32-bit Float", exact: true }).click();
      const pending = page.waitForEvent("download"); await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click();
      const path = await (await pending).path(); if (!path) throw new Error("Missing measured Reference export");
      const delivered = decode(await readFile(path)); expect(delivered.rate).toBe(48000); expect(delivered.left).toHaveLength(48000);
      await info.attach("selected-reference-algorithm", { body: JSON.stringify({ quality, algorithm, frames: delivered.left.length, replies }), contentType: "application/json" });
    } finally { console.log("REFERENCE DIAGNOSTICS", JSON.stringify({ quality, alerts: (await page.getByRole("alert").allTextContents()).filter(Boolean), replies })); }
  });
}
