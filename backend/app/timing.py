"""Optional timing log for the AI steps: how long each piece of text and speech took.

Off by default. Set `BOARDROOM_TIMING_LOG` to a file path and every agent request and every speech synthesis
appends one JSON line there (step label, sizes and seconds; never prompts in full, answers, keys or audio; a
member's display name at the start of a prompt is dropped from the label by `agent_text.step_label`).
`backend/timing_report.py` summarizes the file. Logging must never break the game, so every failure is ignored.
"""

import json
import os
import threading
import time

_lock = threading.Lock()


def log(kind: str, **fields) -> None:
    path = os.environ.get("BOARDROOM_TIMING_LOG")
    if not path:
        return
    try:
        line = json.dumps({"at": round(time.time(), 3), "kind": kind, **fields}, ensure_ascii=False)
        with _lock, open(path, "a", encoding="utf-8") as file:
            file.write(line + "\n")
    except Exception:
        pass
