# GLM-5.3-Flash power discrepancy — resolution and safe enablement

Date: 2026-11-10 UTC  
Host: `ffard@192.168.1.145`

## Outcome

The 260–267 W readings were **instantaneous NVML power samples**, not sustained
power. The 180 W policy is an **averaged/firmware power ceiling**; it is active
and enforced, but it does not clip individual instantaneous samples. The earlier
~185 W observation was a sparse manual sample taken during a **cached decode**
run, not a continuous trace of cold prefill.

Under a 20 Hz NVML trace and a conservative hard guard (stop if any rolling
**5 s mean** exceeded **185 W**), GLM completed cold 32K, 128K, and 262K
prefill plus 512-token generation:

- highest instantaneous sample: **287.35 W**
- highest rolling 5 s mean: **146.22 W**
- guard trips: **0**
- NVML enforced limit: **180 W** on all four GPUs
- SW Power Capping counters advanced during the run
- no thermal throttle, Xid, power fault, or Prometheus power alert

The GLM profile is therefore **enabled** in Model Lab. It is not currently
loaded; Qwen is the active workload. Qwen → GLM → Qwen was exercised through
the existing Spark endpoint.

## 1. Original vs managed experiment

### Same

- Image: `glm53-pinned:local`,
  `sha256:18a2f26207568128e1d792ce923e86a74e40def1e43e492db83132cab8cdbe14`;
  engine revision `819146023facb31c04f1f8512e52464835a10d40`.
- Target and DFlash2 checkpoints: same paths and verified hashes
  (`checkpoint-verification.json`).
- Layer partition: `9,12,12,12`; TP1/PP4; `CUDA_VISIBLE_DEVICES=0,1,2,3`.
- `max_model_len=262144`, `gpu_memory_utilization=0.95`, block size 4608.
- `max_num_batched_tokens=2312`, `max_num_seqs=4`.
- DFlash2: method `dflash`, 7 speculative tokens, adaptive K.
- P2P off; same four physical UUIDs.
- 180 W policy applied at boot by `cmp-gpu-power-policy.service`; no runtime
  power-limit change.
- Qwen engines were stopped for both GLM runs.

### Different

| Item | Original | Managed |
|---|---|---|
| Launch | recipe `start.sh`; boot check delegated after health | `glm53-runtime`; `BOOT_CHECK=0` |
| Model start | cold process; prior benchmark runs had already populated prefix cache | cold process for each managed run |
| 128K “warm” step | **0.908 s TTFT** (cached) | **20.03 s** (cold) |
| 256K “warm” step | **1.495 s TTFT** (cached) | **28.99 s** (cold) |
| Power instrumentation | no continuous trace; one manual `nvidia-smi` observation (~185 W) | 2 s sampling initially; 20 Hz NVML for the final trace |
| Benchmark GPU snapshot | taken **after** each measured run | same, but continuous trace covered the prefill |

The original `glm-bench-final.json` was produced after `glm-bench.json` and
`glm-bench-512.json` with the same deterministic prompts. Prefix caching made
the final warm steps ~0.9 s at 128K and ~1.5 s at 256K. The managed process had
no such cache, so its warm step performed the real cold prefill and its power
trace covered that interval.

## 2. Power-limit evidence

Read-only NVML/`nvidia-smi` evidence, all four GPUs:

- `power.limit`: **180.00 W**
- `enforced.power.limit`: **180.00 W**
- `power.default_limit`: **250.00 W**
- supported range: **100–250 W**
- power-management mode: **enabled (1)**
- performance state: P0
- supported throttle-reason mask: `0x7ff`
- `nvidia-smi -q -d POWER`: “Average Power Draw: N/A”; **Instantaneous Power
  Draw** is the reported field; `Power Samples` gives max/min/avg over a short
  2.37 s window
- no software invocation of `nvidia-smi -pl` during the managed run; the boot
  policy log shows 180 W accepted on all four cards
- `cmp-gpu-power-policy.service` is active/exited with rc=0; the policy script
  iterates every visible GPU and never raises a limit
- `nvidia-persistenced` active; no power-limit reset observed
- temperatures stayed in the low 40s °C; no thermal or HW power-brake throttle

### SW Power Capping counter delta during validation

From `/var/log`/fresh `nvidia-smi -q -d PERFORMANCE` snapshots:

| GPU | before (µs) | after (µs) | delta |
|---|---:|---:|---:|
| 0 (02:00) | 5,348,687 | 5,577,119 | +228,432 |
| 1 (03:00) | 708,444,526 | 712,358,535 | +3,914,009 |
| 2 (82:00) | 3,182,614 | 3,285,302 | +102,688 |
| 3 (83:00) | 156,217,293 | 156,359,736 | +142,443 |

The GPU’s SW power-capping mechanism is therefore operating, while
instantaneous `power.draw` can overshoot between control updates. This is the
expected NVIDIA averaged-power behavior, not an unenforced limit.

### Continuous trace

Trace: `/home/ffard/glm53-test/power-trace-final.jsonl`
(20 Hz NVML; 5 s rolling mean; hard guard at 185 W).

| Workload | Instantaneous max | Worst 5 s mean |
|---|---:|---:|
| 32K cold | 278.86 W | 136.05 W |
| 128K cold | 287.35 W | 146.22 W |
| 262K cold | 287.35 W | 146.22 W |
| whole validation | 287.35 W | 146.22 W |

No guard trip. The intended 262,144-token context was exercised as a
261,572-token prompt + 512 generated tokens (262,084 total). Measured decode
was 94.37 tok/s with TTFT 1.52 s after the cold prefix; cold prefill TTFT was
28.99 s.

### Prometheus cross-check

The existing Netdata/Prometheus averaged series
`netdata_nvidia_smi_gpu_power_draw_Watts_average` reports:

- original window 13:20–13:27: max 194 W (3 samples >180), mean 49–61 W
- managed window 23:52–23:56: max 177.33 W, no sample >180
- `ALERTS`: empty; the `GpuPowerAbovePolicy` rule requires >185 W for 2 minutes

This is consistent with the 5 s trace and inconsistent with a sustained
260–267 W claim.

## 3. Root cause

1. **Workload state differed.** The standalone final benchmark was fully
   prefix-cached from two earlier identical runs; the managed benchmark was
   cold. The power-consuming cold prefill was absent from the standalone
   benchmark’s measured window.
2. **Measurement domain differed.** `power.draw` is instantaneous. A single
   ~185 W sample cannot establish a maximum over prefill, and 260–267 W
   instantaneous samples do not establish sustained average power. The 180 W
   ceiling is enforced by averaged SW power capping, which the counters confirm.
3. **The original evidence was incomplete.** No continuous trace covered the
   original prefill; the report’s “~185 W maximum observed” describes one
   observation, not a sampled maximum over all phases.

Remaining uncertainty: without an external electrical meter, software can only
demonstrate NVML-reported power and the GPU’s own capping counters. Within that
instrumentation, the averaged 180 W policy is demonstrably active. A hard
instantaneous 180 W ceiling is not provided by this NVIDIA power-management
mode and cannot be created by software.

## 4. Native GLM family registration

The prior alias workaround is removed.

- Registered via the installed Xinference API:
  `POST /v1/model_registrations/LLM`, `persist=true`.
- Model name: **`glm-5.3-flash`**
- `model_family`: **`glm-5.3`** (required value from Xinference’s tool-call
  family allowlist)
- `model_engine`: **Morrowmake**
- context: **262144**
- abilities: chat, generate, tools, reasoning
- engine allowlist: Morrowmake
- Existing `qwen38-flashnext` family untouched.

Verified through `/v1/models`:
`model_name=glm-5.3-flash`, `model_family=glm-5.3`,
`model_ability=[chat,generate,tools,reasoning]`, context 262144,
engine Morrowmake. Chat, reasoning content, tool calls, and streaming all
returned valid responses; the router served the logical model
`glm-5.3-flash`.

## 5. Corrective/lifecycle changes

- `glm53-runtime`: flash restore health timeout raised from 300 s to 600 s;
  stop now waits for both restored models and returns nonzero if restoration
  fails; diagnostic subcommand allows an explicit one-off test while the
  profile is disabled (not used by Spark).
- Profile launch uses the native family; `disabled=false`; batch 2312/seq 4.
- Spark service re-granted Docker supplementary group so the existing managed
  helper can start/stop the container. This is required for the existing
  profile path; it is a privileged grant and should be reviewed if the profile
  is retired.
- Existing Spark 409 guard retained in source; it now passes because the
  profile is explicitly enabled and validated.

## 6. Final state

- GLM profile: **enabled**, inactive.
- Qwen `qwen38-gpu1`: READY, 163,840 context.
- Qwen `qwen38-flashnext`: READY, 262,144 context.
- Router: GPU1 and GPU2 healthy; GPU0/GPU3 free.
- Spark, Xinference, router, smfc, smfc-c80-monitor, cmp-gpu-guard,
  gpu-safety-backend, cmp-gpu-power-policy: active.
- 180 W limits unchanged and confirmed on all four GPUs.
- Native GLM family registered; Flash-Next integration preserved.
- Qwen → GLM → Qwen switch exercised; final state is Qwen.

## 7. Source and rollback

- Local commit: `1db825a05d33bc255f002501dc2493d5299bb3cc`
  (previous safety/guard source: `f56d962f7d9dc6ac795f55598ff75fcaef51fb96`).
- Branch: `hqcc-flashnext-integration`.
- No GitHub push (no credentials).
- Backup: `/home/ffard/glm53-integration-backup-20261109T224207Z`
- Power trace: `/home/ffard/glm53-test/power-trace-final.jsonl`
- Profile: `/etc/xinference/profiles/glm53-pp4.json`
- Helper: `/usr/local/libexec/glm53-runtime`
- Family registration: `POST /v1/model_registrations/LLM` (script in
  `deploy/glm53/register_glm_family.py`)

Rollback: disable the profile (set `disabled=true`), stop the GLM container via
the helper, and restore Qwen profiles. Do not delete the image/checkpoints.

## 8. Next actionable engineering option

If a **hard instantaneous** 180 W ceiling is required, no supported NVIDIA
software mechanism provides it on CMP 170HX. The options are hardware/firmware
or an external power controller, both outside the authorized scope. For the
configured averaged policy, this validation supports enabling GLM at 262K.
