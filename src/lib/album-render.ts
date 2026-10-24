import { albumLinearParams } from "./album-consistency";
import { measureAudio, measureScriptAudio, serverRenderOwned } from "./browser-engine";
import { getAudio } from "./db";
import { inspectEncodedWAV } from "./encoded-inspection";
import { encodedWAVBytes } from "./encoded-layout";
import { analyzeSourceFeatures, type FeatureMeasurements } from "./feature-analysis";
import { qualifyProcessingBuild } from "./processing-build";
import { assertExpectedProcessingBuild, ProcessingBuildMismatchError } from "./processing-identity";
import { verifyCanonicalSource } from "./project-import";
import type { AlbumMemoryFactory } from "./album-batch";
import type { AlbumTrackRecipe } from "./album-binding";
import type { OwnedAudioResult } from "./browser-jobs";

export interface AlbumRenderContext {
  reserve: AlbumMemoryFactory; processingBuild: string; signal: AbortSignal; check: () => void;
}
/** Missing or changed source bytes invalidate the complete cohort, including its prefix. */
export class AlbumSourceMismatchError extends Error {
  constructor(title: string, cause?: unknown) {
    super(`The source for “${title}” is missing or changed. Restore its matching source in Library and plan the complete album again.`, { cause });
    this.name = "AlbumSourceMismatchError";
  }
}
function assertLayout(actual: { frames: number; sampleRate: number }, expected: { frames: number; sampleRate: number }): void {
  if (actual.frames !== expected.frames || actual.sampleRate !== expected.sampleRate) throw new Error("A rendered track changed its sample count or sample rate. No new master was retained.");
}
function canonicalSize(recipe: AlbumTrackRecipe): number {
  assertLayout(recipe.encoding, recipe.source);
  return encodedWAVBytes({ frames: recipe.source.frames, sampleRate: recipe.source.sampleRate, bitDepth: 32 });
}
async function confirmBuild(ctx: AlbumRenderContext): Promise<void> {
  ctx.check(); assertExpectedProcessingBuild(ctx.processingBuild);
  try {
    if (await qualifyProcessingBuild(ctx.signal) !== ctx.processingBuild) throw new ProcessingBuildMismatchError();
  } catch (cause) {
    ctx.signal.throwIfAborted();
    throw cause instanceof ProcessingBuildMismatchError ? cause : new ProcessingBuildMismatchError(cause);
  }
  ctx.check();
}
async function withVerifiedSource<T>(recipe: AlbumTrackRecipe, ctx: AlbumRenderContext, consume: (blob: Blob) => Promise<T>): Promise<T> {
  ctx.check();
  const bytes = canonicalSize(recipe), owner = ctx.reserve(bytes * 3);
  let blob: Blob | null = null;
  try {
    blob = await getAudio(recipe.audioKey) ?? null; ctx.check();
    if (!blob || blob.size !== bytes) throw new AlbumSourceMismatchError(recipe.title);
    try { await verifyCanonicalSource(blob, recipe.source, ctx.signal); }
    catch (cause) { ctx.signal.throwIfAborted(); throw new AlbumSourceMismatchError(recipe.title, cause); }
    ctx.check(); owner.update(bytes);
    // The consumer settles before this source reference and its lease are released.
    return await consume(blob);
  } finally { blob = null; owner.dispose(); }
}
/** Fresh immutable-key verification without a caller-side decoded master. */
export async function verifyAlbumTrackSource(recipe: AlbumTrackRecipe, ctx: AlbumRenderContext): Promise<void> {
  await withVerifiedSource(recipe, ctx, () => Promise.resolve(undefined)); ctx.check();
}
/** First pass measures the accepted chain without retaining a float master. */
export async function measureAlbumTrack(recipe: AlbumTrackRecipe, ctx: AlbumRenderContext) {
  const measured = await withVerifiedSource(recipe, ctx, async (blob) => {
    await confirmBuild(ctx);
    const result = recipe.script ? await measureScriptAudio(blob, recipe.script, ctx.signal, ctx.processingBuild)
      : await measureAudio(blob, recipe.params, ctx.signal, ctx.processingBuild);
    ctx.check(); assertLayout(result, recipe.source); return result;
  });
  // Reload from the immutable key after processing; do not keep the original Blob alive.
  await withVerifiedSource(recipe, ctx, () => Promise.resolve(undefined)); ctx.check();
  return measured;
}
function assertBands(bands: FeatureMeasurements["bands"]): void {
  const edges = [20, 120, 500, 2000, 6000, 20000];
  if (bands.length !== 5 || bands.some((band, index) => band.lowHz !== edges.at(index) || band.highHz !== edges.at(index + 1)
    || !Number.isFinite(band.usableHighHz) || !Number.isFinite(band.powerDb) || typeof band.valid !== "boolean"
    || band.usableHighHz < band.lowHz || band.usableHighHz > band.highHz)) throw new Error("The final audio features contain invalid spectral coverage.");
}
/** One frozen packet remains the authority for every full-chain phase. Only final encoded ownership escapes. */
export async function renderAlbumTrack(recipe: AlbumTrackRecipe, gainDb: number, ctx: AlbumRenderContext) {
  const canonicalBytes = canonicalSize(recipe), gain = albumLinearParams(gainDb);
  let chain: OwnedAudioResult | null = null, master: OwnedAudioResult | null = null, canonical: OwnedAudioResult | null = null;
  try {
    chain = await withVerifiedSource(recipe, ctx, async (blob) => {
      await confirmBuild(ctx);
      return serverRenderOwned(blob, recipe.script ? { script: recipe.script } : { params: recipe.params },
        { frames: recipe.source.frames, sampleRate: recipe.source.sampleRate, bitDepth: 32 }, ctx.signal, ctx.processingBuild);
    });
    ctx.check(); chain.owner.update(canonicalBytes * 3);
    await inspectEncodedWAV(chain.blob, 32, recipe.source, ctx.signal); ctx.check(); chain.owner.update(canonicalBytes);
    await confirmBuild(ctx);
    master = await serverRenderOwned(chain.blob, { params: gain },
      { frames: recipe.source.frames, sampleRate: recipe.source.sampleRate, bitDepth: 24 }, ctx.signal, ctx.processingBuild);
    ctx.check();
    const chainOwner = chain.owner; chain = null; chainOwner.dispose();
    const encodedBytes = encodedWAVBytes({ frames: recipe.source.frames, sampleRate: recipe.source.sampleRate, bitDepth: 24 });
    master.owner.update(encodedBytes * 3);
    const output = await inspectEncodedWAV(master.blob, 24, recipe.source, ctx.signal); ctx.check(); master.owner.update(encodedBytes);
    await confirmBuild(ctx);
    const measured = await measureAudio(master.blob, { bypass: true }, ctx.signal, ctx.processingBuild);
    ctx.check(); assertLayout(measured, recipe.source);
    await confirmBuild(ctx);
    canonical = await serverRenderOwned(master.blob, { params: { bypass: true } },
      { frames: recipe.source.frames, sampleRate: recipe.source.sampleRate, bitDepth: 32 }, ctx.signal, ctx.processingBuild);
    ctx.check(); canonical.owner.update(canonicalBytes * 3);
    await inspectEncodedWAV(canonical.blob, 32, recipe.source, ctx.signal); ctx.check(); canonical.owner.update(canonicalBytes);
    await confirmBuild(ctx);
    const features = await analyzeSourceFeatures(canonical.blob, ctx.signal, () => undefined, ctx.processingBuild);
    ctx.check(); assertLayout(features.source, recipe.source); assertBands(features.bands);
    canonical.owner.update(canonicalBytes * 3);
    await verifyCanonicalSource(canonical.blob, features.source, ctx.signal); ctx.check();
    const canonicalOwner = canonical.owner; canonical = null; canonicalOwner.dispose();
    await withVerifiedSource(recipe, ctx, () => Promise.resolve(undefined)); ctx.check();
    const result = { master, output, metrics: measured.afterMetrics, bands: features.bands };
    master = null; return result;
  } finally {
    const owners = [chain?.owner, canonical?.owner, master?.owner];
    chain = null; canonical = null; master = null;
    for (const owner of owners) owner?.dispose();
  }
}
