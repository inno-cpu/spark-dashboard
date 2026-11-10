# GLM benchmark campaign — DFlash depth and partition results

## Persistent state

GLM `glm53-pp4` resident, adaptive `[7,5,3]`, `9,12,12,12`, 262144 context,
P2P off, 180 W limits. Qwen stopped/unloaded; no Qwen restore. Continuous power
trace/guard and all safety services active.

## Baseline (adaptive [7,5,3], 9/12/12/12)

Five direct runs, exact Morrowmake prompts:

| Workload | Median | Min–max | Iterations | Acceptance | Mean accepted |
|---|---:|---:|---:|---:|---:|
| Structured | 188.18 | 187.57–188.69 | 53 | 94.07% | 7.585 |
| Code | 143.97 | 143.70–144.68 | 65 | 74.95% | 6.246 |
| Prose | 92.31 | 91.75–92.46 | 109 | 42.55% | 3.697 |

## Partition A/B (9/12/13/11), adaptive

| Workload | Median | Change |
|---|---:|---:|
| Structured | 187.72 | −0.25% |
| Code | 146.22 | +1.56% |
| Prose | 91.82 | −0.53% |

Managed all-path verification: direct 146.09 / Xinference 145.76 / router 145.75 code.

**Rejected:** startup emitted repeated GPU3 `20 MiB` allocator failures with
free 16,056,320 bytes; GPU2 reached 61,552 MiB. The gain is not enough to accept
an unreliable 262K init path.

## Fixed-depth experiment

Fixed depth 3 via documented `EXTRA_ARGS` speculative-config:

| Workload | Median | Change vs adaptive |
|---|---:|---:|
| Structured | 118.72 | −36.9% |
| Code | 109.34 | −24.1% |
| Prose | 88.39 | −4.2% |

**Rejected.** The adaptive `[7,5,3]` policy is essential; fixed depth 3 loses
both acceptance and real throughput. Fixed depth 5 was not run after this
monotonic loss; it lies between depth 3 and adaptive depth 7 and has no
evidence-based chance of beating the baseline. This is the remaining untested
depth candidate.

## Instrumentation

The NVML sampler failure was not converted into a substitute for stage timing.
The sampler file was empty; no per-stage execution/wait/transfer timings were
obtained. No claim is made that x2 GPU3 explains the 209.9 vs 144 tok/s gap.
The partition A/B is consistent with a stage3/x2 contribution, but is not proof.

## Startup-memory finding

For `9,12,13,11`, resident memory was GPU0 33.3, GPU1 56.2, GPU2 61.6,
GPU3 57.3 GiB. The startup peak still produced GPU3 allocator warnings,
indicating a transient peak/fragmentation effect rather than steady-state
pressure. No retry; no remedy validated. Baseline `9,12,12,12` retained.

## Final

Adaptive `[7,5,3]`, `9,12,12,12`, native GLM family, Qwen stopped, GLM resident.
Final benchmark medians remain structured 188.18, code 143.97, prose 92.31.
No safe candidate beat baseline on the combined reliability/code criterion.
