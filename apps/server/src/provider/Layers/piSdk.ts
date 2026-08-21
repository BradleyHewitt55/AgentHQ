// The Pi SDK spans ~25MB across ~1.5k files (@earendil-works/pi-coding-agent
// plus pi-ai, pi-agent-core, pi-tui). Importing it at module scope makes the
// packaged server pay that load cost before it binds its HTTP port: on Windows
// the files live in app.asar.unpacked and are virus-scanned individually, which
// pushed boot to ~90s and tripped the desktop's 60s backend readiness timeout
// (the window then never opens). Load it on first actual use instead, so boot
// never pays for a provider the user may not be using.

type PiSdk = typeof import("@earendil-works/pi-coding-agent");

let sdkPromise: Promise<PiSdk> | undefined;

// pi-ai loads each OAuth flow (anthropic, openai-codex, ...) through a relative
// dynamic `import()` resolved off that module's own `import.meta.url`, to keep
// bundlers from following Node-only code (node:http, node:crypto) into browser
// builds. That resolution breaks for pi-coding-agent's own standalone Bun
// binary, which pi-ai works around via `registerBunOAuthFlows()` — eagerly
// importing every flow up front so the lazy relative import is never taken.
// The packaged Electron app hits the same class of failure (relative dynamic
// imports resolved against an app.asar-based `import.meta.url`), surfacing as
// an instant "OAuth auth derivation failed" with the real cause swallowed by
// pi-ai's generic wrapper. Registering the same way here sidesteps it.
const registerOAuthFlows = (): Promise<void> =>
  import("@earendil-works/pi-ai/bun-oauth").then((mod) => mod.registerBunOAuthFlows());

export const loadPiSdk = (): Promise<PiSdk> =>
  (sdkPromise ??= Promise.all([
    import("@earendil-works/pi-coding-agent"),
    registerOAuthFlows(),
  ]).then(([sdk]) => sdk));
