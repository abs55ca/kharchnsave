"use client";

import Link from "next/link";
import { useId, useRef, useState } from "react";
import { ChevronRightIcon } from "@/components/icons";

export type FreshFindsTab = {
  key: string;
  label: string;
  viewAllHref: string;
  viewAllLabel: string;
  /** The button under the cards on phones, e.g. "View all shoes". */
  bottomLabel: string;
  panel: React.ReactNode;
};

/** WAI-ARIA tabs: arrow keys move between tabs, Tab moves into the panel. */
export function FreshFindsTabs({
  tabs,
  headingId,
}: {
  tabs: FreshFindsTab[];
  headingId: string;
}) {
  const [active, setActive] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const baseId = useId();

  function focusTab(index: number) {
    const next = (index + tabs.length) % tabs.length;
    setActive(next);
    tabRefs.current[next]?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent, index: number) {
    const keys: Record<string, number> = {
      ArrowRight: index + 1,
      ArrowLeft: index - 1,
      Home: 0,
      End: tabs.length - 1,
    };
    if (event.key in keys) {
      event.preventDefault();
      focusTab(keys[event.key]);
    }
  }

  const current = tabs[active];

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-line">
        <div role="tablist" aria-labelledby={headingId} className="-mb-px flex gap-1 overflow-x-auto">
          {tabs.map((tab, index) => (
            <button
              key={tab.key}
              ref={(el) => {
                tabRefs.current[index] = el;
              }}
              id={`${baseId}-tab-${tab.key}`}
              type="button"
              role="tab"
              aria-selected={index === active}
              aria-controls={`${baseId}-panel-${tab.key}`}
              tabIndex={index === active ? 0 : -1}
              onClick={() => setActive(index)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={`whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-semibold transition-colors ${
                index === active
                  ? "border-forest text-forest"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <Link
          href={current.viewAllHref}
          className="mb-2 inline-flex items-center gap-1 text-sm font-semibold text-forest hover:underline"
        >
          {current.viewAllLabel}
          <ChevronRightIcon width={16} height={16} />
        </Link>
      </div>
      {tabs.map((tab, index) => (
        <div
          key={tab.key}
          id={`${baseId}-panel-${tab.key}`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-${tab.key}`}
          hidden={index !== active}
        >
          {tab.panel}
        </div>
      ))}
      {/* Phones: after scrolling through the cards, a way on without scrolling back up. */}
      <Link href={current.viewAllHref} className="btn btn-outline mt-6 flex h-12 w-full items-center justify-center gap-2 md:hidden">
        {current.bottomLabel}
        <ChevronRightIcon width={16} height={16} />
      </Link>
    </div>
  );
}
