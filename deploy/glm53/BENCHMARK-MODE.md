# GLM-5.3-Flash — persistent benchmark mode and code-path analysis

Date: 2026-11-10 UTC  
Session state: **GLM benchmark mode active**. Qwen GPU1/FlashNext stopped.
GLM `glm53-pp4` is resident and available. No Qwen restore was performed.

## 1. Benchmark-mode state

`/home/ffard/glm53-test/BENCHMARK-MODE.json` records:

- mode: `glm-benchmark`
- started: 2026-11-10T06:41:07Z
- Qwen models: `qwen38-gpu1`, `qwen38-flashnext` — both unloaded/stopped
- Qwen container: stopped
- GLM profile: `glm53-pp4`, enabled, resident, native `glm-5.3-flash`
- power limit: 180 W per GPU
- current models: `['glm53-pp4']`
- Spark profile list unchanged; no automatic Qwen restart path is active
- router is strict; Qwen slots currently unhealthy and cannot attract traffic
- GLM endpoint is loopback-only

The continuous 20 Hz power trace with the 5 s/185 W guard is active for this
benchmark session.

## 2. Exact short-prompt results in benchmark mode

Exact MiaAI-Lab/Morrowmake prompts and protocol as previously recovered:
temperature 0, top_p 1, thinking-off request, max 400, streaming, 32-token
warmup, five runs.

| Workload | Direct median | Min–max | Xinference median | Router median | Morrowmake PP4 | Relative |
|---|---:|---:|---:|---:|---:|---:|
| Structured | **188.07** | 187.60–188.63 | 187.53 | 187.86 | 232.4 | **80.9%** |
| Code | **144.22** | 143.95–144.46 | 143.77 | 143.64 | 209.9 | **68.7%** |
| Prose | **92.19** | 92.11–94.89 | 92.16 | 92.30 | 100.1 | **92.1%** |

Direct, Xinference and router remain within ~0.3%; integration overhead is not
the code gap.

## 3. Code-path decomposition

Per-request counters from the exact five-run direct measurements:

| Workload | Iterations/drafts | Accepted | Draft tokens | Acceptance | Mean accepted | Iteration duration | Decode for 400 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Structured | 53 | 349 | 371 | **94.07%** | **7.585** | ~39.9 ms | 2.13 s |
| Code | 65 | 341 | 455 | **74.95%** | **6.246** | ~42.8 ms | 2.78 s |
| Prose | 109 | 294 | 691 | **42.55%** | **3.697** | ~39.8 ms | 4.34 s |

The code path has **12 more iterations than structured** and **2.9 ms longer
per iteration**. The iteration-count penalty alone is ~0.51 s of the ~0.88 s
gap to Morrowmake's 209.9 tok/s; the iteration-duration penalty is ~0.19 s.
The rest is explained by the reference's higher effective accepted-chain
efficiency; the reference does not publish per-prompt draft counters, so the
split cannot be closed exactly without equivalent instrumentation on its run.

Prose is closest to reference (92.1%) because its much lower acceptance is
offset by a lower per-iteration activation volume; code sits between structured
and prose in acceptance but has a larger per-iteration cost.

**Conclusion:** code is not limited by one factor. Both **lower acceptance**
(75% vs 94% structured) and **longer iteration duration** contribute; the
dominant measured term is the extra iteration count. No single software
regression is demonstrated.

## 4. Pipeline and runtime audit

Current runtime banner confirms:

- PP4 `9,12,12,12`; DFlash2 adaptive depth `[7,5,3]`, draft slots 7, boundary
  cache 1.
- `DRAFT_TAIL_STAGE=2`, packed hop, split draft event, folded draft FC.
- compiled Marlin decode, compiled eligible prefill, KDA, sparse MLA.
- `MAX_BATCHED=2312`, `MAX_SEQS=4`, context 262144.
- P2P off (`P2P=off`, NCCL P2P disabled), matching the production configuration.
- CUDA graph FULL_AND_PIECEWISE, as shipped.
- No missing release feature identified in the runtime banner.

Hardware differences from Morrowmake's published PP4 result remain: x16 links
and verified P2P on the reference versus mixed Gen2 x2/x4 and P2P off here, plus
40/64/64/64 GiB. Those are real, measured topology differences, but the short
prompt data does not isolate their exact contribution. The reference's per-stage
timings are not published; our engine does not expose per-stage timing without
adding profiler instrumentation, so no unsupported stage attribution is made.

Candidate stage hypothesis: code's 65 iterations and ~6.25 tokens/iteration have
more cross-stage traffic than prose's lower-token iterations. This is consistent
with the code deficit, but has **not** been proven with stage-level timing.

## 5. Experiments and safe optimization

No production configuration change was made. The only evidence-supported
candidate experiments are restart-dependent and were not run in this round:

1. `VLLM_PP_LAYER_PARTITION=9,12,13,11` to move one layer off the x2 stage3 and
   onto x4 stage2 — test against 9/12/12/12 with per-stage timing.
2. Fixed DFlash depth 3/5 vs adaptive 7 — test whether lower verification cost
   beats the lost accepted chain on code; do not tune acceptance alone.
3. CUDA graph / boundary-cache A/B — only after stage timing shows a mechanism.

All require an engine restart; they should be grouped in the next round to avoid
repeated reloads. The current 9/12/12/12 DFlash configuration remains the
validated production benchmark configuration.

No power, firmware, PCIe, P2P, clock or model changes were made.

## 6. Safety

- 180 W configured/enforced on all four GPUs; default 250 W; SW power capping
  active.
- The 309.93 W observation remains a single-GPU instantaneous peak under the
  averaged cap, not sustained aggregate power. Five-second means in benchmark
  runs are 149–167 W; guard has not tripped.
- Temperatures are low-40s; no Xid/ECC/thermal fault.
- SMFC, C80 monitor, thermal guard, safety backend and power-policy service are
  active.
- Benchmark endpoint is loopback-only; no production traffic.

## 7. Reproducible 256K

The per-target historical accounting is unchanged:

- 256K historical: 100 drafts, 628 draft tokens, 414 accepted, 65.92%
  acceptance, mean 5.14, 131.37 tok/s.
- Current DFlash 256K: 78–90 tok/s depending on tie path; target-only 48.3.
- Iteration timing is ~39 ms; the historical gap is iteration count.

No new long-context measurements were taken in this round; the 32K/128K/256K
existing results remain the reference.

## 8. Final state

- **GLM active and available**; benchmark mode persists.
- **Qwen stopped**, not restored.
- Native family, four-GPU telemetry, router strictness and all safety services
  intact.
- Continuous power guard active.

## Artifacts

- `research/morrowmake/glm-results/glm-morrowmake-bench-mode.json`
- `research/morrowmake/glm-results/bench_mode_summary.py`
- `/home/ffard/glm53-test/BENCHMARK-MODE.json`
- Host logs: `/home/ffard/glm53-test/logs/mm-bench-benchmode.log`,
  `/home/ffard/glm53-test/logs/power-trace-bm-*.jsonl`

No GitHub push: no credentials; local changes retained.
