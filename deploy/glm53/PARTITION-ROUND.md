# GLM benchmark-mode optimization round — partition A/B

## State

Persistent GLM benchmark mode. Qwen `qwen38-gpu1` and `qwen38-flashnext` are
stopped and unloaded; GLM `glm53-pp4` is resident and healthy on all four GPUs.
Continuous 20 Hz power trace and the rolling 5 s/185 W guard remain active.
All safety services active; 180 W limits unchanged.

## Baseline `9,12,12,12`

Five direct runs per workload, exact Morrowmake prompts/protocol:

| Workload | Median | Min–max | Iterations | Acceptance | Mean accepted |
|---|---:|---:|---:|---:|---:|
| Structured | 188.18 | 187.57–188.69 | 53 | 94.07% | 7.585 |
| Code | 143.97 | 143.70–144.68 | 65 | 74.95% | 6.246 |
| Prose | 92.31 | 91.75–92.46 | 109 | 42.55% | 3.697 |

## Candidate `9,12,13,11`

GPU2 gained one layer; GPU3 lost one layer. Memory after load:

- GPU0 33,346 MiB
- GPU1 56,218 MiB
- GPU2 61,552 MiB
- GPU3 57,298 MiB

Five direct runs:

| Workload | Median | Min–max | Change |
|---|---:|---:|---:|
| Structured | 187.72 | 187.51–188.13 | −0.25% |
| Code | 146.22 | 144.42–146.51 | **+1.56%** |
| Prose | 91.82 | 91.73–91.92 | −0.53% |

Managed verification: direct 146.09, Xinference 145.76, router 145.75 code;
all paths within ~0.3%.

**Rejected for reliability.** Startup emitted repeated allocator failures on
GPU3 (`20 MiB`, free 16,056,320 bytes) and GPU2 reached 61.6 GiB. The gain is
too small to justify marginal startup memory and an unreliable init path.

## Bottleneck evidence

- Code has 65 iterations vs structured 53; code iteration ~42.8 ms vs
  structured 39.9 ms.
- The extra 12 iterations account for ~0.51 s of the ~0.88 s gap to Morrowmake's
  209.9 tok/s; iteration duration adds ~0.19 s. The remainder cannot be separated
  without reference-side per-prompt counters.
- Moving one layer from the x2 stage3 to x4 stage2 improved code 1.56% but
  worsened structured/prose slightly and destabilized GPU3 startup. This is
  compatible with a stage3/x2 contribution, but is not a validated safe win.
- No per-stage timing was obtained: the planned low-overhead NVML sampler
  produced no records, so no unsupported stage attribution is made. The
  partition A/B is the only direct stage-related measurement.

## Selected configuration

`9,12,12,12` retained. It is the reliable baseline; no candidate met the
correctness, initialization, memory-margin, and code-throughput bar together.
No engine/kernel/DFlash/power/firmware/PCIe changes were made.

## Final state

GLM resident and available; Qwen stopped; native family, router, telemetry and
safety intact. Benchmark mode remains active. No Qwen restore.

## Files

- `glm-mm-direct.json` — baseline direct run
- `glm-mm-direct-alt.json` — candidate direct run
- `/home/ffard/glm53-test/glm-morrowmake-bench.json` — final all-path candidate verification