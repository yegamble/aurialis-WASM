import type { Page } from "@playwright/test";

/** Chromium does not route AudioWorklet.addModule fetches through page.route.
 * Fetch the real module on the main thread, where the bounded test patch runs,
 * and retain its real Go/WASI host through an absolute import. This requires
 * explicit test-only bypassCSP; production CSP and DSP are unchanged. */
export async function loadInterceptedWorklet(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const load = AudioWorklet.prototype.addModule;
    AudioWorklet.prototype.addModule = async function (this: AudioWorklet, url: string | URL, options?: WorkletOptions) {
      const href = new URL(url, location.href);
      if (href.origin !== location.origin || href.pathname !== "/worklets/aurialis-live-worklet.js") return load.call(this, url, options);
      const response = await fetch(href);
      if (!response.ok) throw new Error("The instrumented worklet source could not be fetched.");
      const source = await response.text(), host = 'from "./aurialis-wasi-host.js"';
      if (!source.includes(host)) throw new Error("The worklet host import changed; update the test loader.");
      const patched = source.replace(host, `from "${new URL("./aurialis-wasi-host.js", href).href}"`);
      const blob = URL.createObjectURL(new Blob([patched], { type: "text/javascript" }));
      try { await load.call(this, blob, options); } finally { URL.revokeObjectURL(blob); }
    };
  });
}
