import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The local checkout test stack (scripts/e2e-checkout-local.mjs) builds into
  // its own folder so it never replaces the normal build. Default: .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  /* config options here */
  experimental: {
    agentFeedback: true,
    // Development only. By default the dev server sends React's debug info
    // for every page and action response over the HMR WebSocket, and the
    // browser won't finish a response until that arrives. If the socket drops
    // or reconnects mid-response, the response never finishes: a publish is
    // saved but its buttons stay on "Working…". Off, the debug info travels
    // inside the response itself. Production builds never use the channel.
    reactDebugChannel: false,
    serverActions: {
      // Admin photo uploads (4 MB per photo, lib/admin/photos.ts) plus form
      // overhead. The default is 1 MB. This also caps every other action.
      bodySizeLimit: "4.5mb",
    },
  },
  images: {
    // The widths next/image may ask for. Each width is a separate copy that
    // the image CDN makes per edge node on first request (about a second
    // on Netlify), so fewer widths mean more requests answered from a copy
    // already made. Defaults were 640…3840 and 32…384 (15 widths).
    // Phones: 828 (2x), 1080 and 1200 (3x). Desktop gallery and hero: 1920,
    // 2048. Thumbnails, cart and grid cards: 96, 256, 384.
    deviceSizes: [640, 828, 1080, 1200, 1920, 2048],
    imageSizes: [96, 256, 384],
    qualities: [75],
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
