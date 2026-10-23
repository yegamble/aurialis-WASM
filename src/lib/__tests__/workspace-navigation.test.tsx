import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceLink } from "@/components/shared/WorkspaceLink";
import { canNavigateWorkspace, navigateWorkspace, useWorkspacePath, workspaceRoute } from "../workspace-navigation";

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });
function anchor(href = "/library", attributes: Record<string, string> = {}) {
  const element = document.createElement("a"); element.href = href;
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}
describe("same-document workstation navigation", () => {
  it("recognizes only the shared app routes and bounds decoded project IDs", () => {
    for (const [path, route] of [["/", "home"], ["/library", "library"], ["/tools", "tools"], ["/albums/", "albums"], ["/albums/album-1", "album"], ["/master/track-1", "master"], ["/split/track-1", "split"], ["/reference/track-1", "reference"], ["/release-check/track-1", "release-check"]]) expect(workspaceRoute(path ?? "")).toBe(route);
    for (const path of ["/api/health", "/master", "/master/track-1/more", "/master/bad%2Fid", "/master/%", `/master/${"a".repeat(129)}`]) expect(workspaceRoute(path)).toBeNull();
  });
  it("preserves modified clicks, new tabs, downloads, hashes and external destinations", () => {
    expect(canNavigateWorkspace(new MouseEvent("click"), anchor())).toBe(true);
    for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) expect(canNavigateWorkspace(new MouseEvent("click", { [modifier]: true }), anchor())).toBe(false);
    for (const button of [1, 2]) expect(canNavigateWorkspace(new MouseEvent("click", { button }), anchor())).toBe(false);
    for (const target of [anchor("/library", { target: "_blank" }), anchor("/library", { download: "" }), anchor("/library", { rel: "external" }), anchor("/library#"), anchor("/library#heading"), anchor("https://example.com/library"), anchor("/api/health")]) expect(canNavigateWorkspace(new MouseEvent("click"), target)).toBe(false);
    const canceled = new MouseEvent("click", { cancelable: true }); canceled.preventDefault(); expect(canNavigateWorkspace(canceled, anchor())).toBe(false);
  });
  it("updates the path subscriber through shared anchors without a page router or server request", () => {
    window.history.replaceState(null, "", "/");
    function View() { const path = useWorkspacePath("/"); return <><output>{path}</output><WorkspaceLink href="/master/track-new">Open project</WorkspaceLink></>; }
    render(<View />); fireEvent.click(screen.getByRole("link", { name: "Open project" }));
    expect(window.location.pathname).toBe("/master/track-new"); expect(screen.getByRole("status").textContent).toBe("/master/track-new");
    expect(() => { navigateWorkspace("https://example.com/library"); }).toThrow("Unsupported");
  });
  it("honors a caller's prevented action and does not replace a normal link's href", () => {
    const push = vi.spyOn(window.history, "pushState");
    render(<WorkspaceLink href="/library" onClick={(event) => { event.preventDefault(); }}>Guarded</WorkspaceLink>);
    fireEvent.click(screen.getByRole("link", { name: "Guarded" })); expect(push).not.toHaveBeenCalled(); expect(screen.getByRole("link").getAttribute("href")).toBe("/library");
  });
});
