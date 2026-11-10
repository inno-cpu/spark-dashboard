# GLM-5.3-Flash — historical accounting, DFlash correctness, and Morrowmake parity

Date: 2026-11-10 UTC  
Host: `ffard@192.168.1.145`

## 1. Historical counters resolved

The archived `metrics_after` values are cumulative process counters. Per-target
deltas must be taken against the **previous target's** `metrics_after`, not
against the single `metrics_spec` captured at benchmark start.

| Target | Drafts | Draft tokens | Accepted | Generated (drafts+accepted) | Acceptance | Mean acceptance length | tok/s |
|---|---:|---:|---:|---:|---:|---:|---:|
| 32K | 110 | 658 | 405 | 515 | 61.55% | 4.682 | 116.403 |
| 128K | 168 | 952 | 343 | 511 | 36.03% | 3.042 | 78.815 |
| **256K** | **100** | **628** | **414** | **514** | **65.92%** | **5.140** | **131.369** |

The earlier 378 drafts / 2,238 draft tokens / 1,162 accepted is the **three-context
aggregate**, not the 256K request. That is why it looked inconsistent with a
512-token completion. The 256K-specific counters are exactly consistent with
**65.9% acceptance and mean acceptance length 5.14**; the published 65.9/5.14
was therefore correctly derived, just from per-target deltas.

`generated = drafts + accepted` is 514 for the 256K target, matching the 512
measured tokens plus warmup/extras. This is the engine's definition: each draft
step contributes one target/bonus token plus its accepted draft tokens.

## 2. DFlash correctness

Target-only (`serve.sh none`) was run five times with the same 256K prompt:

- 5/5 identical full output hash: `1353b5694314...`
- 48.0 tok/s median, 512 iterations, 20.7 ms/iteration.

DFlash first divergence was token index 3:

- target-only: `2661` = `" given"`
- DFlash: `3208` = `" sent"`

At the common prefix `The user has`, target logprobs were an exact tie:

| Token | Logprob |
|---|---:|
| `given` | −1.3412604331970215 |
| `past` | −1.3412604331970215 |
| `sent` | −1.3412604331970215 |

To test beyond the first tie, target-only was forced to continue from DFlash's
actual prefix at lengths 4, 5, 6, 8, 10, 16, 24 and 32. At **every one of those
later positions, target-only chose the same token as DFlash**. At prefix length
3, target-only itself chose `sent` when fed DFlash's prefix, while the
unconstrained target-only run chose `given`. The difference is a near-tie
caused by execution/cache path, not a speculative-verification defect.

**Correctness conclusion:** no systematic DFlash corruption was demonstrated.
The first divergence is a legitimate target argmax tie; the remaining DFlash
trajectory is target-consistent at all probed later positions. A strict
sequence-identical guarantee is not provided by this numerical execution path.

## 3. Performance decomposition

DFlash counters and timing are now per-request:

| Configuration | Drafts/iterations | Mean accepted | Decode s | ms/iter | tok/s |
|---|---:|---:|---:|---:|---:|
| Target-only | 512 | 1.0 | 10.59 | 20.7 | 48.3 |
| Current DFlash | 170 | 3.041 | 6.56 | 38.6 | 78.0 |
| Earlier DFlash path | 146 | 3.53 | 5.71 | 39.1 | 89.7 |
| Original 256K | 100 | 5.14 | 3.90 | 39.0 | 131.4 |

**The speed gap is iteration count, not iteration duration.** The original and
current DFlash decode iterations both cost ~39 ms; original had 100 iterations,
current 170. The 131.4 measurement is valid: 512 / 3.8974 = 131.37 tok/s, with
per-target counters 100/628/414. The difference is the output trajectory's
accepted chain, not pipeline overhead, power throttling, or accounting.

The target-only path is slower per token because it performs 512 target
iterations; speculation trades fewer, slower iterations for higher throughput.

## 4. Power telemetry

- NVML: current/enforced power limit 180 W on every GPU; default 250 W;
  power-management mode enabled.
- `power.draw` is instantaneous; five-second rolling averages are the guard
  domain. The 309.93 W reading is a single-GPU instantaneous peak, not aggregate
  power. It is expected under NVIDIA's averaged power capping and is not a
  sustained violation.
- Target-only trace: 5 s max 167.32 W; DFlash trace: 5 s max 161.66 W;
  validation trace: 148.94 W. No guard trip; SW Power Capping counters advanced.
- Temperatures remained low-40s °C; no Xid/ECC/thermal fault; all safety
  services active.
- No power/firmware/clock changes.

## 5. Morrowmake v1.8.0 exact comparison

Reference sources:

- https://github.com/Morrowmake/glm53-flash-cmp170hx-recipe/blob/main/docs/results.md
- `MiaAI-Lab/GLM-5.3-Flash-EXL3-2x-DGX-Sparks`, `tests/bench_decode.py`, main
  tree `fffe64fc093f65fa8f033957e16b744dc266c2ec`

Exact prompts used (SHA-256):

| Workload | Prompt SHA-256 |
|---|---|
| Structured | `f52cbabc2dcb7f69ecf16a13cbde249fc79f62174e3a16fc4045a7efdd1b0a39` |
| Code | `6f2a43a6c2eae1b1998d394243b12ee77f2b8da0c5c9c1ec278f44525d88f885` |
| Prose | `3c40426dd4d293d122a2171772b81c010b724bc126608b30526859fa819d3bce` |

Protocol: one user message, temperature 0, top_p 1, max 400 tokens, thinking
off via `chat_template_kwargs.enable_thinking=false`, streaming, 32-token warmup,
five measured runs; `tok/s = (completion_tokens - 1) / (end - first_token)`.

Our direct endpoint, five-run median (min–max):

| Workload | Direct tok/s | Xinference tok/s | Router tok/s | Morrowmake PP4 | Ratio |
|---|---:|---:|---:|---:|---:|
| Structured | **188.10** (187.54–188.82) | 187.62 | 187.72 | 232.4 | **80.9%** |
| Code | **144.17** (142.65–144.59) | 143.75 | 143.85 | 209.9 | **68.7%** |
| Prose | **92.12** (92.10–93.60) | 92.12 | 92.14 | 100.1 | **92.0%** |

All 400-token runs finished at length; no early termination. Direct, native
Xinference and router are within ~0.3%; integration overhead is negligible.

**Non-equivalence:** Morrowmake measured PCIe x16, P2P on, 74 SMs, and 64 GiB
per card. Our system has mixed Gen2 x2/x4, P2P off, and 40/64/64/64 GiB. The
official result is therefore not an apples-to-apples hardware comparison. Our
short-prompt numbers are not compared to the 256K decode rate.

No concurrency or cold-prefill tests were run in this execution. Single-user
power was clean, but the required sustained-load and prompt-recovery validation
was not completed; those results are **not claimed**.

## 6. Diagnosis and safe optimization status

- Historical 131.37: valid; per-target counters and timing support it.
- Archived 378/1,162: three-target aggregate; not an inconsistency.
- DFlash: no correctness bug demonstrated; exact tie at token 3, later probed
  tokens target-consistent.
- Managed overhead: none measurable; direct/Xinference/router match.
- Short-prompt gap to Morrowmake: structured 81%, code 69%, prose 92%;
  topological differences (x16/P2P vs x2/x4/P2P-off, memory asymmetry) and
  prompt-dependent speculation are the leading explanations, but cannot be
  isolated without hardware changes. No software-level deficit is demonstrated.
- No safe tuning change was validated. The production profile remains unchanged;
  no DFlash/engine parameter was altered to chase a benchmark.

## 7. Final state

GLM `glm53-pp4` remains enabled, inactive, native `glm-5.3-flash` family,
four-GPU telemetry intact. Qwen `qwen38-gpu1` and `qwen38-flashnext` are READY;
router GPU1/GPU2 healthy; all safety services active; 180 W limits unchanged.

## Artifacts

- `research/morrowmake/glm-results/per_request_counters.py`
- `research/morrowmake/glm-results/counter_scope.py`
- `research/morrowmake/glm-results/glm-compare-target.json`
- `research/morrowmake/glm-results/glm-compare-dflash.json`
- `research/morrowmake/glm-results/glm-target-probes.json`
- `research/morrowmake/glm-results/glm-morrowmake-bench.json`
- `research/morrowmake/glm-results/power-trace-morrowmake.jsonl`
- `research/morrowmake/glm-results/dflash-correctness-metrics.json`

No GitHub push: no credentials; local commits retained.
