import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { uniq } from "lodash-es";
import { eigenHome, homePaths } from "../src/mastra/lib/home.ts";
import { LABEL, launchdPlist } from "../src/mastra/lib/launchd.ts";

const repo = resolve(import.meta.dirname, "..");
const p = homePaths(eigenHome());
const pkg = createRequire(import.meta.url).resolve("mastra/package.json");
const mastraCli = join(dirname(pkg), JSON.parse(readFileSync(pkg, "utf8")).bin.mastra);

const plist = launchdPlist({
  node: process.execPath,
  mastraCli,
  repo,
  home: p.home,
  logsDir: p.logsDir,
  path: uniq([dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]).join(":"),
});

if (process.argv.includes("--print")) {
  console.log(plist);
} else {
  const file = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  mkdirSync(dirname(file), { recursive: true });
  mkdirSync(p.logsDir, { recursive: true });
  writeFileSync(file, plist);
  const uid = "$(id -u)";
  console.log(`Wrote ${file}`);
  if (!existsSync(join(repo, ".mastra/output"))) console.log("Build first: npm run build");
  console.log(`\nStart:   launchctl bootstrap gui/${uid} ${file}\nStop:    launchctl bootout gui/${uid}/${LABEL}\nRestart: launchctl kickstart -k gui/${uid}/${LABEL}\nLogs:    tail -f ${p.logsDir}/launchd.err.log ${p.logFile}`);
}
