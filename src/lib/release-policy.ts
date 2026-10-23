import type { MeasuredAudioMetrics } from "./types";

export const releaseProfiles = [
  { name: "Spotify", source: "https://support.spotify.com/us/artists/article/loudness-normalization/", loudness: -14, scope: "Playback and mastering guidance; this is not an upload loudness requirement." },
  { name: "Apple Music", source: "https://help.apple.com/itc/videoaudioassetguide/en.lproj/static.html", scope: "Stereo source format only. Digital Masters status also needs original-source and codec review." },
  { name: "YouTube", source: "https://support.google.com/youtube/answer/6039860?hl=en", scope: "Music-video Content ID partner guidance. This WAV is not a complete video delivery." },
  { name: "SoundCloud", source: "https://help.soundcloud.com/hc/en-us/articles/360053660014-Will-SoundCloud-play-my-track-at-the-level-it-s-mastered", loudness: -14, scope: "Published mastering guidance; delivery and codec checks remain separate." },
  { name: "CD", source: "https://www.sony.co.uk/electronics/support/understanding-digital-audio", scope: "PCM format review only. This WAV is not a disc image, DDP or manufacturing approval." },
  { name: "Podcast", source: "https://podcasters.apple.com/support/893-audio-requirements", loudness: -16, scope: "Apple Podcasts subscriber WAV and pre-encoding guidance. RSS delivery requires AAC or MP3." },
] as const;

export type ReleasePlatform = (typeof releaseProfiles)[number]["name"];
export type OutputBits = 16 | 24 | 32;
export type EncodedInspection = {
  sampleRate: number; frames: number; channels: 2; bitDepth: OutputBits;
  fullScaleFrames: number; leadingSilenceFrames: number; trailingSilenceFrames: number;
  silenceThresholdDbfs: -60;
};
export type ReleaseCheck = { name: string; reading: string; status: "pass" | "review" | "info"; guidance: string };
const sourceRates = [44100, 48000, 88200, 96000, 176400, 192000];

export function releaseChecks(platform: ReleasePlatform, metrics: MeasuredAudioMetrics, output: EncodedInspection): ReleaseCheck[] {
  const profile = releaseProfiles.find((item) => item.name === platform);
  if (!profile) throw new Error("Choose a supported delivery profile.");
  const target = "loudness" in profile ? profile.loudness : null;
  const peakLimit = (platform === "Spotify" || platform === "SoundCloud") && metrics.integratedLufs > -14 ? -2 : -1;
  const publishedPeak = target !== null;
  const format = platform === "CD" ? output.sampleRate === 44100 && output.bitDepth === 16
    : platform === "Apple Music" || platform === "Podcast" ? sourceRates.includes(output.sampleRate) && output.bitDepth !== 32
    : platform === "YouTube" ? output.sampleRate >= 48000 && output.bitDepth !== 32 : null;
  const leading = output.leadingSilenceFrames / output.sampleRate, trailing = output.trailingSilenceFrames / output.sampleRate;
  return [
    { name: "Integrated loudness", reading: `${metrics.integratedLufs.toFixed(1)} LUFS`,
      status: target === null ? "info" : Math.abs(metrics.integratedLufs - target) <= 1 ? "pass" : "review",
      guidance: target === null ? "No stereo LUFS requirement is asserted from this profile's source. Choose loudness by listening."
        : `Published working guidance: ${String(target)} LUFS${platform === "Podcast" ? " ±1 LU" : "; the ±1 LU review band is an Aurialis preference"}. No gain is applied by this check.` },
    { name: "Reconstructed peak estimate", reading: `${metrics.truePeakDbtp.toFixed(2)} dBTP`,
      status: ((platform === "Spotify" || platform === "SoundCloud") ? metrics.truePeakDbtp < peakLimit : metrics.truePeakDbtp <= peakLimit) ? "pass" : "review",
      guidance: `${publishedPeak ? "Published guidance" : "Aurialis working headroom"}: ${String(peakLimit)} dBTP${peakLimit === -2 ? " for a master louder than −14 LUFS" : ""}. The finite 4× FIR estimate does not certify codec or converter peaks.` },
    { name: "Encoded full-scale frames", reading: String(output.fullScaleFrames), status: output.fullScaleFrames === 0 ? "pass" : "review",
      guidance: `Sample peak ${metrics.samplePeakDbfs.toFixed(2)} dBFS. Counted from the exact encoded samples; full scale does not establish how or when clipping happened.` },
    { name: "Output format", reading: `${String(output.sampleRate / 1000)} kHz · ${String(output.bitDepth)}-bit ${output.bitDepth === 32 ? "float" : "PCM"} · stereo`,
      status: format === null ? "info" : format ? "pass" : "review",
      guidance: platform === "CD" ? "CD PCM requires 44.1 kHz / 16-bit stereo. This check never resamples or changes resolution."
        : platform === "YouTube" ? "The cited partner guidance recommends 48 kHz stereo / 24-bit; higher rates and 16-bit are accepted. Video/container validation remains separate."
        : format === null ? "Confirm the distributor's supported source format. No unverified format requirement is inferred."
        : "Published stereo PCM rates: 44.1, 48, 88.2, 96, 176.4 or 192 kHz, with 16 or 24 bits. Source provenance and codec approval need separate review." },
    { name: "Stereo correlation", reading: metrics.correlation.toFixed(2), status: metrics.correlation >= 0 ? "pass" : "review",
      guidance: "Aurialis diagnostic: negative correlation can indicate mono cancellation. Listen in mono; correlation alone cannot establish compatibility." },
    { name: "Leading / trailing quiet", reading: `${leading.toFixed(2)} s / ${trailing.toFixed(2)} s`, status: leading <= 0.5 && trailing <= 2 ? "pass" : "review",
      guidance: "Exact encoded frames below −60 dBFS on both channels. Aurialis flags over 0.5 s before or 2 s after; intentional timing is a listening decision. Nothing is trimmed." },
    { name: "DC level", reading: `${metrics.dcLeftDbfs.toFixed(1)} / ${metrics.dcRightDbfs.toFixed(1)} dBFS`,
      status: Math.max(metrics.dcLeftDbfs, metrics.dcRightDbfs) <= -60 ? "pass" : "review", guidance: "Aurialis diagnostic: review channel mean levels above −60 dBFS. No automatic repair is applied." },
    { name: "Peak-to-RMS crest factor", reading: `${metrics.dynamicRangeDb.toFixed(1)} dB`, status: "info", guidance: "Describes this output. This is not LRA, a DR rating, or a universal dynamic-range requirement." },
    { name: "Metadata and delivery", reading: "Manual review", status: "info", guidance: "The clean WAV contains audio without artist, album, artwork or ISRC tags. Complete distributor metadata, source-quality and encoded-codec checks separately." },
  ];
}
