const maximumScriptBytes = 2 * 1024 * 1024;
const invalid = () => new Error("The mastering script metadata exceeds its bounded shape or size.");

/** Bounds JSON and a conservative application reservation without serializing or cloning input. */
export function boundedMetadata(value: unknown, maximumBytes = maximumScriptBytes): number {
  let jsonBytes = 0, residentBytes = 0, nodes = 0;
  const ancestors = new Set<object>();
  function stringBytes(text: string) {
    if (text.length > 4096) throw invalid();
    jsonBytes += 2; residentBytes += text.length * 2;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code < 32 || code === 34 || code === 92) jsonBytes += code < 32 && ![8, 9, 10, 12, 13].includes(code) ? 6 : 2;
      else if (code < 128) jsonBytes++;
      else if (code < 2048) jsonBytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) { jsonBytes += 4; index++; }
      else jsonBytes += code >= 0xd800 && code <= 0xdfff ? 6 : 3;
    }
  }
  function walk(item: unknown, depth: number) {
    if (++nodes > 150_000 || depth > 8) throw invalid();
    residentBytes += 64;
    if (typeof item === "string") stringBytes(item);
    else if (typeof item === "number") { if (!Number.isFinite(item)) throw invalid(); jsonBytes += String(item).length; }
    else if (typeof item === "boolean") jsonBytes += item ? 4 : 5;
    else if (item === null || item === undefined) jsonBytes += 4;
    else if (typeof item === "object") {
      if (ancestors.has(item)) throw invalid();
      ancestors.add(item); jsonBytes += 2;
      if (Array.isArray(item)) {
        if (item.length > 256) throw invalid();
        let index = 0;
        for (const child of item as unknown[]) { if (index++ > 0) jsonBytes++; walk(child, depth + 1); }
      } else {
        const prototype: unknown = Object.getPrototypeOf(item);
        if (prototype !== Object.prototype && prototype !== null) throw invalid();
        let keys = 0;
        for (const key in item) if (Object.hasOwn(item, key)) {
          if (++keys > 128) throw invalid();
          if (keys > 1) jsonBytes++;
          stringBytes(key); jsonBytes++;
          // Bounded own DTO fields are traversed as data, never evaluated paths.
          // eslint-disable-next-line security/detect-object-injection
          walk((item as Record<string, unknown>)[key], depth + 1);
        }
      }
      ancestors.delete(item);
    } else throw invalid();
    if (jsonBytes > maximumBytes) throw invalid();
  }
  walk(value, 0); return residentBytes;
}

/** Existing script collection limits are checked before any normalizer or serializer runs. */
export function scriptMetadataBytes(value: unknown): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
  const script = value as Record<string, unknown>;
  for (const key of ["sections", "moves", "findings"] as const) {
    // Fixed collection names from the ScriptV2 DTO.
    // eslint-disable-next-line security/detect-object-injection
    const items = script[key]; if (!Array.isArray(items) || items.length > 128) throw invalid();
    if (key === "moves") for (const move of items as unknown[]) {
      if (typeof move !== "object" || move === null || !("points" in move) || !Array.isArray(move.points) || move.points.length > 256) throw invalid();
    }
  }
  return boundedMetadata(value);
}
