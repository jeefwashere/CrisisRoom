"""Summarize a timing log written by the backend (see `backend/app/timing.py`).

    BOARDROOM_TIMING_LOG=/tmp/boardroom-timing.jsonl python -m uvicorn backend.app.main:app ...
    python backend/timing_report.py /tmp/boardroom-timing.jsonl

One row for each AI step: how many requests, the median and slowest time to the complete answer, the median time to
the first words, and the median length. Speech rows show the time to the first audio and to the whole line.
"""

import json
import statistics
import sys


def main(path: str) -> None:
    groups: dict[tuple[str, str], list[dict]] = {}
    with open(path, encoding="utf-8") as file:
        for line in file:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if row.get("kind") == "agent":
                key = ("agent " + str(row.get("agent")), str(row.get("step"))[:58])
            elif row.get("kind") == "speech":
                key = ("speech " + str(row.get("mode")), str(row.get("voice")))
            else:
                continue
            groups.setdefault(key, []).append(row)

    def median(rows: list[dict], field: str):
        values = [row[field] for row in rows if isinstance(row.get(field), (int, float))]
        return round(statistics.median(values), 2) if values else None

    print(f"{'kind':<15} {'step or voice':<60} {'n':>3} {'median':>7} {'slowest':>8} {'first':>6} {'size':>5} {'failed':>6}")
    for (kind, label), rows in sorted(groups.items()):
        size = median(rows, "words") if kind.startswith("agent") else median(rows, "characters")
        failed = sum(1 for row in rows if not row.get("ok"))
        slowest = max(row["seconds"] for row in rows)
        print(f"{kind:<15} {label:<60} {len(rows):>3} {median(rows, 'seconds'):>7} {slowest:>8} "
              f"{str(median(rows, 'first_seconds')):>6} {str(size):>5} {failed:>6}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
