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
