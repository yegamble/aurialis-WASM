"use client";

import type { AnchorHTMLAttributes } from "react";
import { canNavigateWorkspace, navigateWorkspace } from "@/lib/workspace-navigation";

/** Real URLs still support copy, new tabs and direct loading of exported shells. */
export function WorkspaceLink({ href, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return <a {...props} href={href} onClick={(event) => {
    onClick?.(event);
    if (!canNavigateWorkspace(event, event.currentTarget)) return;
    event.preventDefault();
    navigateWorkspace(event.currentTarget.href);
  }} />;
}
