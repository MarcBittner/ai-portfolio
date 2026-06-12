"""Append-only, hash-chained audit log — tamper-evident by construction.

Every governed request appends one entry; each entry stores the hash of the
previous one and a SHA-256 over its own (hash-excluded) content, so any later
mutation, insertion, or deletion breaks the chain and ``verify()`` reports the
first broken sequence number.

Entries hold only **redacted** request/response text (the gateway redacts before
logging), so the audit trail is safe to retain. In-memory here (per instance);
a production deployment would persist to an append-only store / WORM bucket.
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
        blob = json.dumps(body, sort_keys=True, default=str).encode()
        return hashlib.sha256(blob).hexdigest()

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

    def __len__(self) -> int:
        return len(self._entries)

    def demo_tamper(self, seq: int) -> bool:
        """Mutate a stored entry WITHOUT re-hashing — to demonstrate that
        ``verify()`` then detects it. Demo aid only; never a real operation."""
        for e in self._entries:
            if e["seq"] == seq:
                e["input_verdict"] = "allow"  # silently flip a logged decision
                e["_tampered"] = True
                return True
        return False


log = AuditLog()
