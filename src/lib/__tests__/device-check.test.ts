import { describe, expect, it } from "vitest";
import { deviceCheckSettings, deviceCheckWAV } from "../device-check";
import { acceptedControlPacket, readKernelDiagnostics } from "../playback-diagnostics";
import { exportParams } from "../engine-params";
import { packLiveControls } from "../live-controls";
describe("bounded production device qualification", () => {
  it.each([48000, 96000] as const)("generates exactly twenty seconds of finite stereo PCM at %s Hz", (rate) => {
    const buffer = deviceCheckWAV(rate), header = new DataView(buffer), pcm = new Float32Array(buffer.slice(44));
    expect(buffer.byteLength).toBe(44 + rate * 20 * 8); expect(header.getUint32(24, true)).toBe(rate);
    expect(header.getUint16(20, true)).toBe(3); expect(header.getUint16(22, true)).toBe(2);
    expect(pcm.every((sample) => Number.isFinite(sample) && Math.abs(sample) < 1)).toBe(true);
    expect(pcm.some((sample) => Math.abs(sample) > .1)).toBe(true);
  });
  it.each(["classic", "oversampled"] as const)("publishes the actual heavy %s packet without monitor gain in export", (quality) => {
    const settings = deviceCheckSettings(quality), params = exportParams(settings), packet = packLiveControls(params, 2);
    expect([params.eqEnabled, params.compressor.enabled, params.saturation.enabled, params.stereo.enabled, params.limiter.enabled, params.deHarsh.enabled, params.multiband.enabled]).toEqual([true, true, true, true, true, true, true]);
    expect(packet[81]).toBe(quality === "classic" ? 2 : 3);
    const header = new Int32Array(new SharedArrayBuffer(32)), controls = new SharedArrayBuffer(16 + packet.byteLength), version = new Int32Array(controls, 0, 4);
    new Float64Array(controls, 16).set(packet); version[0] = 2; version[1] = 4;
    expect(acceptedControlPacket(header, controls)).toBeNull();
    header[4] = 4; expect(acceptedControlPacket(header, controls)).toEqual({ version: 4, values: Array.from(packet) });
    version[0] = 3; expect(acceptedControlPacket(header, controls)).toBeNull();
    version[0] = 4; header[4] = 3; expect(acceptedControlPacket(header, controls)).toBeNull();
  });
  it("keeps absent or invalid audio-thread diagnostics unavailable", () => {
    expect(readKernelDiagnostics({})).toBeNull();
    expect(readKernelDiagnostics({ frames: 128, kernelMs: 1, audioMs: 2, wallMs: 3, clockStepMs: null })).toMatchObject({ clockStepMs: null });
    expect(readKernelDiagnostics({ frames: 128, kernelMs: NaN, audioMs: 2, wallMs: 3, clockStepMs: 1 })).toBeNull();
  });
});
