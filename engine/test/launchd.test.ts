import { describe, expect, it } from "vitest";
import { LABEL, launchdPlist } from "../src/mastra/lib/launchd.ts";

const service = { node: "/usr/local/bin/node", mastraCli: "/r/node_modules/mastra/dist/index.js", repo: "/r & co", home: "/Users/sam/.eigen", envFile: "/Users/sam/.eigen/.env", logsDir: "/Users/sam/.eigen/logs", path: "/usr/local/bin:/usr/bin" };

describe("launchd plist", () => {
  const xml = launchdPlist(service);

  it("runs mastra start with the env file, from the repo, and keeps it alive", () => {
    expect(xml).toContain(`<key>Label</key><string>${LABEL}</string>`);
    expect(xml).toContain("<string>/usr/local/bin/node</string><string>/r/node_modules/mastra/dist/index.js</string><string>start</string><string>--env</string><string>/Users/sam/.eigen/.env</string>");
    expect(xml).toContain("<key>RunAtLoad</key><true/>");
    expect(xml).toContain("<key>KeepAlive</key><true/>");
  });

  it("gives the service an explicit PATH and EIGEN_HOME, and never the secrets", () => {
    expect(xml).toContain("<key>EIGEN_HOME</key><string>/Users/sam/.eigen</string>");
    expect(xml).toContain("<key>PATH</key><string>/usr/local/bin:/usr/bin</string>");
    expect(xml).not.toMatch(/TOKEN|API_KEY/);
  });

  it("escapes XML in paths", () => {
    expect(xml).toContain("<string>/r &amp; co</string>");
  });
});
