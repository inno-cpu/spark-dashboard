# GLM-5.3-Flash PP4 — integration and safety-stop report

Date: 2026-11-10 UTC
Host: `ffard@192.168.1.145`
Live control surface: Spark dashboard Model Lab at `http://127.0.0.1:3100`
(not the inactive Hqcc checkout)

## Outcome

GLM-5.3-Flash was successfully loaded on all four GPUs through the managed
profile path and registered as one native Xinference Morrowmake model
(`glm53-pp4`, exposed as `glm-5.3-flash`). It answered chat and router requests.

It is **not enabled for production**. During long-context prefill the cards
sustained **260–267 W per GPU against the configured 180 W limit**, including
with `MAX_BATCHED=512` and `MAX_SEQS=1`. The workload was stopped and the
previous Qwen set was restored. The GLM profile is retained in Model Lab as a
**disabled/blocked** entry so it cannot be started accidentally.

This is a hard safety stop, not a throughput judgement. No power-limit,
firmware, PCIe, SMFc, vLLM-runtime or checkpoint changes were made.

## Final live state (Mode A, safe)

- Qwen `qwen38-gpu1`: READY on GPU1, 163,840 context.
- Qwen `qwen38-flashnext`: READY on GPU2, 262,144 context.
- Router: `gpu1` and `gpu2` healthy; `gpu0`/`gpu3` free.
- Spark Model Lab: Qwen profiles loadable; `glm53-pp4` shown as **blocked**.
- GLM container stopped and removed from the running set.
- GLM profile load returns HTTP 409 with the power-safety reason.
- 180 W limits unchanged.

## What was integrated

1. **Native Xinference adapter** — the installed `Morrowmake` engine was
   extended to recognize the GLM family/name and expose the existing adapter
   surface. Chat, streaming, reasoning content, tools and OpenAI-compatible
   usage were exercised. The GLM model is one UID on CPU (`accelerators: []`)
   with the four GPUs represented by the external record.
2. **Managed four-GPU profile** — `/etc/xinference/profiles/glm53-pp4.json`,
   with `gpus: [0,1,2,3]`, runtime metadata and a disabled flag.
3. **Runtime adapter** — `/usr/local/libexec/glm53-runtime` stops the two Qwen
   models, starts the pinned GLM container, waits for health, registers the
   Morrowmake adapter, and restores the saved Qwen set on stop/failure. It is
   called from the existing Spark profile load/unload endpoint; no second GPU
   manager was created.
4. **Telemetry** — the Spark bridge external record is one logical model with
   `gpu_indices: [0,1,2,3]` and all four verified GPU UUIDs. The bridge row was
   checked and there is no adapter + external double-count.
5. **Router** — one model-specific path through the existing GPU0 backend;
   an earlier duplicate GLM backend was removed. Router model listing and chat
   were verified.
6. **Control Center** — Spark's Model Lab shows the managed profile, GPU list,
   and blocked state. Hqcc was not running and was not deployed as a parallel
   control plane.

## Memory / partition results

| Partition | Stage-0 load | Resident MiB (0/1/2/3) | KV tokens | Result |
|---|---|---|---|---|
| 9,12,12,12 | non-fatal 20 MiB allocation warnings on GPU0 | 36,968 / 57,812 / 59,212 / 62,778 | 1,217,513 | retained baseline; warnings real |
| 8,13,12,12 | no stage-0 warnings | 29,674 / 60,432 / 57,954 / 61,520 | 1,088,467 | rejected: GPU1 276 W |

The 8-layer stage 0 removed the startup allocation failures, but it moved a
13th layer onto a 64 GiB card and raised GPU1 power to 276 W. It was stopped.
The 9-layer partition is the only 45-layer layout with no 13-layer stage; its
stage-0 warnings remain a known load-time risk.

## Managed benchmarks (512 generated tokens, warm prefix)

| Context | TTFT s | Decode tok/s | Notes |
|---|---:|---:|---|
| 32K | 0.724 | 116.5 | MAX_BATCHED 2312 |
| 128K | 0.924 | 85.6 | MAX_BATCHED 2312; power violation |
| 256K | 1.439 | 105.8 | MAX_BATCHED 2312; power violation |
| 128K | 1.047 | 92.9 | MAX_BATCHED 512, MAX_SEQS 1; still 260 W |

Qwen Flash-Next reference on the same host: 181.4 / 133.8 / 155.4 tok/s at
32K / 128K / 256K.

## Power evidence

Sampled with `nvidia-smi --query-gpu=index,power.draw` during generation:

- 32K: max observed 183.2 W (brief).
- 128K/256K, batch 2312: **234–267 W** on individual GPUs for many consecutive
  seconds.
- 128K, batch 512, one sequence: **260.8 W**, plus repeated >200 W samples.

The 180 W setting was not changed. This is the operative blocker.

## Rollback

Backups: `/home/ffard/glm53-integration-backup-20261109T224207Z`
(root-owned, contains `/etc/xinference`, `/etc/hyperqwen-control`, Spark/Hqcc
source, adapter, bridge, router and service drop-ins).

- Source: `git -C /home/ffard/spark-dashboard log -1` (see commit hash in the
  handoff).
- Binary backup: `/home/ffard/glm53-test/spark-dashboard.pre-integration`.
- Adapter/bridge backups: `core.py.pre-integration`,
  `spark_bridge.py.pre-integration` in `/home/ffard/glm53-test`.
- Config backups: `flashnext-external.json.pre-integration`,
  `backends.json.pre-integration`, `qwen38-flashnext-256k.json.pre-integration`.
- To remove the feature: restore those files, restore the Spark binary, reload
  systemd, restart `xinference`, `hyperqwen-router` and `spark-dashboard`;
  reload Qwen profiles. No GLM image/checkpoint deletion is required.

## Files

- `/etc/xinference/profiles/glm53-pp4.json` (disabled)
- `/usr/local/libexec/glm53-runtime`
- `/etc/xinference/flashnext-external.json` (GLM record retained, unavailable)
- `/etc/hyperqwen-control/backends.json` (one GLM path removed; Qwen slots intact)
- Spark source: `src/server.rs`, `frontend/src/components/grid/panels/ModelLabPanels.tsx`
- Evidence: `glm-bench-managed-32k.json`, `glm-bench-managed-long.json`,
  `glm-bench-lowbatch-128k.json`
