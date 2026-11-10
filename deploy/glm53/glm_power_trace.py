#!/usr/bin/env python3
"""Timestamped NVML power trace with an averaged-power stop guard.

Instantaneous power is recorded at 20 Hz. The guard acts only on the rolling
5 s mean per GPU. It stops the diagnostic GLM container if the mean exceeds
185 W (180 W policy + 5 W measurement tolerance), so transient instantaneous
spikes cannot be mistaken for a sustained violation.
"""
from __future__ import annotations

import ctypes as C
import ctypes.util
import json
import os
import subprocess
import sys
import time
from collections import deque
from pathlib import Path

LOG = Path(sys.argv[1] if len(sys.argv) > 1 else "/home/ffard/glm53-test/logs/power-trace.jsonl")
CONTAINER = "glm53-flash-test"
LIMIT_W = 180.0
TOLERANCE_W = 5.0
TRIP_W = LIMIT_W + TOLERANCE_W
WINDOW_S = 5.0
INTERVAL_S = 0.05

lib = C.CDLL(ctypes.util.find_library("nvidia-ml") or "libnvidia-ml.so.1")
assert lib.nvmlInit_v2() == 0


def call(name, *args):
    return getattr(lib, name)(*args)


count = C.c_uint()
call("nvmlDeviceGetCount_v2", C.byref(count))
handles = []
for idx in range(count.value):
    h = C.c_void_p()
    call("nvmlDeviceGetHandleByIndex_v2", C.c_uint(idx), C.byref(h))
    handles.append(h)

history = [deque() for _ in handles]
LOG.parent.mkdir(parents=True, exist_ok=True)
guard_tripped = False
started = time.time()
with LOG.open("w", buffering=1) as out:
    out.write(json.dumps({"event": "start", "t": started, "limit_w": LIMIT_W, "trip_w": TRIP_W}) + "\n")
    while True:
        now = time.time()
        row = {"t": round(now, 4)}
        for idx, h in enumerate(handles):
            usage = C.c_uint()
            limit = C.c_uint()
            reasons = C.c_ulonglong()
            call("nvmlDeviceGetPowerUsage", h, C.byref(usage))
            call("nvmlDeviceGetEnforcedPowerLimit", h, C.byref(limit))
            call("nvmlDeviceGetCurrentClocksThrottleReasons", h, C.byref(reasons))
            watts = usage.value / 1000.0
            row[f"gpu{idx}_w"] = round(watts, 3)
            row[f"gpu{idx}_limit_w"] = round(limit.value / 1000.0, 3)
            row[f"gpu{idx}_throttle"] = hex(reasons.value)
            history[idx].append((now, watts))
            while history[idx] and now - history[idx][0][0] > WINDOW_S:
                history[idx].popleft()
            mean = sum(value for _, value in history[idx]) / len(history[idx])
            row[f"gpu{idx}_avg5s_w"] = round(mean, 3)
            if mean > TRIP_W and len(history[idx]) >= int(WINDOW_S / INTERVAL_S) * 0.8:
                guard_tripped = True
                row["TRIP"] = f"gpu{idx} avg5s {mean:.3f} W > {TRIP_W} W"
        out.write(json.dumps(row) + "\n")
        if guard_tripped:
            out.write(json.dumps({"event": "TRIP", "t": time.time(), "row": row}) + "\n")
            try:
                subprocess.run(["/usr/bin/docker", "stop", CONTAINER], timeout=180)
            except Exception as exc:  # noqa: BLE001
                out.write(json.dumps({"event": "STOP_ERROR", "error": str(exc)}) + "\n")
            out.write(json.dumps({"event": "guard_stopped_container", "t": time.time()}) + "\n")
            break
        time.sleep(INTERVAL_S)
