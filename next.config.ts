import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The SQLite driver is a native module: keep it external to the bundle.
  serverExternalPackages: ["better-sqlite3"],
  // Local-first distribution. `standalone` emits a self-contained server bundle
  // under `.next/standalone` so the desktop launchers can start the app with a
  // plain `node server.js` — no `npm install` and no build step at launch time.
  // `better-sqlite3` is copied into that output by Next precisely because it is
  // declared external above, which keeps the native addon resolvable.
  output: "standalone",
};

export default nextConfig;
