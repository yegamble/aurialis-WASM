import policy from "./asset-policy.json";

const assets = new Set(policy.paths);

function assetPath(raw: string): string | undefined {
  if (/%2f|%5c/iu.test(raw)) return undefined;
  let pathname: string;
  try { pathname = decodeURIComponent(raw); } catch { return undefined; }
  const relative = pathname.replace(/^\/+|\/+$/gu, "") || "index.html";
  for (const candidate of [relative, relative + ".html", relative + "/index.html"]) if (assets.has(candidate)) return candidate;
  const parts = relative.split("/");
  const route = parts[0], id = parts[1];
  if (!route || !id || !["master", "split", "albums", "reference", "release-check"].includes(route)) return undefined;
  const shellId = id.endsWith(".txt") ? id.slice(0, -4) : id;
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(shellId)) return undefined;
  for (const placeholder of ["placeholder", "track-1", "album-1"]) {
    const suffix = parts.length === 2 ? (id.endsWith(".txt") ? ".txt" : ".html") : "/" + parts.slice(2).join("/");
    const candidate = `${route}/${placeholder}${suffix}`;
    if (assets.has(candidate)) return candidate;
  }
  return undefined;
}

function secure(response: Response, method: string, path: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", policy.csp);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // Keep edge injection from modifying the app's pinned HTML and request boundary.
  headers.set("Cache-Control", "no-store, no-transform");
  if (path.endsWith(".wasm") && response.ok) headers.set("Content-Type", "application/wasm");
  return new Response(method === "HEAD" ? null : response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "GET" && request.method !== "HEAD") {
      return secure(new Response("Aurialis processes audio on your device. This site accepts no uploads.", { status: 405, headers: { Allow: "GET, HEAD" } }), request.method, path);
    }
    if (/^\/(?:api|jobs|analyze|separate|master\/render)(?:\/|$)/u.test(path)) {
      return secure(new Response("Audio processing runs locally in your browser.", { status: 404 }), request.method, path);
    }
    const asset = assetPath(path);
    if (!asset) return secure(new Response("Static app file not found.", { status: 404 }), request.method, path);
    const url = new URL(request.url);
    url.pathname = "/" + asset;
    const response = await env.ASSETS.fetch(new Request(url, request));
    return secure(response, request.method, path);
  },
} satisfies ExportedHandler<Env>;
