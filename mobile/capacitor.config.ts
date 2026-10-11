import type { CapacitorConfig } from '@capacitor/cli';
import { APP } from '../src/shared/app.config';

// The PC is reached over plain http on the shop LAN, so the app itself is served on http and cleartext is allowed.
const config: CapacitorConfig = {
  appId: 'dz.phonestoremanager.app.mobile',
  appName: APP.name,
  webDir: 'dist',
  server: { androidScheme: 'http', cleartext: true },
  android: { allowMixedContent: true },
  plugins: { CapacitorHttp: { enabled: false } }, // requests go through CapacitorHttp.request() explicitly (src/lib/http.ts)
};

export default config;
