import type { PublicationStatus } from "@/lib/admin/products";

const STYLES: Record<PublicationStatus, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-sand text-ink" },
  published: { label: "Published", className: "bg-forest text-white" },
  archived: { label: "Archived", className: "border border-line bg-white text-muted" },
};

export const PUBLICATION_LABELS: Record<PublicationStatus, string> = {
  draft: "Draft",
  published: "Published",
  archived: "Archived",
};

export function PublicationBadge({ status }: { status: PublicationStatus }) {
  const style = STYLES[status];
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${style.className}`}>
      {style.label}
    </span>
  );
}
