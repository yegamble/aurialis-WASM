"use client";

import { useSyncExternalStore } from "react";

export type WorkstationRoute = "home" | "library" | "master" | "split" | "albums" | "album" | "reference" | "release-check" | "tools";
const NAVIGATION_EVENT = "aurialis-navigation";

/** Only routes rendered by the shared workstation can remain in this document. */
export function workspaceRoute(pathname: string): WorkstationRoute | null {
  if (pathname === "/") return "home";
  const parts = pathname.replace(/\/$/u, "").split("/");
  if (parts.length === 2) {
    if (parts[1] === "library" || parts[1] === "albums" || parts[1] === "tools") return parts[1];
    return null;
  }
  if (parts.length !== 3 || !parts[2]) return null;
  let id: string;
  try { id = decodeURIComponent(parts[2]); } catch { return null; }
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(id)) return null;
  if (parts[1] === "albums") return "album";
  return parts[1] === "master" || parts[1] === "split" || parts[1] === "reference" || parts[1] === "release-check" ? parts[1] : null;
}

export function navigateWorkspace(href: string): void {
  const url = new URL(href, window.location.href);
  if (url.origin !== window.location.origin || href.includes("#") || url.hash || workspaceRoute(url.pathname) === null) throw new Error("Unsupported workstation route.");
  if (url.href === window.location.href) return;
  window.history.pushState(null, "", url.pathname + url.search);
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

/** Leave native browser behavior intact for modified, download, hash and external links. */
export function canNavigateWorkspace(event: Pick<MouseEvent, "button" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "defaultPrevented">, anchor: HTMLAnchorElement): boolean {
  if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self") || anchor.relList.contains("external")) return false;
  const url = new URL(anchor.href, window.location.href);
  return url.origin === window.location.origin && !(anchor.getAttribute("href") ?? "").includes("#") && !url.hash && workspaceRoute(url.pathname) !== null;
}

function subscribe(listener: () => void) {
  window.addEventListener("popstate", listener);
  window.addEventListener(NAVIGATION_EVENT, listener);
  return () => { window.removeEventListener("popstate", listener); window.removeEventListener(NAVIGATION_EVENT, listener); };
}
export function useWorkspacePath(serverPath: string | null): string | null {
  return useSyncExternalStore(subscribe, () => window.location.pathname, () => serverPath);
}
