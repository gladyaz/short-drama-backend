# Transcode Worker — VPS Operations Runbook

Work unit **"TRANSCODE WORKER VPS DEPLOYMENT"**.

How to deploy and operate the Red Panda HLS transcoding worker as an
unattended 24/7 process on a VPS.

> **No VPS vendor is chosen here, and none should be.** Everything below is
> expressed in terms of vCPU, RAM, disk and network egress, so it applies to
> any provider. The one hard requirement is that the box can run Docker (or
> Node 22 plus FFmpeg directly) and can reach Redis, Postgres and R2.

---

## 1. What this worker is, and what it is not

```
        ┌──────────────┐        enqueue        ┌──────────────┐
        │  API server  │ ────────────────────► │    Redis     │
        │  (elsewhere) │                       │  (BullMQ)    │
        └──────┬───────┘                       └──────┬───────┘
               │                                      │ consume
      catalog  │                                      ▼
               │                              ┌─────────────────┐
               ▼                              │   THIS  VPS     │
        ┌──────────────┐                      │  FFmpeg compute │
        │  PostgreSQL  │ ◄────────────────────┤  (stateless)    │
        └──────────────┘   claim / promote    └────────┬────────┘
                                                       │ source in
        ┌──────────────────────────────────────────────┴──┐
        │  Cloudflare R2  —  permanent source AND output   │
        └──────────────────────────────────────────────────┘
```

**The VPS is compute only, and holds no durable state.** Sources and HLS
output live in R2, the queue lives in Redis, the catalog lives in Postgres.
The only thing on local disk is per-job scratch, which is deleted after every
job. This is what makes the worker safe to destroy and recreate at will, and
what makes scaling to a second worker a matter of starting another container.

Two processes exist in this repository. They are separate and this runbook
only concerns the second:

| Process | Command | Opens a port? |
|---|---|---|
| API server | `npm run start:prod` (`node dist/main`) | Yes |
| **Transcode worker** | **`npm run worker:transcode`** (`node dist/worker/main`) | **No** |

The worker boots a NestJS *standalone application context* — there is no
`app.listen()` anywhere in its module graph. It dials out; nothing dials in.

---

## 2. VPS requirements

**Minimum to run at all**

| Resource | Requirement |
|---|---|
| vCPU | 2 |
| RAM | 4 GB |
| Disk | 40 GB SSD |
| OS | Any current Linux with Docker support (Ubuntu 22.04/24.04 LTS and Debian 12 are the common choices) |
| Network | Outbound HTTPS (443) to R2, outbound to Redis and Postgres |

**Why disk matters more than it looks.** A single job holds a fully
downloaded source file *and* a complete multi-rung HLS package in the temp
directory at the same time. Budget, per concurrent job, several times the
size of your largest source file — then add the container image (~1.5 GB with
FFmpeg) and log space on top.

**Inbound firewall: close everything.** The worker needs no inbound port. If
Redis and Postgres are not on a private network, restrict them by IP at their
end, and prefer `rediss://` (TLS) over `redis://`.

---

## 3. Docker installation

Use Docker's official convenience script or your distribution's documented
`docker-ce` repository steps. On a Debian/Ubuntu box:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"    # log out and back in for this to apply
docker --version
docker compose version             # Compose v2 is required (note: no hyphen)
```

Verify before continuing:

```bash
docker run --rm hello-world
```

> **Not using Docker?** Section 12 covers running the worker directly under
> systemd with Node 22 and a distribution FFmpeg.

---

## 4. Required environment variables

Create `.env.worker` on the VPS (never commit it; `.dockerignore` keeps it
out of the image). Start from `.env.production.example`.

### 4.1 Always required

The worker reuses the API's `validateEnv` verbatim — one source of truth for
what every variable in this repo means — so a few API-shaped variables are
required even though the worker never serves a request.

| Variable | Notes |
|---|---|
| `PORT` | Required by the shared validator. The worker never binds it. |
| `PUBLIC_BASE_URL` | Required by the shared validator. Must be `https://` under `NODE_ENV=production`. |
| `STORAGE_ROOT` | Must be set **and be an existing directory**, checked unconditionally *before* `STORAGE_DRIVER` is even read. The image ships `/app/storage` for exactly this reason; nothing is written there when the driver is `r2`. |
| `DATABASE_URL` | The catalog. The worker claims, updates and promotes rows. |
| `JWT_ACCESS_SECRET` | Required by the shared validator. |
| `JWT_REFRESH_SECRET` | Must be **different** from `JWT_ACCESS_SECRET`. |
| `AUTH_AUDIT_IP_HASH_SECRET` | Must be **different** from both of the above. |

### 4.2 Required to actually consume jobs

| Variable | Value | Notes |
|---|---|---|
| `TRANSCODE_ENABLED` | `true` | The **exact string** `"true"`. Anything else — `TRUE`, `1`, `yes` — resolves to false and the worker boots, logs a readiness summary and exits 0 without touching Redis. |
| `REDIS_URL` | `redis://…` or `rediss://…` | Shape-checked at boot; **not** dialled at boot. |
| `HLS_TOKEN_SECRET` | a dedicated secret | Must differ from all three secrets above. Shared with the HLS delivery Worker. |
| `HLS_GATEWAY_BASE_URL` | `https://…` | The playback gateway origin. |

### 4.3 Required when `STORAGE_DRIVER=r2` (the production posture)

`OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_REGION`, `OBJECT_STORAGE_BUCKET`,
`OBJECT_STORAGE_ACCESS_KEY_ID`, `OBJECT_STORAGE_SECRET_ACCESS_KEY`.

### 4.4 Worker runtime tuning (all optional)

| Variable | Default | Purpose |
|---|---|---|
| `TRANSCODE_WORKER_CONCURRENCY` | `1` | Jobs run at once by **one** worker process. See §6. |
| `TRANSCODE_TEMP_DIR` | `os.tmpdir()` (image sets `/app/tmp`) | Parent of each job's isolated scratch directory. |
| `TRANSCODE_TEMP_SWEEP_MIN_AGE_MINUTES` | `120` | Age before stranded scratch is reclaimed. See §8. |
| `TRANSCODE_MAX_ATTEMPTS` | `3` | Attempts per generation before permanent failure. |
| `TRANSCODE_STALLED_AFTER_MINUTES` | `30` | How long a row may sit `running` before the janitor fails it as `STALE`. |
| `TRANSCODE_CLEANUP_GRACE_MINUTES` | `120` | Age before an orphaned R2 staging prefix is deleted. |

Every one of these fails the boot **loudly, naming the variable**, if set to
something that is not a positive integer. That is deliberate: a silent
fallback to the default would leave you believing a change took effect when
it did not.

**Secrets are never logged.** Validation errors name variables, never values,
and every log line passes through a redaction layer.

---

## 5. Pre-flight verification

Run these **before** starting the worker. Each isolates one dependency, so a
failure points at exactly one thing.

### 5.1 One command that checks everything

```bash
docker compose -f docker-compose.worker.yml run --rm transcode-worker \
  node dist/worker/health-main
```

Or, on a non-Docker install: `npm run worker:health`.

It prints one JSON line and exits `0` (healthy) or `1` (not):

```json
{"healthy":true,"checks":[
  {"name":"process","ok":true},
  {"name":"config","ok":true},
  {"name":"ffmpeg","ok":true,"detail":"ffmpeg version 5.1.6-0+deb12u1"},
  {"name":"ffprobe","ok":true,"detail":"ffprobe version 5.1.6-0+deb12u1"},
  {"name":"redis","ok":true,"latencyMs":3}]}
```

The report never contains a credential — the Redis check reports reachability
and latency, never the URL it dialled.

> The database is deliberately **not** probed. It is a real dependency, but a
> brief Postgres blip would otherwise flap this check and make Docker restart
> a worker whose queue and encoder are both fine — and restarting mid-encode
> is the expensive failure. DB problems surface as job failures with durable
> error codes instead.

### 5.2 FFmpeg

```bash
docker compose -f docker-compose.worker.yml run --rm transcode-worker ffmpeg -version
docker compose -f docker-compose.worker.yml run --rm transcode-worker ffprobe -version
```

Both are required. `ffprobe` reads the source's dimensions and duration, which
decide the rendition ladder; `ffmpeg` does the encoding. A worker missing
either consumes jobs and fails every one of them — which looks like a media
problem and is not.

### 5.3 Redis connectivity

```bash
redis-cli -u "$REDIS_URL" ping          # expect: PONG
redis-cli -u "$REDIS_URL" --no-auth-warning info server | head -5
```

Confirm you are pointed at **the same Redis the API enqueues to**. A worker
pointed at a different (or freshly started, empty) Redis looks perfectly
healthy and never receives a job. This is the single most common
first-deploy mistake, and it is silent.

### 5.4 R2 connectivity

R2 credentials are exercised by the first real job. To check them ahead of
time, use any S3-compatible client against the same endpoint and bucket:

```bash
aws s3 ls "s3://$OBJECT_STORAGE_BUCKET/admin-media/" \
  --endpoint-url "$OBJECT_STORAGE_ENDPOINT" --region auto | head
```

If R2 is unreachable or the credentials are wrong, jobs fail with
`SOURCE_MISSING` (download) or `UPLOAD_FAILED` (upload). Note that a missing
`ca-certificates` package produces the *same* `SOURCE_MISSING` symptom — the
provided image installs it for that reason.

---

## 6. Concurrency sizing

`TRANSCODE_WORKER_CONCURRENCY` sets how many jobs **one worker process** runs
at once. The default is `1` and it is **never** derived from `os.cpus().length`.

**Why not one job per core.** FFmpeg already parallelises across cores within
a single encode, so a second concurrent job competes with the first for the
same cores while adding a whole extra copy of the memory *and disk* cost — a
full downloaded source plus a complete HLS package. On a small VPS you hit
the RAM or disk ceiling long before the CPU ceiling, and the failure mode is
an OOM kill or a full disk mid-encode rather than gradual slowdown.

| VPS size | Suggested starting point | Reasoning |
|---|---|---|
| **2 vCPU / 4 GB** | `1` | One encode can already use both cores. A second job mainly risks memory pressure. |
| **4 vCPU / 8 GB** | `1`, then try `2` | Enough headroom for a second job — but confirm against your own sources before keeping it. |
| **8 vCPU / 16 GB** | `2`, then try `3`–`4` | Diminishing returns arrive well before 8: FFmpeg's own threading, disk I/O and R2 upload bandwidth all become the constraint before cores do. |

> **No throughput figure is stated here on purpose.** Encode time depends on
> source resolution, duration, bitrate, codec and the ladder produced for that
> source. Any minutes-per-episode number quoted before benchmarking *your*
> catalogue on *your* box would be fiction. Measure first (§7.3), then decide.

**How to raise it safely**

1. Change one value at a time and restart (§9).
2. Watch `docker stats` and `df -h` through a full wave.
3. Keep it if peak memory stays comfortably under the box's RAM and the temp
   volume never approaches full. Otherwise go back.

Running **two workers at concurrency 1** is often preferable to **one worker
at concurrency 2** — the blast radius of a crash is one job, and the
restarts are independent. See §15.

---

## 7. Starting the worker

### 7.1 First deploy

```bash
git clone <your-repo-url> red-panda-backend
cd red-panda-backend
git checkout <release-tag-or-branch>

cp .env.production.example .env.worker
$EDITOR .env.worker                        # §4

docker compose -f docker-compose.worker.yml run --rm transcode-worker \
  node dist/worker/health-main             # must exit 0

docker compose -f docker-compose.worker.yml up -d --build
```

### 7.2 Confirm it is consuming

```bash
docker compose -f docker-compose.worker.yml ps
docker compose -f docker-compose.worker.yml logs --tail=50 transcode-worker
```

A healthy start logs the readiness summary, the startup temp sweep, and:

```
Transcode worker started — persistent mode (TRANSCODE_ENABLED=true), concurrency 1.
```

### 7.3 Measure a first job

```bash
docker compose -f docker-compose.worker.yml logs transcode-worker \
  | grep 'transcode.job' \
  | sed 's/.*transcode\.job //' \
  | jq -c 'select(.outcome=="promoted") | {videoId, generation, durationMs}'
```

`durationMs` against that source's own duration is your real
seconds-of-encode-per-second-of-video ratio — the number §6 deliberately
refuses to guess.

---

## 8. Disk monitoring

Three things consume disk, and each has its own bound.

| Consumer | Bound | Check |
|---|---|---|
| Per-job scratch | Deleted in a `finally` after **every** job, success or failure | `docker system df -v \| grep transcode_tmp` |
| Stranded scratch | Age-based sweep at startup **and** every 5 minutes | Startup log line `Startup temp sweep — {...}` |
| Container logs | `max-size: 20m` × `max-file: 5` in the compose file | `du -sh /var/lib/docker/containers/*/` |

**Routine check**

```bash
df -h /var/lib/docker
docker system df
```

**What the sweep does and does not do.** A `SIGKILL`, an OOM kill or a power
loss skips the normal per-job cleanup, stranding a directory that can hold
several GB. The sweep removes leftovers that (a) carry this pipeline's own
`11p-transcode-worker-` prefix and (b) are older than
`TRANSCODE_TEMP_SWEEP_MIN_AGE_MINUTES`. Both conditions are load-bearing: the
prefix means it can never touch another application's files in a shared
`/tmp`, and the age means it can never delete scratch belonging to a
*concurrently running* job on a shared volume. It never throws — a sweep
failure must not prevent a worker from starting.

**If the disk fills anyway**, stop the worker, inspect, then let the restart
sweep reclaim it:

```bash
docker compose -f docker-compose.worker.yml stop transcode-worker
docker run --rm -v red-panda-backend_transcode_tmp:/t alpine sh -c 'ls -la /t'
docker compose -f docker-compose.worker.yml start transcode-worker   # sweeps on boot
```

Separately, R2 storage for superseded generations is reclaimed by the janitor
after `TRANSCODE_CLEANUP_GRACE_MINUTES`. That is object storage, not this box.

---

## 9. Restart, stop and the shutdown contract

```bash
docker compose -f docker-compose.worker.yml restart transcode-worker
docker compose -f docker-compose.worker.yml stop    transcode-worker
docker compose -f docker-compose.worker.yml up -d   transcode-worker
```

**What SIGTERM does.** The worker stops taking new jobs immediately, then
waits for the in-flight job to reach a safe boundary — it finishes uploading,
validating and promoting, or it fails and durably records why — and only then
closes down. A job is never abandoned mid-upload, so a partial HLS generation
is never left in R2.

**This is why `stop_grace_period: 30m` exists in the compose file.** Docker's
default is **10 seconds**, after which it sends `SIGKILL`. With the default,
every `docker compose down` during an encode would kill it. Set the grace
period above the longest encode this box realistically runs.

A job killed anyway is still **not lost**: it was never acknowledged as
complete, so BullMQ's stalled-job detection redelivers it, and the DB-level
janitor recovers any row left `running`. `restart: unless-stopped` brings the
worker back after a crash or host reboot, while still honouring a deliberate
`stop`.

---

## 10. Logs

```bash
docker compose -f docker-compose.worker.yml logs -f transcode-worker
docker compose -f docker-compose.worker.yml logs --since 1h transcode-worker
```

Alongside human-readable lines, every job lifecycle event is emitted as one
structured, greppable line tagged `transcode.job`:

```
transcode.job {"videoId":"video-104-02","jobId":"video-104-02__v3",
  "generation":"v3-a1-2637db26","stage":"transcode","outcome":"failed",
  "durationMs":91234,"failureCategory":"TRANSCODE_FAILED","terminal":false,
  "attempt":1,"maxAttempts":3,"errorDetail":"HLS transcode failed: ..."}
```

| Field | Meaning |
|---|---|
| `videoId` | The media row. |
| `jobId` | The BullMQ job id — the same string you will find in Redis. |
| `generation` | `v<version>-a<attempt>-<uuid>`, **exactly** the R2 directory name. `null` before an attempt is claimed. |
| `stage` | `claim`, `download`, `probe`, `transcode`, `packaging`, `uploading`, `verifying`, `poster`, `promote`. |
| `outcome` | `accepted`, `promoted`, `failed`, `superseded`. |
| `durationMs` | Wall-clock since this delivery was accepted. |
| `failureCategory` | The durable error code, or the superseded reason. |

**Which stage is failing most, over the last day:**

```bash
docker compose -f docker-compose.worker.yml logs --since 24h transcode-worker \
  | grep 'transcode.job' | sed 's/.*transcode\.job //' \
  | jq -r 'select(.outcome=="failed") | .stage' | sort | uniq -c | sort -rn
```

**Never logged:** R2 credentials, the Redis password, `Bearer` tokens,
`user:password@` in a connection string, and `X-Amz-Signature` /
`X-Amz-Credential` / `X-Amz-Security-Token` in a presigned URL. All are
stripped by the redaction layer, including inside `errorDetail`.

---

## 11. Queue inspection

The queue is **`media-transcode`**, so every Redis key is prefixed
`bull:media-transcode:`. Job ids are `<videoId>__v<processingVersion>` — the
separator is `__v` and **not** a colon, because BullMQ rejects a custom job id
containing `:`.

```bash
redis-cli -u "$REDIS_URL" LLEN bull:media-transcode:wait       # queued
redis-cli -u "$REDIS_URL" LLEN bull:media-transcode:active     # in progress
redis-cli -u "$REDIS_URL" ZCARD bull:media-transcode:failed
redis-cli -u "$REDIS_URL" ZCARD bull:media-transcode:completed
redis-cli -u "$REDIS_URL" ZCARD bull:media-transcode:delayed   # awaiting backoff

# One specific job:
redis-cli -u "$REDIS_URL" HGETALL bull:media-transcode:video-104-02__v3
```

Cross-check against the catalog, which is the real source of truth:

```sql
SELECT "processingState", COUNT(*) FROM "Video" GROUP BY 1;

SELECT id, "processingVersion", "processingAttempts",
       "processingStep", "processingErrorCode", "updatedAt"
FROM "Video" WHERE "processingState" = 'running' ORDER BY "updatedAt";
```

| Symptom | Likely cause |
|---|---|
| `wait` grows, `active` stays 0 | Worker is down, or pointed at a different Redis. |
| Rows stuck `running`, `active` is 0 | Worker died mid-job. The janitor fails them `STALE` after `TRANSCODE_STALLED_AFTER_MINUTES`; BullMQ also redelivers. |
| Everything fails at `download` | R2 credentials, bucket, or missing `ca-certificates`. |
| Everything fails at `probe` | `ffprobe` missing, or genuinely unreadable sources. |

Retries are **queue-side**: 3 attempts with exponential backoff (≈1 m → 5 m →
25 m), configured when the job is created, not by the worker.

---

## 12. Alternative: systemd, without Docker

Only if you would rather not run Docker. Requires Node 22 and FFmpeg from the
distribution.

```bash
sudo apt-get install -y ffmpeg
node --version                  # must be 22.x
npm ci && npx prisma generate && npm run build
```

`/etc/systemd/system/red-panda-transcode-worker.service`:

```ini
[Unit]
Description=Red Panda HLS transcode worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=redpanda
WorkingDirectory=/opt/red-panda-backend
EnvironmentFile=/opt/red-panda-backend/.env.worker
ExecStartPre=/usr/bin/node dist/worker/health-main
ExecStart=/usr/bin/node dist/worker/main

Restart=always
RestartSec=10

# THE CRITICAL LINE — the systemd equivalent of stop_grace_period. systemd's
# default TimeoutStopSec would SIGKILL an encode long before it finishes.
KillSignal=SIGTERM
TimeoutStopSec=1800

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/tmp/red-panda-transcode

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now red-panda-transcode-worker
sudo journalctl -u red-panda-transcode-worker -f
```

Set `TRANSCODE_TEMP_DIR=/var/tmp/red-panda-transcode` to match
`ReadWritePaths`. `PrivateTmp=true` gives the unit its own `/tmp`, which is
another reason to name the temp directory explicitly.

> **PM2 is deliberately not used.** This repository has no PM2 dependency or
> configuration, and Docker's restart policy and systemd each already provide
> supervision. Adding PM2 would mean a third supervisor to reason about.

---

## 13. Safe upgrade

The worker is stateless, so an upgrade is a rebuild plus a restart. The only
care needed is around an in-flight job.

```bash
cd /opt/red-panda-backend
git fetch --all --tags
git log --oneline -1                      # RECORD THIS — it is your rollback target

git checkout <new-release-tag>

# 1. Build the new image WITHOUT touching the running worker.
docker compose -f docker-compose.worker.yml build

# 2. Validate the new image before it takes a single job.
docker compose -f docker-compose.worker.yml run --rm transcode-worker \
  node dist/worker/health-main

# 3. Optional but recommended: let the queue drain first, so no job is
#    interrupted at all. Wait for `active` to reach 0.
redis-cli -u "$REDIS_URL" LLEN bull:media-transcode:active

# 4. Swap. The old container gets SIGTERM and drains within stop_grace_period.
docker compose -f docker-compose.worker.yml up -d

# 5. Confirm.
docker compose -f docker-compose.worker.yml logs --tail=30 transcode-worker
```

**Database migrations are not run here.** The API server owns
`prisma migrate deploy`. Migrate before deploying a worker that expects a new
column.

---

## 14. Rollback

```bash
git checkout <previous-tag-recorded-in-step-13>
docker compose -f docker-compose.worker.yml build
docker compose -f docker-compose.worker.yml run --rm transcode-worker \
  node dist/worker/health-main
docker compose -f docker-compose.worker.yml up -d
```

Rolling the worker back is safe because it owns no state: any job interrupted
by the swap is redelivered, and any row left `running` is recovered by the
janitor.

**Rolling back the worker does not undo its output.** A generation already
promoted stays live and stays playable. To retire a bad generation, use the
separate demote tool (`npm run hls:demote`, `docs/HLS_TRANSCODE_WAVE.md`) —
that is a catalog decision, not a deployment one.

**Emergency stop — drain without deploying anything:**

```bash
docker compose -f docker-compose.worker.yml stop transcode-worker
```

Jobs accumulate in `wait` and are picked up when a worker returns. Nothing is
lost.

---

## 15. Scaling to Worker #2 and #3

Because the VPS holds no state, adding workers means starting more of them.
They coordinate entirely through Redis and Postgres: BullMQ hands each job to
exactly one worker, and the database claim (`queued` → `running`) is a
compare-and-set, so two workers cannot process the same generation.

**Option A — a second VPS (preferred).** Repeat §3–§7 on a new box with the
same `.env.worker`. No configuration changes anywhere; the API does not need
to know how many workers exist. This isolates failures and lets you scale
across regions.

**Option B — a second container on the same box.** Only if the box has spare
RAM *and* disk:

```bash
docker compose -f docker-compose.worker.yml up -d --scale transcode-worker=2
```

Give each replica its **own** temp volume. Sharing one is not a correctness
problem — the sweep is age-bounded precisely so it cannot delete a live job's
scratch — but it does mean two workers competing for the same disk budget,
which makes a disk-full failure hit both at once.

**Checklist before adding a worker**

- [ ] Is the queue actually backlogged? (`LLEN bull:media-transcode:wait`)
- [ ] Is the existing worker CPU-bound, or waiting on R2 upload bandwidth?
      A second worker fixes the first and worsens the second.
- [ ] Can Postgres take more concurrent connections?
- [ ] Can R2 egress absorb parallel downloads?

**What does *not* need to change:** the queue name, the job id scheme, the API
server, and the R2 layout. Generation prefixes are unique per attempt
(`v<version>-a<attempt>-<uuid>`), so two workers can never write to the same
prefix.

---

## 16. Troubleshooting quick reference

| Symptom | First check |
|---|---|
| Container restarts in a loop | `docker compose -f docker-compose.worker.yml logs`. A config error names the offending variable. |
| Health check fails on `config` | A missing/invalid variable, or `STORAGE_ROOT` not an existing directory (§4.1). |
| Health check fails on `ffmpeg` | Rebuild the image; on systemd, `apt-get install ffmpeg`. |
| Health check fails on `redis` | Wrong `REDIS_URL`, firewall, or Redis down. §5.3. |
| Healthy, but no jobs consumed | `TRANSCODE_ENABLED` is not the exact string `true`, or the worker points at a different Redis than the API. |
| Every job fails at `download` | R2 credentials/bucket, or missing `ca-certificates`. |
| Disk filling | §8. Check the temp volume and log rotation. |
| Jobs stuck `running` after a crash | Expected. The janitor fails them `STALE` after `TRANSCODE_STALLED_AFTER_MINUTES`; BullMQ redelivers. |
| Worker will not stop | It is draining an encode by design. Wait for `stop_grace_period`. |

---

## 17. Related documents

| Document | Covers |
|---|---|
| `docs/HLS_TRANSCODE_WAVE.md` | Enqueuing a transcode wave; the demote tool |
| `docs/PRODUCTION_DEPLOYMENT_REQUIREMENTS.md` | API server deployment |
| `docs/r2-readiness.md` | R2 bucket and credential setup |
| `docs/V1_STAGING_RUNBOOK.md` | Full V1 staging procedure |
| `.env.production.example` | Every variable, with inline rationale |
