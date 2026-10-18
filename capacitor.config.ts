import type { CapacitorConfig } from '@capacitor/cli';

// FairSwap native shell — REMOTE-URL mode (see docs/CAPACITOR.md).
// The product is a server-backed Next.js app (identify + catalog APIs
// cannot be statically exported), so the shell loads the live web
// deployment and the native projects contribute the camera/haptics/
// share bridges, the app icon, and the store presence. One codebase:
// whatever ships to Vercel is what the apps run, instantly.
//
// The URL is overridable for staging/preview shells:
//   CAP_SERVER_URL=https://<preview>.vercel.app npx cap sync
const serverUrl = process.env.CAP_SERVER_URL || 'https://card-trade-checker.vercel.app';

const config: CapacitorConfig = {
  appId: 'app.fairswap',
  appName: 'FairSwap',
  // NOT the Next.js build output: a minimal bundled fallback page
  // (brand splash + retry) that only surfaces if the remote app is
  // unreachable. The real UI always comes from server.url.
  webDir: 'native-shell',
  server: {
    url: serverUrl,
    cleartext: false,
    // Keep navigation inside the shell for our own origins; anything
    // else (gift links opened externally, store links) goes to the
    // system browser as usual.
    allowNavigation: ['card-trade-checker.vercel.app', '*.vercel.app'],
  },
  backgroundColor: '#00596B',
};

export default config;
