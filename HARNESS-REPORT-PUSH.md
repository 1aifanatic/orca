# Push worker single-connection load harness: report

Measured 2026-09-30 on main 70475e0228 with a local PostgreSQL 16 in Docker. All runs used real time, the real `DurablePushStore`, `DurablePushWorker`, `PushDispatcher` + `FcmClient`, `reserveRequestConnection`, and either the real `startPushBackground` (#23001 chained scheduler) or a copy of the b0135903633 repeating scheduler.

## Verdict

No. #23001 alone does not restore delivery at 30 deliveries/s on pool 2 in either regime that reproduces the collapse. Where retention DELETEs are slow and a retention backlog exists, the old and new schedulers collapse to the same rate: 13.3/s and 13.1/s. Where database round trips are slow, the pool 2 configurations deliver 2 to 6/s, with prune disabled or not. The chained scheduler removes sweep overlap, but a single sweeper still puts one DELETE ahead of every claim and every finish. Each item needs both, so with 2 s DELETEs four drains get about one item per second. Pool 6 fixes the prune-driven collapse completely: 30.0/s with p50 272 ms, because prune takes one of five slots. Pool 6 does not fix a round-trip-bound worker: 24.8/s at 2 ms added round trip. There the worker loop itself is the ceiling. The single-connection ceiling is 1000 divided by the worker's per-item slot time. It measured about 270/s at local round trips (3.5 to 4 ms per item) and 23 to 26/s at 2 ms added round trip (38 to 43 ms per item). For 30/s the gated statements must average under about 3.7 ms each. Independently of the pool, the worker caps at 33.3/s with a 100 ms provider call. Each tick runs 4 drains of 25 serial items and waits for the next whole second, so 30/s inflow already runs it at 90% utilization.

## Results

Rates are per second over steady minutes 1 to 4 of each 6-minute run (minute 0 warms up, minute 5 overlaps the run end). Inflow is 30/s unless noted. Per-item slot time is claim plus finish hold time on the gated connection divided by claimed items. Prune share is the fraction of gated hold time spent in prune DELETEs.

| Regime | Config | Delivered/s | Expired at dispatch/s | Expired unclaimed/s | p50 / p95 enqueue to delivery | Per-item slot ms | Prune share of slot |
|---|---|---:|---:|---:|---|---:|---:|
| 2 ms added round trip, 5 min pending backlog | A: old scheduler, pool 2 | 3.2 | 16.8 | 10.0 | 300 s / 300 s | 42.0 | 0.2% |
| same | B: #23001, pool 2 | 6.2 | 18.0 | 5.7 | 300 s / 300 s | 38.4 | 0.1% |
| same | C: #23001, pool 6 | 24.8 | 0.2 | 5.0 | 300 s / 300 s | 28.7 | 0.1% |
| same | D: prune off, pool 2 | 2.1 | 17.9 | 10.0 | 300 s / 300 s | 42.9 | 0% |
| local round trip, no backlog (calibration) | A: old scheduler, pool 2 | 30.0 | 0 | 0 | 272 ms / 533 ms | 3.8 | 0.9% |
| same | D: prune off, pool 2 | 30.0 | 0 | 0 | 268 ms / 532 ms | 3.5 | 0% |
| slow DELETE (2 s per 2,000 rows) + 30 min retention backlog | A: old scheduler, pool 2 | 13.3 | 0 | 0 | 137 s / 140 s | 3.5 | 92% |
| same | B: #23001, pool 2 | 13.1 | 0 | 0 | 129 s / 131 s | 3.6 | 92% |
| same | C: #23001, pool 6 | 30.0 | 0 | 0 | 272 ms / 604 ms | 5.0 | 81% |
| slow DELETE, no retention backlog | A: old scheduler, pool 2 | 30.0 | 0 | 0 | 2.6 s / 5.4 s | 3.7 | 41% |
| same | B: #23001, pool 2 | 29.9 | 0 | 0 | 2.9 s / 5.5 s | 3.8 | 43% |
| worker-loop ceiling, 50/s inflow | D: prune off, pool 2 | 33.0 | 0 | 0 | 51 s / 60 s (growing) | 4.1 | 0% |

Details the table hides:

- **The slow-delete backlog runs collapse to about 1 delivery/s while the sweep drains.** That lasts minutes 1 and 2 for both A and B. The worker cycle goes from 105 ms to 4 s in B, and to 8 s in A while two sweeps overlap. A finishes the backlog about a minute earlier because its two overlapping sweeps delete in parallel. After the drain, the 3,500-item queue drains at only the 3/s headroom between 33.3/s and 30/s. Items therefore sit at about 130 s age for roughly 20 minutes. None expired inside the 6-minute window. A longer or saturated retention backlog pushes them past the 5-minute TTL. That is the production signature.
- **A second slow-delete variant charged 2 s per DELETE statement regardless of rows.** It gave A 10.9/s and B 12.2/s, with the same conclusion.
- **The 2 ms regime reproduces the production shape.** The queue sits at the TTL and claims happen with milliseconds to spare. Most claimed items expire at dispatch and the rest expire unclaimed. The worker cycle measured 145 to 175 ms, close to the ~180 ms production per-item time. A, B and D are within run-to-run noise of each other, so prune plays no part there.
- **C at 2 ms is bound by the worker loop, not the pool.** Its cycle of 132 ms makes 25 serial items take 3.3 s, which rounds up to a 4 s tick. That is 100 items per 4 s, 25/s, matching the measured 24.8/s.

## What the harness models faithfully and what it does not

Faithful:

- **Production code under test.** The harness runs the real store SQL (claim, device-head check, dismissal check, lease, finish, `deleteInBatches` with 2,000-row batches and a 50-batch budget) against PostgreSQL. It uses the real FIFO admission gate at `poolMax - 1`, the real pool with 5 s statement timeout, the real worker (4 drains, 25 claims, 1 s tick), and the real dispatcher and FCM client.
- **Inflow.** 30 deliveries/s are enqueued through `DurablePushStore.accept`, the method the `/v1/send` handler calls. Accepts use the ungated pool as in production. 600 hosts × 3 devices keeps every host under the 300-per-15-minute quota. Each event has one recipient, all alerts, TTL from `PUSH_LIMITS` (300 s).
- **Retention state.** Each run seeds 2.59 M `push_events`, 2.59 M `push_event_recipients` and 0.86 M `push_dismissed_events`. `created_at` is spread over the past 24 h at 30/s, 30/s and 10/s, so rows turn prune-eligible at those rates for the whole run. Tables are vacuumed and analyzed. About one minute of eligible rows exists at start, from seeding time. The backlog runs add 30 minutes (55 k events).
- **Pending backlog.** The 2 ms runs start with 9,000 pending deliveries due over the last 5 minutes at 30/s, matching the incident's under-10 k pending table. The calibration and slow-delete runs start empty.
- **Provider.** A fake FCM transport returns 200 after 100 ms.

Not faithful, with the numbers chosen:

- **Round-trip latency is injected, not networked.** Every statement, BEGIN and COMMIT sleeps 0 or 2 ms before running. Sleeps inside a transaction hold the connection. A plain query's sleep does not hold a pooled connection, which slightly under-models request-path pool pressure. 2 ms was chosen because it reproduced the ~180 ms production per-item cycle. It is not a measured Cloud SQL latency. The local Docker round trip comes on top of the injected sleep.
- **Slow DELETEs are injected.** Local deletes of 1,800 rows take about 20 ms because the data is cache-resident. The 2 s per full batch stands in for a cold, IO-bound Cloud SQL delete that touches random primary-key pages of 24 h tables. The value follows the 4 s batch in #23001's own fixture. The real production DELETE duration is the missing measurement.
- **Not modeled:** table and index bloat from continuous deletes, autovacuum, Cloud SQL CPU and IO limits, several Cloud Run instances, APNs, device death, retries, dismissal traffic in the inflow, and sends with more than one recipient.
- **Calibration outcome.** At local round trips, D delivered all inflow as required. A did not collapse, because local prune costs under 1% of the slot. The before-picture needed one of two extra conditions, each tested separately above. Either the connection is slow for everything (A, B and D all collapse), or DELETEs are slow and a retention backlog exists (A and B collapse, D does not). The collapse's onset 24 h after the volume doubled favors the second: at 2 ms round trips, the doubled volume would have collapsed on day one. Cloud SQL Query Insights durations for the prune DELETEs and the claim statements would decide between them.

## Rerun

The harness is opt-in and skips without `ORCA_PUSH_LOAD_POSTGRES_URL`. It requires a port in 55440 to 55449 outside CI. Each configuration takes about 7 minutes: 6 minutes of load plus about 30 s of seeding.

```sh
docker run -d --name push-repro-pg-$USER-$$ --shm-size=1g \
  -e POSTGRES_PASSWORD=push -e POSTGRES_USER=push -e POSTGRES_DB=push \
  -p 55440:5432 postgres:16 -c shared_buffers=256MB -c max_connections=100
cd cloud && pnpm install --frozen-lockfile \
  && pnpm --filter @orca-cloud/postgres-schema build && pnpm --filter @orca-cloud/push-contract build
cd apps/push
export ORCA_PUSH_LOAD_POSTGRES_URL=postgres://push:push@localhost:55440/push

# 2 ms regime, 5-minute pending backlog (default backlog)
ORCA_PUSH_LOAD_RTT_MS=2 ORCA_PUSH_LOAD_CONFIGS=A,B,C,D ORCA_PUSH_LOAD_RESULT_DIR=/tmp/push-load-rtt2 \
  npx vitest run src/durable-push-single-connection-load-postgres.test.ts

# calibration: local round trips, no pending backlog
ORCA_PUSH_LOAD_RTT_MS=0 ORCA_PUSH_LOAD_PENDING_BACKLOG_MS=0 ORCA_PUSH_LOAD_CONFIGS=D,A \
  ORCA_PUSH_LOAD_RESULT_DIR=/tmp/push-load-rtt0 npx vitest run src/durable-push-single-connection-load-postgres.test.ts

# slow DELETE + 30-minute retention backlog (set ORCA_PUSH_LOAD_ELIGIBLE_BACKLOG_MS=0 for the steady variant)
ORCA_PUSH_LOAD_RTT_MS=0 ORCA_PUSH_LOAD_PRUNE_FULL_BATCH_MS=2000 ORCA_PUSH_LOAD_ELIGIBLE_BACKLOG_MS=1800000 \
  ORCA_PUSH_LOAD_PENDING_BACKLOG_MS=0 ORCA_PUSH_LOAD_CONFIGS=A,B,C ORCA_PUSH_LOAD_RESULT_DIR=/tmp/push-load-slowdelete \
  npx vitest run src/durable-push-single-connection-load-postgres.test.ts

# worker-loop ceiling
ORCA_PUSH_LOAD_RTT_MS=0 ORCA_PUSH_LOAD_RATE=50 ORCA_PUSH_LOAD_RETENTION_RATE=30 ORCA_PUSH_LOAD_DURATION_MS=240000 \
  ORCA_PUSH_LOAD_PENDING_BACKLOG_MS=0 ORCA_PUSH_LOAD_CONFIGS=D ORCA_PUSH_LOAD_RESULT_DIR=/tmp/push-load-ceiling \
  npx vitest run src/durable-push-single-connection-load-postgres.test.ts
```

Each configuration writes `<label>.json` with totals and per-minute rows to the result directory. It also prints `push_load_report` and `push_load_minute` lines. Other knobs: `ORCA_PUSH_LOAD_DURATION_MS`, `ORCA_PUSH_LOAD_DISMISSAL_RATE`. Runs on separate containers (55440, 55441, ...) can proceed in parallel.

Files, all under `cloud/apps/push/src` and all test-only:

- `durable-push-single-connection-load-postgres.test.ts`: the configurations.
- `push-load-run.test-fixture.ts`: the driver, inflow, fake transport and outcome-recording store subclass.
- `push-load-seed.test-fixture.ts`: database creation and seeding.
- `push-load-prune-schedulers.test-fixture.ts`: the copied b0135903633 repeating scheduler, next to the real one.
- `push-load-database-instrumentation.test-fixture.ts`: latency injection and the admission-slot ledger.
- `push-load-outcome-report.test-fixture.ts`: the per-minute report.

No production code changed. No seam was needed: the store's `background` constructor argument, `FcmClient`'s `transport`, and subclassing `DurablePushStore` were enough.
