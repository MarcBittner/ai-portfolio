"""Field-level de-identification.

* **direct identifiers** → keyed **tokenization**: ``HMAC-SHA256(key, value)`` →
  a stable ``tok_…`` (same value always maps to the same token, so de-identified
  data still joins) that is **not reversible from the token alone**. The original
  is held in a vault and recoverable only via :meth:`Vault.detokenize` — which the
  access layer gates behind policy + audit.
* **quasi-identifiers** → one-way **generalization** (dob→birth year, zip→3-digit
  prefix, dates→year-month): reduces re-identification risk, no reverse.
* **clinical / financial** → kept as-is (the safe surface analytics runs on).

The HMAC key is a de-identification key (env ``FIELD_VAULT_TOKEN_KEY``), not a
secret credential; tokens are useless without the vault regardless.
"""

import hashlib
import hmac
import os

from field_vault.data import FIELD_CLASS

_KEY = os.environ.get("FIELD_VAULT_TOKEN_KEY", "field-vault-deid-key-v1").encode()


def _token(value: object) -> str:
    digest = hmac.new(_KEY, str(value).encode(), hashlib.sha256).hexdigest()
    return "tok_" + digest[:12]


def generalize(field: str, value: object) -> object:
    v = str(value)
    if field == "dob":                       # → birth year
        return v[:4]
    if field == "zip":                       # → 3-digit prefix
        return v[:3] + "**"
    if field == "service_date":              # → year-month
        return v[:7]
    return value


class Vault:
    """Holds the reversible token→original mapping for direct identifiers."""

    def __init__(self) -> None:
        self._map: dict[str, object] = {}

    def reset(self) -> None:
        self._map.clear()

    def deidentify(self, record: dict) -> dict:
        """Return a de-identified copy; populate the vault for direct fields."""
        out: dict[str, object] = {}
        for field, value in record.items():
            cls = FIELD_CLASS.get(field, "clinical")
            if cls == "direct":
                tok = _token(value)
                self._map[tok] = value
                out[field] = tok
            elif cls == "quasi":
                out[field] = generalize(field, value)
            else:
                out[field] = value
        return out

    def detokenize(self, token: str) -> object | None:
        return self._map.get(token)
