import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));

function gitShortSha() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: new URL('.', import.meta.url) }).toString().trim();
  } catch {
    return '';
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // strict mode double-fires effects; noisy while watching a live canvas
  env: {
    // Baked in at server start, not live — a fresh version each time the app restarts.
    NEXT_PUBLIC_APP_VERSION: pkg.version,
    NEXT_PUBLIC_GIT_SHA: gitShortSha(),
  },
};

export default nextConfig;
