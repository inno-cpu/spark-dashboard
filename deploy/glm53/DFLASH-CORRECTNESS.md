# GLM-5.3-Flash — DFlash2 divergence and throughput root cause

Date: 2026-11-10 UTC  
Host: `ffard@192.168.1.145`

## Result

DFlash2's target output is not sequence-identical to the target-only reference,
but the first divergence is a **three-way exact top-logprob tie**, not
corruption. The faster original 131.37 tok/s run was a different tie-resolution
trajectory with a much higher mean accepted chain. It cannot be reconstructed
because the original run preserved only `text_head`/`text_tail`, not token IDs.

The performance model is now quantified: DFlash iteration duration is
approximately constant (~39 ms); the 131-vs-90 tok/s gap is almost entirely
**iteration count**, driven by mean accepted length. There is no evidence of a
speculative-verification or state-propagation corruption bug.

## Original evidence limits

- `glm-bench-final.json` has `text_head`/`text_tail` only. It has **no output
  token IDs**, no full output, and no `text_sha256`.
- `glm-bench.json` and `glm-bench-512.json` have the same limitation.
- The original prompt is reconstructible from the deterministic harness
  (`target=267300`, actual prompt 261,572 tokens), but the original sampled token
  stream is not.
- Therefore the original first-divergence point **cannot be reconstructed** and
  no token-level comparison against it is claimed.
- The 131.37 calculation is arithmetically valid for its recorded interval:
  512 completion tokens / 3.8974 s decode = 131.37 tok/s. This is a client
  streaming measurement, not an independent engine-timestamp audit.

## Target-only reference

Engine: pinned image/model, PP4 `9,12,12,12`, context 262,144, P2P off, DFlash
disabled through `serve.sh none` (`speculative_config=None` in the engine log).
Prompt SHA-256:
`fe7c74cac6b6e8ba0d10e13fe3c02d358cfe680006e77dac16d77ddaf7e36bf6`.

Five 512-token temperature-zero completions:

| Run | TTFT s | Decode s | Tok/s | Output hash |
|---|---:|---:|---:|---|
| 0 | 1.804 | 10.593 | 48.33 | `1353b5694314...` |
| 1 | 1.836 | 10.571 | 48.44 | `1353b5694314...` |
| 2 | 1.948 | 10.692 | 47.89 | `1353b5694314...` |
| 3 | 1.861 | 10.570 | 48.44 | `1353b5694314...` |
| 4 | 1.850 | 10.769 | 47.54 | `1353b5694314...` |

**Target-only output is deterministic** across five runs. Iterations = 512;
decode iteration duration ≈ 20.7 ms; 48.0 tok/s median.

## DFlash reference and first divergence

Same prompt, same 512-token request, DFlash restored.

| Run | TTFT s | Decode s | Tok/s | Output hash |
|---|---:|---:|---:|---|
| 0 | 1.643 | 6.420 | 79.75 | `8e13fd98c542...` |
| 1 | 1.622 | 6.448 | 79.41 | `8e13fd98c542...` |
| 2 | 1.620 | 6.288 | 81.43 | `fcba59ecf4dc...` |
| 3 | 1.666 | 6.465 | 79.20 | `8e13fd98c542...` |
| 4 | 1.769 | 6.416 | 79.80 | `8e13fd98c542...` |

Target-only token IDs begin:
`785, 1196, 702, 2661, ...`  
DFlash token IDs begin:
`785, 1196, 702, 3208, ...`

**First divergence is token index 3**:

- target-only: `2661` = `" given"`
- DFlash: `3208` = `" sent"`

A constrained target probe with the common prefix `The user has` returned
`" given"` and the top logprobs were:

| Token | Logprob |
|---|---:|
| `given` | **−1.3412604331970215** |
| `past` | **−1.3412604331970215** |
| `sent` | **−1.3412604331970215** |
| `provided` | −1.9662604331970215 |

The three head tokens are an **exact tie**. The target-only path selects
`given`; the DFlash path selects `sent`. Both are target-argmax tokens. The
divergence is a tie-break/numerical path difference, not a systematic target
corruption.

A full token-level comparison against the original 131.37 run is impossible
because its tokens were not saved.

## Correct DFlash statistics

From the pinned source
`vllm/v1/spec_decode/metrics.py`:

- acceptance rate = `num_accepted_tokens / num_draft_tokens`
- mean acceptance length = `1 + num_accepted_tokens / num_drafts`
- accepted-step rate (any token accepted at position 0) is a separate diagnostic,
  not the engine's acceptance rate.

The DFlash metrics probe (same 256K prompt, 512 tokens):

- drafts: **170**
- draft tokens: **942**
- accepted tokens: **347**
- position-0 accepted steps: **129**
- **acceptance rate: 36.84%**
- **mean acceptance length: 3.041**
- accepted-step rate: 75.88%
- decode: 6.5617 s, **78.03 tok/s**

For the archived original raw counters:

- drafts 378, draft tokens 2,238, accepted 1,162
- acceptance rate **51.92%**
- mean acceptance length **4.074**

The earlier **65.9% / 5.14** summary is not derivable from the archived JSON
under the engine definitions. The old file does not retain the aggregate or its
definition, so that number cannot be validated. The earlier “3.15” figure was
also a non-standard accepted-tokens/accepted-step ratio; the correct current
mean is **3.041**.

## Quantitative decode model

| Configuration | Emitted tokens | Decode iterations | Decode s | ms/iteration | Tok/s |
|---|---:|---:|---:|---:|---:|
| Target-only | 512 | 512 | 10.59 | 20.7 | 48.3 |
| Current DFlash | 512 | 170 | 6.56 | 38.6 | 78.0 |
| Earlier DFlash path | 512 | ~145 | 5.71 | 39.4 | 89.7 |
| Original reported DFlash | 512 | ~100 (implied by mean 5.14) | 3.90 | 39.0 | 131.4 |

DFlash iteration duration is stable around **39 ms** across the current and
original runs. The 131 → 90 gap is therefore iteration count:

- current 89.7 tok/s: ~145 iterations × 39 ms ≈ 5.66 s
- original 131.4 tok/s: ~100 iterations × 39 ms ≈ 3.90 s
- difference: ~45 iterations × 39 ms ≈ 1.76 s, close to the observed 1.81 s

No benchmark-accounting correction is needed; the difference is real decode
wall-clock. The 131 run is explained if its mean accepted length was ~5.14; it
is not explained by iteration duration, cache, power, or adapter overhead.

## Can the original high-speed behavior be reproduced?

No, not with the pinned engine and archived request:

- current DFlash five-run output is 79–81 tok/s, not 131;
- target-only is 48 tok/s;
- the original output tokens are unavailable;
- the first divergence is a genuine target-logit tie, so the high-acceptance
  continuation is not specified by the request;
- repeating the same prompt produced 79–81 tok/s, not a 131 path.

No DFlash parameter was tuned to chase acceptance percentage; that would not
prove correctness or reproducibility.

## Correctness determination

- Target-only temperature-zero decoding is deterministic (5/5 identical).
- DFlash produces a different sequence because it selects a **different exact
  tie** at token 3. This is **not** a systematic target-output corruption.
- At the common prefix, the target's top three tokens are exactly tied at
  −1.341260433. The DFlash token `sent` and target-only token `given` are both
  valid argmax ties.
- No speculative state-propagation bug is demonstrated. There is, however, a
  **non-deterministic tie-breaking difference** between the target-only and
  DFlash execution paths; DFlash produced two output hashes in five runs.
- Strict sequence equality with target-only is not preserved, but strict
  equivalence is not meaningful at an exact probability tie without a defined
  tie-break key. The correct requirement is same-target-distribution
  verification, which the logprobs support.

## Implemented changes

No engine or DFlash change was made: no correctness or performance defect was
validated. The only diagnostic change is an internal `GLM53_SPEC_MODE` switch in
the existing runtime helper, used to launch the target-only reference. The
managed profile remains on the validated DFlash configuration.

The earlier router 256K context/tokenizer fix remains in place and is unrelated
to this result.

## Final state

- GLM profile `glm53-pp4`: enabled, DFlash, inactive.
- Native `glm-5.3-flash` family unchanged; four-GPU telemetry unchanged.
- Qwen restored after diagnostics: `qwen38-gpu1` and `qwen38-flashnext` READY.
- Router GPU1/GPU2 healthy.
- 180 W limits unchanged; target-only trace 5 s max 160.75 W and DFlash trace
  5 s max 161.66 W; no guard trip; instantaneous peaks 309.93 W as expected.
- All safety services remain active.

## Artifacts

- `research/morrowmake/glm-results/glm-compare-target.json`
- `research/morrowmake/glm-results/glm-compare-dflash.json`
- `research/morrowmake/glm-results/dflash-correctness-metrics.json`
- `research/morrowmake/glm-results/power-trace-dflash.jsonl`
- Source: `/home/ffard/glm53-test/rootfs/opt/vllm-src/vllm/v1/spec_decode/metrics.py`,
  `.../dflash.py`, `.../utils.py`
- Host target/DFlash outputs: `/home/ffard/glm53-test/glm-compare-target.json`,
  `/home/ffard/glm53-test/glm-compare-dflash.json`

No GitHub push: no credentials; local commits retained.
