// The Pi SDK spans ~25MB across ~1.5k files (@earendil-works/pi-coding-agent
// plus pi-ai, pi-agent-core, pi-tui). Importing it at module scope makes the
// packaged server pay that load cost before it binds its HTTP port: on Windows
// the files live in app.asar.unpacked and are virus-scanned individually, which
// pushed boot to ~90s and tripped the desktop's 60s backend readiness timeout
// (the window then never opens). Load it on first actual use instead, so boot
// never pays for a provider the user may not be using.

type PiSdk = typeof import("@earendil-works/pi-coding-agent");

let sdkPromise: Promise<PiSdk> | undefined;

export const loadPiSdk = (): Promise<PiSdk> =>
  (sdkPromise ??= import("@earendil-works/pi-coding-agent"));
