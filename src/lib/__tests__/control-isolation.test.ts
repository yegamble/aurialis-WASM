import { describe, expect, it } from "vitest";
import { initialStoreState as emptyStore, normalizeHydratedState, reduceStoreState } from "../store";
import { testStore as initialStoreState } from "./fixtures";
import { mapSimpleToDSP } from "../audio-dsp";
import type { EQBandId } from "../types";

describe("Aurialis Control Isolation & Parameter Orthogonality", () => {
  it("starts with an empty production workspace", () => {
    expect(emptyStore).toEqual({ tracks: [], albums: [], stems: [] });
  });
  it("applies Simple choices to shared Advanced DSP without mutating other tracks", () => {
    const beforeTrack1 = structuredClone(initialStoreState.tracks[0]);
    const beforeTrack2 = structuredClone(initialStoreState.tracks[1]);
    if (!beforeTrack1 || !beforeTrack2) throw new Error("Missing demo tracks");

    const afterGenre = reduceStoreState(initialStoreState, {
      type: "UPDATE_SIMPLE",
      id: beforeTrack1.id,
      patch: { genre: "Hip-hop" },
    });
    const updated1 = afterGenre.tracks[0];
    const updated2 = afterGenre.tracks[1];
    if (!updated1 || !updated2) throw new Error("Missing updated tracks");

    expect(updated1.genre).toBe("Hip-hop");
    expect(updated1.tone).toBe(beforeTrack1.tone);
    expect(updated1.intensity).toBe(beforeTrack1.intensity);
    expect(updated1.target).toBe(beforeTrack1.target);
    expect(updated1.advanced).toEqual(mapSimpleToDSP("Hip-hop", beforeTrack1.tone, beforeTrack1.intensity, beforeTrack1.target));
    expect(updated1.simpleCustom).toBe(false);
    expect(updated2).toEqual(beforeTrack2);
  });

  it("isolates each of the 5 parametric EQ bands with zero cross-coupling", () => {
    const trackId = "demo-1";
    const bandIds: EQBandId[] = ["sub", "low", "mid", "presence", "air"];

    for (const targetBandId of bandIds) {
      const nextState = reduceStoreState(initialStoreState, {
        type: "UPDATE_EQ_BAND",
        trackId,
        bandId: targetBandId,
        patch: { gainDb: 5.5, q: 2.2 },
      });
      const beforeTrack = initialStoreState.tracks[0];
      const afterTrack = nextState.tracks[0];
      if (!beforeTrack || !afterTrack) throw new Error("Missing track");

      for (let i = 0; i < 5; i++) {
        const beforeBand = beforeTrack.advanced.eqBands.at(i);
        const afterBand = afterTrack.advanced.eqBands.at(i);
        if (!beforeBand || !afterBand) throw new Error("Missing EQ band");
        if (beforeBand.id === targetBandId) {
          expect(afterBand.gainDb).toBe(5.5);
          expect(afterBand.q).toBe(2.2);
          expect(afterBand.freqHz).toBe(beforeBand.freqHz);
        } else {
          expect(afterBand).toEqual(beforeBand);
        }
      }

      // Non-EQ modules must remain untouched
      expect(afterTrack.advanced.input).toBe(beforeTrack.advanced.input);
      expect(afterTrack.advanced.compressor).toEqual(
        beforeTrack.advanced.compressor,
      );
      expect(afterTrack.advanced.saturationModule).toEqual(
        beforeTrack.advanced.saturationModule,
      );
      expect(afterTrack.advanced.stereo).toEqual(beforeTrack.advanced.stereo);
      expect(afterTrack.advanced.limiter).toEqual(beforeTrack.advanced.limiter);
      expect(afterTrack.advanced.repair).toEqual(beforeTrack.advanced.repair);
    }
  });

  it("isolates Compressor, Saturation, Stereo, and Limiter module controls", () => {
    const trackId = "demo-1";
    const baseTrack = initialStoreState.tracks[0];
    if (!baseTrack) throw new Error("Missing base track");

    const afterComp = reduceStoreState(initialStoreState, {
      type: "UPDATE_COMPRESSOR",
      trackId,
      patch: { threshold: -24, ratio: 4.5 },
    });
    const compTrack = afterComp.tracks[0];
    if (!compTrack) throw new Error("Missing compTrack");
    expect(compTrack.advanced.compressor.threshold).toBe(-24);
    expect(compTrack.advanced.compressor.ratio).toBe(4.5);
    expect(compTrack.advanced.compressor.attack).toBe(
      baseTrack.advanced.compressor.attack,
    );
    expect(compTrack.advanced.eqBands).toEqual(baseTrack.advanced.eqBands);
    expect(compTrack.advanced.saturationModule).toEqual(
      baseTrack.advanced.saturationModule,
    );
    expect(compTrack.advanced.stereo).toEqual(baseTrack.advanced.stereo);
    expect(compTrack.advanced.limiter).toEqual(baseTrack.advanced.limiter);

    const afterSat = reduceStoreState(afterComp, {
      type: "UPDATE_SATURATION",
      trackId,
      patch: { drive: 26, character: "Thick" },
    });
    const satTrack = afterSat.tracks[0];
    if (!satTrack) throw new Error("Missing satTrack");
    expect(satTrack.advanced.saturationModule.drive).toBe(26);
    expect(satTrack.advanced.saturationModule.character).toBe("Thick");
    expect(satTrack.advanced.compressor).toEqual(compTrack.advanced.compressor);
    expect(satTrack.advanced.stereo).toEqual(compTrack.advanced.stereo);

    const afterStereo = reduceStoreState(afterSat, {
      type: "UPDATE_STEREO",
      trackId,
      patch: { width: 132, monoBass: false },
    });
    const stereoTrack = afterStereo.tracks[0];
    if (!stereoTrack) throw new Error("Missing stereoTrack");
    expect(stereoTrack.advanced.stereo.width).toBe(132);
    expect(stereoTrack.advanced.stereo.monoBass).toBe(false);
    expect(stereoTrack.advanced.saturationModule).toEqual(
      satTrack.advanced.saturationModule,
    );

    const afterLimiter = reduceStoreState(afterStereo, {
      type: "UPDATE_LIMITER",
      trackId,
      patch: { ceiling: -0.8 },
    });
    const limTrack = afterLimiter.tracks[0];
    if (!limTrack) throw new Error("Missing limTrack");
    expect(limTrack.advanced.limiter.ceiling).toBe(-0.8);
    expect(limTrack.advanced.stereo).toEqual(stereoTrack.advanced.stereo);
  });


  it("migrates uploaded metadata while clearing former design examples and simulated completion", () => {
    const source = initialStoreState.tracks[0];
    if (!source) throw new Error("Missing test source");
    const saved = {
      tracks: [{ ...source, mode: "deep", script: { moves: ["invented"] }, releaseScore: 95 }, { ...source, id: "old-example", source: "demo" }],
      albums: [{ id: "album", title: "User album", artist: "Artist", target: "Streaming", trackIds: [source.id, "old-example"], mastered: true }],
      stems: [{ trackId: source.id, complete: true, stems: ["metadata only"] }],
    };
    const result = normalizeHydratedState(saved);
    expect(result?.tracks).toHaveLength(1);
    expect(result?.tracks[0]).toMatchObject({ id: source.id, title: source.title, mode: "advanced" });
    expect(result?.tracks[0]).not.toHaveProperty("script");
    expect(result?.tracks[0]).not.toHaveProperty("releaseScore");
    expect(result?.albums[0]).toMatchObject({ mastered: false, trackIds: [source.id] });
    expect(result?.stems).toEqual([]);
  });

  it("reset restores neutral settings without changing another track", () => {
    const altered = reduceStoreState(initialStoreState, {
      type: "UPDATE_INPUT_GAIN",
      trackId: "demo-1",
      input: 6,
    });
    const reset = reduceStoreState(altered, {
      type: "RESET_ADVANCED",
      trackId: "demo-1",
    });
    const advanced = reset.tracks[0]?.advanced;
    expect(advanced?.input).toBe(0);
    expect(advanced?.compressor.ratio).toBe(1);
    expect(advanced?.compressor.makeup).toBe(0);
    expect(advanced?.saturationModule.drive).toBe(0);
    expect(advanced?.stereo.width).toBe(100);
    expect(advanced?.stereo.monoBass).toBe(false);
    expect(advanced?.limiter.enabled).toBe(false);
    expect(advanced?.eqBands.every((band) => band.gainDb === 0)).toBe(true);
    expect(reset.tracks[1]).toBe(altered.tracks[1]);
    expect(altered.tracks[0]?.advanced.input).toBe(6);
  });
});
