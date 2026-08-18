import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next.js 16's `next dev` auto-appends an AI-agent-rules block to
  // CLAUDE.md on every run (see node_modules/next/dist/server/lib/generate-
  // agent-files.js). This repo's CLAUDE.md is a hand-authored, load-bearing
  // context file read by every sub-agent (see its own header) -- letting
  // `next dev` silently mutate it on every local run is not something we
  // want. Disabled explicitly rather than relying on nobody noticing the
  // diff before a commit.
  agentRules: false,
};

export default nextConfig;
