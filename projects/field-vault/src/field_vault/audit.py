"""Append-only, hash-chained access audit — tamper-evident by construction.

Every field access and re-identification attempt (allowed or denied) appends one
entry; each entry hashes the previous one plus its own content, so any later
mutation breaks the chain and ``verify()`` reports the first broken sequence.

Entries record *who/what/why/decision* — role, record, field, action, purpose,
allowed/denied — but **never the field value**: an access log must not become a
second copy of the data it guards. In-memory here; production would persist to a
WORM store.
"""

import hashlib
import json
import time
from dataclasses import dataclass, field

GENESIS = "0" * 64


@dataclass
class AuditLog:
    _entries: list[dict] = field(default_factory=list)

    @staticmethod
    def _hash(entry: dict) -> str:
        body = {k: v for k, v in entry.items() if k != "hash"}
        return hashlib.sha256(
            json.dumps(body, sort_keys=True, default=str).encode()).hexdigest()

    def append(self, event: dict) -> dict:
        prev = self._entries[-1]["hash"] if self._entries else GENESIS
        entry = {"seq": len(self._entries), "ts": round(time.time(), 3),
                 **event, "prev_hash": prev}
        entry["hash"] = self._hash(entry)
        self._entries.append(entry)
        return entry

    def verify(self) -> dict:
        prev = GENESIS
        for e in self._entries:
            if e["prev_hash"] != prev:
                return {"ok": False, "broken_at": e["seq"], "reason": "broken chain link"}
            if self._hash(e) != e["hash"]:
                return {"ok": False, "broken_at": e["seq"],
                        "reason": "content hash mismatch"}
            prev = e["hash"]
        return {"ok": True, "broken_at": None, "length": len(self._entries)}

    def entries(self) -> list[dict]:
        return list(self._entries)

    def reset(self) -> None:
        self._entries.clear()

    def __len__(self) -> int:
        return len(self._entries)

    def demo_tamper(self, seq: int) -> bool:
        """Flip a logged decision WITHOUT re-hashing, to show verify() catches it."""
        for e in self._entries:
            if e["seq"] == seq:
                e["allowed"] = not e.get("allowed", False)
                e["_tampered"] = True
                return True
        return False


log = AuditLog()
