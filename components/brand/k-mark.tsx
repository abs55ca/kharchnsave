import { K_MARK } from "@/lib/brand/k-mark";

/** The "K" mark (green K with the lime tag), inline so it needs no extra request. */
export function KMark({ className, title }: { className?: string; title?: string }) {
  const { x, y, width, height } = K_MARK.viewBox;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`${x} ${y} ${width} ${height}`}
      className={className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {K_MARK.paths.map((path) => (
        <path key={path.fill} fill={path.fill} d={path.d} />
      ))}
    </svg>
  );
}
