import { describe, expect, it } from "vitest";
import { albumRateChoices, albumRateNote, exportRateChoices } from "../export-rates";
import { CD_DELIVERY, DEFAULT_DELIVERY, availableDelivery, deliveredBytes, deliveredFrames, deliveredRate, deliveryRequest, deliverySummary, readDeliveryFormat } from "../delivery-format";
import { MAX_SOURCE_FRAMES } from "../audio-limits";

describe("delivery format", () => {
  it("sends the same request fields the Export panel sends", () => {
    expect(deliveryRequest(DEFAULT_DELIVERY)).toEqual({});
    expect(deliveryRequest(CD_DELIVERY)).toEqual({ sampleRate: 44100 });
    expect(deliveryRequest({ bitDepth: 16, sampleRate: 44100, dither: false })).toEqual({ sampleRate: 44100, dither: "none" });
    // 32-bit float carries no dither, so the dither choice is not sent.
    expect(deliveryRequest({ bitDepth: 32, sampleRate: "source", dither: false })).toEqual({});
  });

  it("describes the delivered rate, frames and bytes, including a converted length", () => {
    expect(deliveredRate(DEFAULT_DELIVERY, 48000)).toBe(48000);
    expect(deliveredRate(CD_DELIVERY, 48000)).toBe(44100);
    expect(deliveredFrames(CD_DELIVERY, 48000, 48001)).toBe(44101);
    expect(deliveredFrames(CD_DELIVERY, 44100, 44100)).toBe(44100);
    expect(deliveredBytes(CD_DELIVERY, 48000, 48000)).toBe(44 + 44100 * 4);
    expect(deliveredBytes(DEFAULT_DELIVERY, 48000, 48000)).toBe(44 + 48000 * 6);
  });

  it("summarizes the format in words", () => {
    expect(deliverySummary(CD_DELIVERY)).toBe("44.1 kHz · 16-bit PCM · TPDF dither");
    expect(deliverySummary({ bitDepth: 24, sampleRate: 48000, dither: false })).toBe("48 kHz · 24-bit PCM · no dither");
    expect(deliverySummary({ bitDepth: 32, sampleRate: "source", dither: true }, 48000)).toBe("48 kHz (source) · 32-bit float");
    expect(deliverySummary(DEFAULT_DELIVERY)).toBe("Source rate · 24-bit PCM · TPDF dither");
  });

  it("falls back to the source rate when the chosen rate is unavailable for the track", () => {
    const choices = exportRateChoices(48000, MAX_SOURCE_FRAMES / 2 + 1);
    expect(availableDelivery({ ...CD_DELIVERY, sampleRate: 96000 }, choices)).toEqual({ ...CD_DELIVERY, sampleRate: "source" });
    expect(availableDelivery(CD_DELIVERY, choices)).toBe(CD_DELIVERY);
    // A listed source rate is offered as "source"; the same delivered file.
    expect(availableDelivery({ ...CD_DELIVERY, sampleRate: 48000 }, choices)).toEqual({ ...CD_DELIVERY, sampleRate: "source" });
  });

  it("restores saved formats and falls back to the 24-bit source-rate default", () => {
    expect(readDeliveryFormat(undefined)).toEqual(DEFAULT_DELIVERY);
    expect(readDeliveryFormat(CD_DELIVERY)).toEqual(CD_DELIVERY);
    expect(readDeliveryFormat({ bitDepth: 20, sampleRate: 22050, dither: "yes" })).toEqual(DEFAULT_DELIVERY);
    expect(readDeliveryFormat({ bitDepth: 16, sampleRate: "source", dither: false })).toEqual({ bitDepth: 16, sampleRate: "source", dither: false });
  });
});

describe("album rate choices", () => {
  it("offers each source rate first, then every rate all tracks can convert to", () => {
    const choices = albumRateChoices([{ sampleRate: 48000, frames: 48000 }, { sampleRate: 44100, frames: 44100 }]);
    expect(choices.map((choice) => choice.value)).toEqual(["source", 44100, 48000, 88200, 96000]);
    expect(choices.every((choice) => choice.unavailable === undefined)).toBe(true);
    expect(albumRateNote(choices)).toBe("");
  });

  it("disables a rate any track cannot reach and says why", () => {
    const choices = albumRateChoices([{ sampleRate: 48000, frames: 48000 }, { sampleRate: 44101, frames: 44101 }]);
    expect(choices.filter((choice) => choice.unavailable).map((choice) => choice.value)).toEqual([44100, 48000, 88200, 96000]);
    expect(albumRateNote(choices)).toBe("44.1 kHz, 48 kHz, 88.2 kHz and 96 kHz are unavailable: at least one track cannot be converted to them exactly or would exceed the converted-length limit.");
  });
});
