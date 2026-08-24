import test from "node:test";
import assert from "node:assert/strict";

import { scheduleFleetJobs } from "./fleet.mjs";

function queuedJobs(count) {
  return Array.from({ length: count }, (_, index) => ({
    prompt: `job ${index + 1}`,
    state: "queued",
    pid: null
  }));
}

test("fleet scheduling never launches above the configured concurrency", () => {
  const alive = new Set();
  let nextPid = 100;
  let launches = 0;
  let peak = 0;
  const record = { concurrency: 2, jobs: queuedJobs(5) };
  const launchJob = () => {
    const pid = nextPid++;
    alive.add(pid);
    launches += 1;
    peak = Math.max(peak, alive.size);
    return { pid, id: `background-${pid}` };
  };
  const isAlive = (pid) => alive.has(pid);

  scheduleFleetJobs(record, { launchJob, isAlive });
  assert.equal(launches, 2);
  assert.deepEqual(
    record.jobs.map((job) => job.state),
    ["running", "running", "queued", "queued", "queued"]
  );

  record.jobs[0].exitCode = 0;
  scheduleFleetJobs(record, { launchJob, isAlive });
  assert.equal(launches, 2, "a live finishing worker still occupies its slot");

  alive.delete(record.jobs[0].pid);
  scheduleFleetJobs(record, { launchJob, isAlive });
  assert.equal(launches, 3);
  assert.equal(record.jobs[0].state, "completed");
  assert.equal(record.jobs[2].state, "running");
  assert.equal(peak, 2);
});

test("a dead worker fails closed and frees one slot", () => {
  const alive = new Set([201]);
  const record = {
    concurrency: 1,
    jobs: [
      { prompt: "old", state: "running", pid: 200 },
      { prompt: "next", state: "queued", pid: null }
    ]
  };

  scheduleFleetJobs(record, {
    isAlive: (pid) => alive.has(pid),
    launchJob: () => ({ pid: 201, id: "background-201" })
  });

  assert.equal(record.jobs[0].state, "failed");
  assert.equal(record.jobs[0].exitCode, 1);
  assert.match(record.jobs[0].error, /without terminal metadata/u);
  assert.equal(record.jobs[1].state, "running");
  assert.equal(record.jobs[1].pid, 201);
});
