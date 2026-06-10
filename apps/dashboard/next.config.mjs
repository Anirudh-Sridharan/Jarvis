/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Phase 4: BFF route handlers read the local SQLite stores directly via
  // @jarvis/integrations and @jarvis/memory. These packages are ESM-only
  // Node.js modules that use node:sqlite (built-in Node >=22).
  // transpilePackages ensures Next.js bundles them for the server runtime.
  transpilePackages: ["@jarvis/integrations", "@jarvis/memory"],
  // Bind to loopback only (single-user, feature 14 requirement).
  // TODO(future): also enforce Host header check in middleware.
};

export default nextConfig;
