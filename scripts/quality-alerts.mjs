#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.env.QUALITY_STATE_ROOT || ".quality");
const now = Date.now();
const dailyLimit = Number(process.env.QUALITY_DAILY_COST_ALERT_USD || 25);
const weeklyLimit = Number(process.env.QUALITY_WEEKLY_COST_ALERT_USD || 150);
const runsRoot = join(root, "runs");
const runs = existsSync(runsRoot)
  ? readdirSync(runsRoot)
      .map((id) => {
        try {
          return JSON.parse(
            readFileSync(join(runsRoot, id, "run.json"), "utf8")
          );
        } catch {
          return null;
        }
      })
      .filter(Boolean)
  : [];
const costSince = (milliseconds) =>
  runs.reduce((sum, run) => {
    const timestamp = Date.parse(run.updatedAt || run.createdAt || 0);
    return timestamp >= now - milliseconds
      ? sum + Number(run.telemetry?.cost || 0)
      : sum;
  }, 0);
const dailyCost = costSince(24 * 60 * 60 * 1000);
const weeklyCost = costSince(7 * 24 * 60 * 60 * 1000);
const alerts = [
  ...(dailyCost >= dailyLimit
    ? [
        `Daily managed-run cost $${dailyCost.toFixed(2)} reached alert threshold $${dailyLimit.toFixed(2)}.`
      ]
    : []),
  ...(weeklyCost >= weeklyLimit
    ? [
        `Weekly managed-run cost $${weeklyCost.toFixed(2)} reached alert threshold $${weeklyLimit.toFixed(2)}.`
      ]
    : [])
];
console.log(
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      dailyCost,
      weeklyCost,
      dailyLimit,
      weeklyLimit,
      alerts
    },
    null,
    2
  )
);
if (process.argv.includes("--check") && alerts.length) process.exitCode = 1;
