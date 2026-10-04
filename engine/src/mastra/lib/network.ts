import dns from "node:dns";
import net from "node:net";

/** How long Node waits for one address of a host to accept the connection before it tries the next (its default is 250 ms) and, for the last address, gives up. */
export const CONNECT_ATTEMPT_MS = 3000;

/**
 * Outbound connections for the whole engine: Telegram, the model APIs, GitHub, remote MCP servers.
 *
 * Node tries a host's addresses one after another, IPv6 first, and the last one fails after only 250 ms. On a link where IPv6 is a dead route
 * and IPv4 takes 200-300 ms to connect, that is a coin flip: measured against api.telegram.org from the maintainer's Mac, 5 of 12 new
 * connections failed with ETIMEDOUT, and every one of 12 worked with 3 s. Mastra logs a failed Telegram start once and never retries it, so a
 * coin flip at boot meant a dead bot. IPv4 goes first so a dead IPv6 route costs nothing; IPv6-only hosts are unaffected.
 */
export function tuneNetwork() {
  dns.setDefaultResultOrder("ipv4first");
  net.setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_MS);
}
