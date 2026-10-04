import { map, toPairs } from "lodash-es";

export const LABEL = "ai.eigen.agent";

export type Service = { node: string; mastraCli: string; repo: string; home: string; logsDir: string; path: string };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const str = (s: string) => `<string>${esc(s)}</string>`;

/**
 * A launch agent that keeps `mastra start` running. launchd's PATH is bare, so node and the usual tool dirs are given explicitly (the sandbox
 * inherits PATH from here). No --env: every agent reads its own .env, and nothing secret is ever put in the engine's environment.
 */
export const launchdPlist = (s: Service) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${str(LABEL)}
  <key>ProgramArguments</key>
  <array>${map([s.node, s.mastraCli, "start"], str).join("")}</array>
  <key>WorkingDirectory</key>${str(s.repo)}
  <key>EnvironmentVariables</key>
  <dict>${map(toPairs({ EIGEN_HOME: s.home, PATH: s.path }), ([k, v]) => `<key>${k}</key>${str(v)}`).join("")}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key>${str(`${s.logsDir}/launchd.out.log`)}
  <key>StandardErrorPath</key>${str(`${s.logsDir}/launchd.err.log`)}
</dict>
</plist>
`;
