import type { BrowserContext } from "@playwright/test";
export function scaleNetworkObservation(context: BrowserContext): Readonly<{
  requests: { url: string; method: string; bytes: number }[];
  assert(): void;
  close(): void;
  serialize(testPassed: boolean): string;
}>;
