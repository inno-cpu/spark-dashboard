# GLM-5.3-Flash — performance reconciliation and final managed state

Date: 2026-11-10 UTC  
Host: `ffard@192.168.1.145`

## Result

The original **32K** result is reproducible through every path. The **128K**
results are within run-to-run output/DFlash variance. The original **256K
131.4 tok/s** result is **not reproducible**: the current five-run median is
**89.7 tok/s direct**, **88.5 tok/s through Xinference**, and **89.0 tok/s
through the router**. Direct, Xinference and router produce the same cached
output and throughput; there is **no managed-pipeline throughput regression**.

The remaining difference is the generated-token trajectory and its DFlash2
accepted length. Under temperature 0 the target token stream is not fully
deterministic across fresh requests; the original 256K run was a single
high-acceptance trajectory. The old JSON has no full prompt or acceptance
aggregate, so the original 131.4 figure cannot be reconstructed exactly.

A real router bug was found and fixed: 256K requests were being rejected before
reaching the engine by a `chars/3` context estimator (434,019 estimated tokens).
The router now asks the active engine's `/tokenize` endpoint for the exact count
(261,572), and the 256K route succeeds.

## Request equivalence

All controlled runs used:

- same deterministic `glm_bench` prompt builder and tokenizer;
- prompt tokens **32,162 / 128,327 / 261,572**;
- prompt SHA-256:
  - 32K: `ec785850a412dc5eb2eef2f1fd1e564a93245a320342c76fdde20773223ffcbd`
  - 128K: `d376562448bfba8f3081835d39c2e3e0c492ecc2d59ebe987a73ab63fd2a8158`
  - 256K: `fe7c74cac6b6e8ba0d10e13fe3c02d358cfe680006e77dac16d77ddaf7e36bf6`
- `max_tokens=512`, `min_tokens=512`, `ignore_eos=true`,
  `temperature=0`, streaming with usage;
- one explicit warm request before the measured requests;
- direct, native Xinference (`glm53-pp4`), and router (`glm-5.3-flash`) paths;
- 5 measured repetitions per path/context, rotating path order.

No request parameter was silently dropped. `CreateCompletionTorch` contains
`ignore_eos`, `min_tokens`, `max_tokens`, `stream`, `stream_options` and
`chat_template_kwargs`; the Morrowmake adapter maps `min_tokens` and
`ignore_eos`; every successful response returned **512 completion tokens** and
`finish_reason=length`.

## Consolidated measurements

Medians and ranges from the controlled run; original is the single archived
`glm-bench-final.json`.

| Context | Path | Median tok/s | Range | TTFT median s | Input / output | DFlash raw counters |
|---|---|---:|---:|---:|---|---|
| 32K | Original standalone | 116.40 | one run | 0.711 | 32,162 / 512 | 96/110 accepted steps, mean 4.22 |
| 32K | Reproduced direct | 116.19 | 115.62–116.37 | 0.725 | same | 96/110, mean 4.22 |
| 32K | Xinference adapter | 116.29 | 115.39–116.35 | 0.776 | same | same output hash |
| 32K | Router | 116.20 | 115.64–116.40 | 0.782 | same | same output hash |
| 128K | Original standalone | 78.82 | one run | 0.897 | 128,327 / 512 | 222/278 accepted steps, mean 3.37 |
| 128K | Reproduced direct | 76.53 | 74.92–89.39 | 0.993 | same | 131/178 first run, mean 2.55 |
| 128K | Xinference adapter | 83.81 | 73.95–102.52 | 1.057 | same | different output trajectories |
| 128K | Router | 87.13 | 67.21–101.83 | 1.063 | same | different output trajectories |
| 256K | Original standalone | 131.37 | one run | 1.457 | 261,572 / 512 | 305/378 accepted steps, mean 3.81 |
| 256K | Reproduced direct | **89.71** | 89.14–91.28 | 1.607 | same | 117/146 accepted steps, mean 3.15 |
| 256K | Xinference adapter | **88.50** | 88.16–89.54 | 1.636 | same | same output hash |
| 256K | Router | **89.04** | 88.59–89.74 | 1.687 | same | same output hash |

The table's DFlash “accepted steps” is `spec_decode_num_accepted_tokens_per_pos`
position 0 delta; mean is accepted tokens divided by those steps. The archived
original report's **65.9% / 5.14** value does not match this counter definition;
the old JSON does not store the exact aggregate used in that report. This
metadata discrepancy is unresolved, but the raw counter comparison still shows
the key fact: current 256K has a **shorter accepted chain** (3.15 vs 3.81 by
this definition), while accepted-step rate is similar (80.1% vs 80.7%).

Prefix-cache hit rate is not emitted by this engine build's `/metrics`; measured
requests were preceded by the exact-prompt warm request, and their TTFTs
(1.0–1.7 s at 128K/256K) match a cached measured pass, not cold prefill
(20–29 s). The hit-rate field is therefore reported as unavailable rather than
invented.

## Direct vs native vs router

- **32K:** all three paths have the same output hash and ~116.2 tok/s. Adapter
  and router overhead is below measurement noise.
- **128K:** direct 76.5, native 83.8, router 87.1 median; ranges overlap and the
  output hashes differ between paths. This is output/DFlash variance, not a
  consistent pipeline tax.
- **256K after the router fix:** direct 89.7, native 88.5, router 89.0; the
  common output hash is identical across paths. Adapter/router overhead is
  approximately 1% or less.

## Verified integration defect fixed

Before the fix, the router rejected a 256K request with HTTP 503
`no healthy backend can serve model 'glm-5.3-flash'` in ~0.03 s. Root cause:

- `_text_of(payload)` returned 1,302,054 prompt characters;
- `chars/3` estimated **434,019 tokens**, above the 262,144 limit;
- the router therefore never selected the healthy GLM backend.

Fix, within the existing router:

- use the active backend's real `/tokenize` endpoint (vLLM returns 200 for the
  261,572-token prompt);
- cache the exact count with model-aware keys;
- preserve the pessimistic fallback when no tokenizer is available;
- fix a model/URL dedup bug that prevented the direct GLM tokenizer candidate
  from being retried;
- set the GPU0 slot's max context to the GLM profile's 262,144 value.

After restart, the same 256K request returned HTTP 200 and was served at
~89 tok/s. Five repetitions succeeded.

## DFlash acceptance

The original 256K output differs from the current output at the first token:
original head begins “The user has pasted a long repeated prompt…”, current
head begins “The user has sent a massive repeated prompt…”. Same prompt hash,
same payload, same engine. This is target-generation nondeterminism under
temperature 0; DFlash draft acceptance follows the chosen target trajectory.

The current 256K accepted chain is shorter (3.15 mean accepted versus 3.81 in
the archived raw counters), which directly reduces decode tokens per step. No
DFlash parameter was changed: the draft depth is 7, adaptive K by load is
unchanged, and no tuning was done solely to raise acceptance percentage.

**Can 131.4 tok/s be reproduced?** No, not with the original prompt, payload and
pinned engine in five repetitions. Best direct run was 91.28 tok/s; median
89.71. The original was a single high-acceptance trajectory, not a reproducible
throughput baseline.

**Is it reproducible through Xinference/router?** No; they track direct exactly,
so the original gap is not a managed-path regression.

## Final managed profile

- Profile `glm53-pp4`: **enabled**, inactive (Qwen is active).
- Native Xinference family `glm-5.3-flash`, `model_family=glm-5.3`, engine
  Morrowmake, context 262,144, tools and reasoning.
- Four GPU UUIDs preserved in Spark telemetry; bridge identity verified.
- Qwen → GLM → Qwen switch verified through Model Lab.
- Qwen `qwen38-gpu1` and `qwen38-flashnext` restored and READY.
- Router GPU1/GPU2 healthy; GPU0/GPU3 free.
- Power: 180 W unchanged; performance trace 5 s max **148.94 W**, instantaneous
  max **306.94 W**, no guard trip; safety services active.
- No competing models on GPU0–GPU3.

## Commits and artifacts

- Source commit: `1db825a05d33bc255f002501dc2493d5299bb3cc`
- Documentation/state commit: `f49619389ee6b8ca6b2670498faf4ab2fc9bf749`
- Performance artifacts:
  - `research/morrowmake/glm-results/glm-bench-paths.json`
  - `research/morrowmake/glm-results/glm-bench-router-256.json`
  - `research/morrowmake/glm-results/power-trace-performance.jsonl`
- Raw host artifacts: `/home/ffard/glm53-test/glm-bench-paths.json`,
  `/home/ffard/glm53-test/glm-bench-router-256.json`,
  `/home/ffard/glm53-test/power-trace-performance.jsonl`
- Router patch/config: `/home/ffard/glm53-test/router.py.pre-tokenizer`,
  `/opt/hyperqwen-control/router/router.py`,
  `/etc/hyperqwen-control/backends.json`

No GitHub push: no credentials. The local commits are retained.

## Answers

1. **Original 131.4 at 256K reproducible?** No. Current median is 89.7 direct;
   best 91.28. The original was a single high-acceptance output trajectory.
2. **Reproducible through Xinference/router?** They match direct within ~1%;
   the original number itself is not reproducible on any path.
3. **What prevents reproduction?** Target output trajectory and DFlash accepted
   length, not prompt, payload, power throttling or adapter overhead.
4. **Managed-pipeline regression?** No. 32K is identical; 256K direct and native
   have the same hash and throughput.
5. **Parameters silently modified/dropped?** No. `min_tokens`, `ignore_eos`,
   `max_tokens`, streaming and usage survive; 512 tokens returned.
6. **Performance improvements implemented?** Router exact-tokenizer/context
   handling for 256K, including the 503 false rejection; no engine or DFlash
   tuning was justified.
7. **Final reproducible GLM throughput?** 32K ~116 tok/s; 128K direct 76.5 /
   native 83.8 / router 87.1 (noisy); 256K direct 89.7 / native 88.5 / router
   89.0.
8. **Integrated profile functional and safe?** Yes; enabled, native family,
   tools/reasoning/streaming verified, four-GPU telemetry, 180 W averaged guard
   clean.
9. **Qwen and safety restored?** Yes; both Qwen models READY, router healthy,
   all safety units active.
