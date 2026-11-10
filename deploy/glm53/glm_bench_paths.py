#!/usr/bin/env python3
"""Five-repetition direct/Xinference/router GLM benchmark with engine counters."""
from __future__ import annotations
import hashlib, json, re, statistics, subprocess, time, urllib.request
from pathlib import Path
from transformers import AutoTokenizer

TOKENIZER = "/home/ffard/glm53-test/models/GLM-5.3-Flash-W4A16-MTP"
OUT = "/home/ffard/glm53-test/glm-bench-paths.json"
BASE = {
    "direct": ("http://127.0.0.1:8001", "glm-5.3-flash"),
    "xinference": ("http://127.0.0.1:9997", "glm53-pp4"),
    "router": ("http://127.0.0.1:18030", "glm-5.3-flash"),
}
TARGETS = [32768, 131072, 267300]
REPS = 5


def build_prompt(tok, target):
    base = ("You are a careful systems engineer. Read the following telemetry notes and "
            "answer with a concise diagnosis. The GPU server has four cards, two NUMA "
            "nodes, and a narrow PCIe fabric. Keep every statement grounded in the text. ")
    ids = tok.encode(base, add_special_tokens=False)
    reps = max(1, (target + len(ids) - 1) // len(ids) + 1)
    ids = tok.encode(base * reps, add_special_tokens=False)[:target]
    content = tok.decode(ids, skip_special_tokens=True)
    messages = [{"role": "system", "content": "You are a precise, concise assistant."},
                {"role": "user", "content": content + "\n\nSummarize the main bottleneck in one sentence."}]
    return tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True), len(tok.encode(tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True), add_special_tokens=False))


def stream(url, body, timeout=1800):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
    t0 = time.perf_counter(); first = None; chunks = []; usage = None; finish = None
    with urllib.request.urlopen(req, timeout=timeout) as r:
        for raw in r:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"): continue
            data = line[5:].strip()
            if data == "[DONE]": break
            ev = json.loads(data)
            if first is None: first = time.perf_counter()
            if ev.get("usage"): usage = ev["usage"]
            for ch in ev.get("choices", []):
                piece = (ch.get("delta") or {}).get("content") or ch.get("text")
                if piece: chunks.append(piece)
                if ch.get("finish_reason"): finish = ch["finish_reason"]
    end = time.perf_counter(); text = "".join(chunks)
    comp = (usage or {}).get("completion_tokens") or len(text.split())
    dec = end - (first or t0)
    return {"ttft_s": round((first or t0) - t0, 4), "total_s": round(end - t0, 4),
            "decode_s": round(dec, 4), "completion_tokens": comp,
            "decode_tps": round(comp / dec, 3) if dec > 0 else None,
            "usage": usage, "finish_reason": finish,
            "text_sha256": hashlib.sha256(text.encode()).hexdigest(),
            "text_head": text[:160], "text_tail": text[-160:], "chunks": len(chunks)}


def metrics():
    try:
        with urllib.request.urlopen("http://127.0.0.1:8001/metrics", timeout=10) as r:
            text = r.read().decode("utf-8", "replace")
    except Exception:
        return {}
    out = {}
    for line in text.splitlines():
        if line.startswith("#") or " " not in line: continue
        name, value = line.rsplit(" ", 1)
        try: out[name] = out.get(name, 0.0) + float(value)
        except ValueError: pass
    return out


def counter_delta(before, after, needle):
    return {k: after.get(k, 0.0) - before.get(k, 0.0) for k in after if needle in k and k in before}


def main():
    tok = AutoTokenizer.from_pretrained(TOKENIZER, trust_remote_code=True)
    results = {"tokenizer": TOKENIZER, "paths": BASE, "targets": TARGETS, "reps": REPS, "runs": []}
    Path(OUT).write_text(json.dumps(results, indent=2))
    for target in TARGETS:
        prompt, actual = build_prompt(tok, target)
        phash = hashlib.sha256(prompt.encode()).hexdigest()
        print("CONTEXT", target, "tokens", actual, "sha", phash, flush=True)
        # Explicit warm for each path, then five measured repetitions, rotating order.
        for path, (base, model) in BASE.items():
            warm_body = {"model": model, "prompt": prompt, "max_tokens": 1, "min_tokens": 1,
                         "temperature": 0.0, "ignore_eos": True, "stream": True,
                         "stream_options": {"include_usage": True}}
            try:
                w = stream(base + "/v1/completions", warm_body)
                print("WARM", path, target, w["ttft_s"], w["completion_tokens"], flush=True)
            except Exception as exc:
                print("WARM_ERROR", path, target, repr(exc), flush=True)
        for i in range(REPS):
            order = ["direct", "xinference", "router"]
            order = order[i % 3:] + order[:i % 3]
            for path in order:
                base, model = BASE[path]
                body = {"model": model, "prompt": prompt, "max_tokens": 512, "min_tokens": 512,
                        "temperature": 0.0, "ignore_eos": True, "stream": True,
                        "stream_options": {"include_usage": True}}
                before = metrics()
                t0 = time.time()
                try:
                    m = stream(base + "/v1/completions", body)
                    err = None
                except Exception as exc:
                    m = None; err = repr(exc)
                after = metrics()
                run = {"target": target, "actual_prompt_tokens": actual, "prompt_sha256": phash,
                       "rep": i, "path": path, "model": model, "measured": m, "error": err,
                       "started": t0, "elapsed": round(time.time() - t0, 3),
                       "drafts_delta": counter_delta(before, after, "spec_decode_num_drafts_total"),
                       "draft_tokens_delta": counter_delta(before, after, "spec_decode_num_draft_tokens_total"),
                       "accepted_delta": counter_delta(before, after, "spec_decode_num_accepted_tokens_total"),
                       "accepted_pos_delta": counter_delta(before, after, "spec_decode_num_accepted_tokens_per_pos_total"),
                       "gpu": subprocess.run(["nvidia-smi", "--query-gpu=index,power.draw,clocks.sm,temperature.gpu", "--format=csv,noheader"], capture_output=True, text=True).stdout.strip()}
                results["runs"].append(run)
                Path(OUT).write_text(json.dumps(results, indent=2))
                print(json.dumps({k: run[k] for k in ("target","rep","path","error","elapsed")} | {"tps": (m or {}).get("decode_tps"), "ttft": (m or {}).get("ttft_s"), "completion": (m or {}).get("completion_tokens")}), flush=True)
    Path(OUT).write_text(json.dumps(results, indent=2))
    print("WROTE", OUT, flush=True)

if __name__ == "__main__":
    main()
