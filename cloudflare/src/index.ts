/**
 * One Worker, one URL, HTTPS for free — which is what WebXR on the Quest needs.
 *
 * The built VR app (vr/dist) is served as static assets. Anything that is not
 * an asset (/queue, /decisions, /structures, /voice, /bridge, ...) falls
 * through to this Worker and is forwarded to the Gate API running unchanged in
 * a Cloudflare Container. The VR app keeps using relative paths, exactly as it
 * does behind the Vite dev proxy.
 */
import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  GATE: DurableObjectNamespace<GateContainer>;
  // Secrets / vars, set with `wrangler secret put`. All optional: without
  // OPENAI_API_KEY the voice button stays greyed out, and without a reachable
  // BRIDGE_URL the gate serves its mock queue.
  OPENAI_API_KEY?: string;
  WHISPER_MODEL?: string;
  BRIDGE_URL?: string;
  BRIDGE_TOKEN?: string;
}

export class GateContainer extends Container<Env> {
  defaultPort = 8000;
  // State is two JSON files on the container's disk, lost when it sleeps.
  // Keep it awake through a demo session.
  sleepAfter = "2h";

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    const vars: Record<string, string> = {};
    for (const key of ["OPENAI_API_KEY", "WHISPER_MODEL", "BRIDGE_URL", "BRIDGE_TOKEN"] as const) {
      const value = env[key];
      if (value) vars[key] = value;
    }
    this.envVars = vars;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // A single named instance: every headset and browser shares one queue and
    // one audit trail, as they do against the local gate.
    return getContainer(env.GATE, "gate").fetch(request);
  },
} satisfies ExportedHandler<Env>;
