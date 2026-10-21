import type { ReactNode } from "react";
import { Icon } from "./Icon";

/** One accessible disclosure for each audio module; native keyboard behavior is shared. */
export function DSPModule({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="module-disclosure group min-w-0 rounded-2xl border border-[var(--line)] bg-[var(--paper)] p-4" open>
      <summary className="flex min-h-[44px] cursor-pointer items-center justify-between gap-3 font-semibold">
        {title}
        <Icon name="chevron-down" className="transition-transform group-open:rotate-180 motion-reduce:transition-none" />
      </summary>
      <div className="flex min-w-0 flex-col gap-4 pt-3">{children}</div>
    </details>
  );
}
