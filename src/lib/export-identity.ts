import { availableDelivery, deliveryRequest, readDeliveryFormat } from "./delivery-format";
import { exportRender } from "./engine-params";
import { exportRateChoices } from "./export-rates";
import type { Track } from "./types";

/** Source and canonical export payload identity, independent of labels and draft proposals. */
export function exportTrackKey(track: Track): string {
  const format = availableDelivery(readDeliveryFormat(track.exportDelivery), exportRateChoices(track.sampleRate, track.sourceIdentity?.frames ?? Math.round(track.duration * track.sampleRate)));
  return JSON.stringify([deliveryRequest(format), format.bitDepth, track.id, track.sourceAudioId ?? track.id, track.sourceRevision ?? 0,
    track.sourceIdentity ?? null, track.sampleRate, track.duration, exportRender(track)]);
}
