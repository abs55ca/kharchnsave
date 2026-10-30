import type { Metadata, Viewport } from "next";
import { Montserrat, Poppins } from "next/font/google";
import { CartDrawer } from "@/components/cart/cart-drawer";
import { CartProvider } from "@/components/cart/cart-provider";
import { AnnouncementBar, SiteHeader } from "@/components/layout/site-header";
import { SiteChrome } from "@/components/layout/site-chrome";
import { SiteFooter } from "@/components/layout/site-footer";
import { SITE_ORIGIN } from "@/lib/links";
import { SITE } from "@/lib/site";
import "./globals.css";

const montserrat = Montserrat({
  variable: "--font-montserrat",
  subsets: ["latin"],
  weight: ["600", "700", "800"],
});

const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  // Absolute URLs in metadata (social preview images) use the public address.
  metadataBase: new URL(SITE_ORIGIN),
  title: {
    default: `${SITE.name} — ${SITE.tagline}`,
    template: `%s | ${SITE.name}`,
  },
  description: SITE.description,
  // The catalogue is demonstration content. Allow indexing once real
  // inventory and policies are live.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#163a2c",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en-PK"
      className={`${montserrat.variable} ${poppins.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <CartProvider>
          <a
            href="#main-content"
            className="sr-only z-50 rounded-md bg-lime font-semibold text-forest focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:px-4 focus:py-2"
          >
            Skip to main content
          </a>
          <SiteChrome>
            <AnnouncementBar />
            <SiteHeader />
          </SiteChrome>
          <main id="main-content" tabIndex={-1} className="flex-1 focus:outline-none">
            {children}
          </main>
          <SiteChrome>
            <SiteFooter />
          </SiteChrome>
          <CartDrawer />
        </CartProvider>
      </body>
    </html>
  );
}
