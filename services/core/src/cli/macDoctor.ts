/**
 * mac-doctor CLI (D-09/15-SC6): reports every Mac-control TCC grant's real
 * status plus the application bundle macOS will actually attribute a grant
 * to, so the live-verification runbook (15-LIVE-VERIFY-RUNBOOK.md) has one
 * command to run first.
 *
 *   npm run mac-doctor              # human-readable report
 *   npm run mac-doctor -- --json    # JSON report (for pasting into evidence)
 *
 * Exit code 0 when every grant passes, 1 when any grant is missing — usable
 * as a gate in a script, or just read by a human. A non-zero exit reflecting
 * genuinely missing grants on this machine is expected, not a bug.
 */
import "../loadEnv.js"; // MUST be first: populates process.env from .env

import { checkMacGrants, type MacGrantReport, type MacGrantStatus } from "../mac/tccPreflight.js";

const RUNBOOK_PATH = ".planning/phases/15-mac-control-tools-gated-computer-use/15-LIVE-VERIFY-RUNBOOK.md";

function renderResponsibleProcess(report: MacGrantReport): void {
  console.log("Responsible process");
  console.log("─".repeat(64));
  for (const entry of report.responsibleProcess.chain) {
    console.log(`  ${entry.pid}  ${entry.command}`);
  }
  if (report.responsibleProcess.likelyResponsibleApp) {
    console.log(`\nGrant TCC permissions to: ${report.responsibleProcess.likelyResponsibleApp}`);
  } else {
    console.log(
      "\nGrant TCC permissions to: could not infer — read the app name off the consent dialog itself.",
    );
  }
  console.log(`\n${report.responsibleProcess.note}`);
  console.log();
}

function renderGrants(report: MacGrantReport): void {
  console.log("Grants");
  console.log("─".repeat(64));
  for (const grant of report.grants) {
    const marker = grant.granted ? "PASS" : "FAIL";
    console.log(`  [${marker}] ${grant.grant} (tier ${grant.tier})`);
    if (!grant.granted) {
      console.log(`         kind: ${grant.kind}`);
      if (grant.remediation) console.log(`         ${grant.remediation}`);
    }
  }
  console.log();
}

function grantByName(report: MacGrantReport, name: MacGrantStatus["grant"]): MacGrantStatus {
  const found = report.grants.find((g) => g.grant === name);
  if (!found) throw new Error(`internal error: missing grant status for ${name}`);
  return found;
}

function renderTiers(report: MacGrantReport): void {
  console.log("Tiers");
  console.log("─".repeat(64));

  const automation = grantByName(report, "automation-system-events");
  const shortcuts = grantByName(report, "shortcuts");
  const accessibility = grantByName(report, "accessibility");
  const screenRecording = grantByName(report, "screen-recording");

  const tier1Ok = automation.granted && shortcuts.granted;
  const tier2Ok = tier1Ok && accessibility.granted;
  // 15 WR-02: Tier 3 ACTS through AxActionRunner.clickAt / .typeAtFocus,
  // i.e. System Events click/keystroke — both hard-require Accessibility.
  // Reporting Tier 3 OK on a machine with Screen Recording but no
  // Accessibility is a false green on the first command in the runbook.
  const tier3Ok = tier1Ok && screenRecording.granted && accessibility.granted;

  console.log(
    `  Tier 1 (open/script/shortcuts): needs automation-system-events` +
      ` + shortcuts (for mac_run_shortcut) — ${tier1Ok ? "OK" : "DEGRADED"}`,
  );
  console.log(`  Tier 2 (Accessibility UI actions): additionally needs accessibility — ${tier2Ok ? "OK" : "DEGRADED"}`);
  console.log(
    `  Tier 3 (vision-grounded computer use): additionally needs screen-recording` +
      ` (capture) + accessibility (click/type) — ${tier3Ok ? "OK" : "DEGRADED"}`,
  );
  console.log("\n  A missing grant degrades only its own tier — the other tiers keep working independently.");
  console.log();
}

function renderHuman(report: MacGrantReport): void {
  renderResponsibleProcess(report);
  renderGrants(report);
  renderTiers(report);
  console.log(`Full procedure: ${RUNBOOK_PATH}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");

  const report = await checkMacGrants();

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    renderHuman(report);
  }

  // 15 WR-10: set the exit code and let the event loop drain instead of
  // calling process.exit() — process.stdout is ASYNCHRONOUS when piped or
  // redirected (synchronous only for a POSIX TTY), so an immediate exit can
  // truncate the --json report. Redirecting that report to a file is exactly
  // what the runbook's evidence workflow asks for, and a non-zero exit
  // (missing grants) is the common path.
  process.exitCode = report.allGranted ? 0 : 1;
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
