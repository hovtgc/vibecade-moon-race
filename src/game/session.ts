import { connect, createMockHost, type VibeCadeClient } from "vibecade-sdk";
import { ACHIEVEMENTS, STATS } from "./catalog";

const MOCK = {
  scoring: "low" as const,
  mode: "practice" as const,
  startDelayMs: 180,
  stats: STATS,
  achievements: ACHIEVEMENTS,
  quiet: true,
};

export async function openSession(): Promise<VibeCadeClient> {
  const embedded = window.parent !== window;
  const ref = document.referrer || "";
  const vibe = /vibecade\.si|twitter\.com|\/\/x\.com/i.test(ref);
  if (!embedded || !vibe) {
    if (!embedded) return connect({ mock: MOCK });
    const host = createMockHost(MOCK);
    return connect({ transport: host.transport, mock: MOCK });
  }
  try {
    return await connect({
      timeoutMs: 1600,
      hostOrigins: [
        "https://www.vibecade.si",
        "https://vibecade.si",
        "https://x.com",
        "https://twitter.com",
      ],
    });
  } catch {
    const host = createMockHost(MOCK);
    return connect({ transport: host.transport, mock: MOCK });
  }
}

export function isRealHost(client: VibeCadeClient) {
  return client.context.host.origin.startsWith("http");
}
