import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    default: "Sales agents",
    template: "%s | Kharch n Save agents",
  },
  robots: { index: false, follow: false },
};

export default function AgentLayout({ children }: LayoutProps<"/agent">) {
  return <div className="container-page py-8 md:py-12">{children}</div>;
}
