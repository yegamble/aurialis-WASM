import { compileScript, readScriptV2, type ScriptV2 } from "./deep-mastering";
import { packLiveControls } from "./live-controls";
import type { SourceIdentity } from "./types";
import { verifyCanonicalSource } from "./project-import";

/** Preparation stays on the main thread. The worklet receives fixed numeric slots only. */
export async function prepareLiveAutomation(script: ScriptV2, blob: Blob, deviceRate: number, signal: AbortSignal) {
  const validated = readScriptV2(script);
  await verifyCanonicalSource(blob, validated.source, signal);
  const compiled = await compileScript(validated, deviceRate, signal);
  signal.throwIfAborted();
  const source = await verifiedSourceVector(blob, validated.source, signal);
  const moves = new Float64Array(compiled.moves.length * 516);
  for (let index = 0; index < compiled.moves.length; index++) {
    const move = compiled.moves.at(index); if (!move) throw new Error("The compiled schedule is incomplete.");
    const offset = index * 516;
    moves.set([move.target, move.points.length, move.fadeFrames, Number(move.muted)], offset);
    for (let point = 0; point < move.points.length; point++) { const item = move.points.at(point); if (item) moves.set([item.frame, item.value], offset + 4 + point * 2); }
  }
  return { source, controls: packLiveControls(compiled.baseline, 2), moves, moveCount: compiled.moves.length, revision: compiled.revision, deviceRate: compiled.deviceRate };
}

export async function verifiedSourceVector(blob: Blob, identity: SourceIdentity, signal: AbortSignal) {
  const verified = await verifyCanonicalSource(blob, identity, signal);
  const vector = new Float64Array(11); vector.set([1, verified.sampleRate, verified.frames]);
  for (let index = 0; index < 8; index++) vector.set([Number.parseInt(verified.pcmHash.slice(index * 8, (index + 1) * 8), 16)], index + 3);
  return vector;
}
