import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindPlaybackControls } from "../media-session";
import type { LivePlaybackState } from "../live-playback";

const bindings: ReturnType<typeof bindPlaybackControls>[] = [];
let state: LivePlaybackState;
const handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>();
const media = { metadata: null as MediaMetadata | null, playbackState: "none", setPositionState: vi.fn(), setActionHandler: vi.fn((action: MediaSessionAction, handler: MediaSessionActionHandler | null) => { handlers.set(action, handler); }) };
function connect(title = "Current source") {
  const actions = {
    getState: () => state, available: () => true,
    play: vi.fn(() => { state = { ...state, playing: true }; return Promise.resolve(); }),
    pause: vi.fn(() => { state = { ...state, playing: false }; }),
    seek: vi.fn((position: number) => { state = { ...state, position }; }),
    restart: vi.fn(() => { state = { ...state, position: 0 }; }), forward: vi.fn(), onError: vi.fn(),
  };
  const binding = bindPlaybackControls(title, actions);
  bindings.push(binding);
  return { binding, actions };
}
beforeEach(() => {
  handlers.clear(); media.metadata = null; media.playbackState = "none"; media.setPositionState.mockClear(); media.setActionHandler.mockClear();
  state = { position: 10, duration: 100, playing: false, ready: true, loading: false, original: false, volume: 1, repeat: false, underruns: 0, parameterVersion: 1, appliedVersion: 1, error: null };
  vi.stubGlobal("navigator", { mediaSession: media });
  vi.stubGlobal("MediaMetadata", class { title: string; artist: string; constructor(init: MediaMetadataInit) { this.title = init.title ?? ""; this.artist = init.artist ?? ""; } });
});
afterEach(() => { for (const binding of bindings) binding.dispose(); bindings.length = 0; document.body.innerHTML = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("current-player keyboard and Media Session controls", () => {
  it("uses Space and precise bounded arrow seeks while leaving focused native controls alone", () => {
    const { actions } = connect();
    fireEvent.keyDown(document.body, { key: " ", code: "Space" });
    expect(actions.play).toHaveBeenCalledOnce();
    fireEvent.keyDown(document.body, { key: " ", code: "Space", repeat: true });
    expect(actions.pause).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    expect(actions.seek).toHaveBeenLastCalledWith(9);
    fireEvent.keyDown(document.body, { key: "ArrowRight", shiftKey: true });
    expect(actions.seek).toHaveBeenLastCalledWith(19);
    fireEvent.keyDown(document.body, { key: "ArrowLeft", altKey: true });
    expect(actions.seek).toHaveBeenLastCalledWith(18.9);
    for (const tag of ["input", "select", "textarea", "button", "a", "div"]) {
      const element = document.createElement(tag);
      if (tag === "div") element.setAttribute("contenteditable", "true");
      document.body.append(element);
      const before = actions.seek.mock.calls.length;
      fireEvent.keyDown(element, { key: "ArrowRight" });
      expect(actions.seek.mock.calls.length).toBe(before);
      element.remove();
    }
    const region = document.createElement("div");
    region.tabIndex = 0; region.setAttribute("role", "region"); document.body.append(region);
    const before = actions.seek.mock.calls.length;
    const scrollKey = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
    region.dispatchEvent(scrollKey);
    expect(scrollKey.defaultPrevented).toBe(false);
    expect(actions.seek.mock.calls.length).toBe(before);
    region.remove();
    const prevented = new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true });
    prevented.preventDefault();
    window.dispatchEvent(prevented);
    expect(actions.seek).toHaveBeenLastCalledWith(18.9);
    fireEvent.keyDown(document.body, { key: " ", code: "Space" });
    expect(actions.pause).toHaveBeenCalledOnce();
  });

  it("registers all supported native actions and reports actual bounded position/state", async () => {
    const { binding, actions } = connect();
    expect(media.metadata).toEqual(expect.objectContaining({ title: "Current source", artist: "Aurialis" }));
    handlers.get("play")?.({ action: "play" }); await Promise.resolve();
    expect(actions.play).toHaveBeenCalledOnce();
    binding.update(state, true);
    expect(media.playbackState).toBe("playing");
    handlers.get("seekto")?.({ action: "seekto", seekTime: 150 });
    expect(actions.seek).toHaveBeenLastCalledWith(100);
    handlers.get("seekbackward")?.({ action: "seekbackward", seekOffset: 5 });
    expect(actions.seek).toHaveBeenLastCalledWith(95);
    handlers.get("seekforward")?.({ action: "seekforward" });
    expect(actions.seek).toHaveBeenLastCalledWith(100);
    handlers.get("previoustrack")?.({ action: "previoustrack" });
    expect(actions.restart).toHaveBeenCalledOnce();
    handlers.get("nexttrack")?.({ action: "nexttrack" });
    expect(actions.forward).toHaveBeenCalledOnce();
    handlers.get("stop")?.({ action: "stop" });
    expect(state.playing).toBe(false); expect(state.position).toBe(0);
    expect(media.setPositionState).toHaveBeenLastCalledWith({ duration: 100, playbackRate: 1, position: 0 });
  });

  it("throttles ordinary clock updates and prevents disposed handlers from controlling a later track", () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const first = connect("Old source");
    const oldPlay = handlers.get("play");
    media.setPositionState.mockClear();
    first.binding.update({ ...state, position: 1 });
    expect(media.setPositionState).not.toHaveBeenCalled();
    vi.spyOn(performance, "now").mockReturnValue(1001);
    first.binding.update({ ...state, position: 2 });
    expect(media.setPositionState).toHaveBeenCalledOnce();
    const current = connect("New source");
    first.binding.dispose();
    oldPlay?.({ action: "play" });
    expect(first.actions.play).not.toHaveBeenCalled();
    expect(media.metadata).toEqual(expect.objectContaining({ title: "New source" }));
    fireEvent.keyDown(document.body, { key: " ", code: "Space" });
    expect(current.actions.play).toHaveBeenCalledOnce();
    current.binding.dispose();
    expect(media.playbackState).toBe("none"); expect(media.metadata).toBeNull();
    for (const handler of handlers.values()) expect(handler).toBeNull();
  });
});
