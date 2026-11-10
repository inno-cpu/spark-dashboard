#!/usr/bin/env python3
"""Register the real GLM-5.3-Flash family through the installed Xinference API."""
import json
import sys
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:9997"
BUILTIN = "/opt/xinference/venv/lib/python3.14/site-packages/xinference/model/llm/models/glm-5.3.json"
MARKER = "/var/lib/xinference/external-models/glm53-pp4-marker"

family = json.load(open(BUILTIN))[0]
family["model_name"] = "glm-5.3-flash"
family["context_length"] = 262144
family["model_description"] = "GLM-5.3-Flash external Morrowmake PP4 runtime (four CMP 170HX GPUs)."
family["model_ability"] = ["chat", "generate", "tools", "reasoning"]
family["model_family"] = "glm-5.3"
family["model_specs"] = [{
    "model_metadata": None,
    "model_format": "pytorch",
    "model_size_in_billions": "753",
    "quantization": "none",
    "model_id": None,
    "model_hub": "huggingface",
    "model_uri": MARKER,
    "model_revision": None,
    "activated_size_in_billions": None,
    "draft_model_id": None,
    "draft_quantizations": None,
    "draft_model_revision": None,
}]
family["virtualenv"] = None
family["engine_allowlist"] = ["Morrowmake"]
family["is_builtin"] = False
family["tool_parser"] = "glm5"
family["reasoning_start_tag"] = "<think>"
family["reasoning_end_tag"] = "</think>"

body = {"model": json.dumps(family), "worker_ip": None, "persist": True}
req = urllib.request.Request(
    BASE + "/v1/model_registrations/LLM",
    data=json.dumps(body).encode(),
    headers={"Content-Type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=120) as response:
        print("register", response.status, response.read().decode()[:1000])
except urllib.error.HTTPError as exc:
    print("register HTTP", exc.code, exc.read().decode()[:3000])
    sys.exit(1)
with urllib.request.urlopen(BASE + "/v1/model_registrations/LLM", timeout=30) as response:
    rows = json.loads(response.read())
print("listed", [row for row in rows if row.get("model_name") == "glm-5.3-flash"])

