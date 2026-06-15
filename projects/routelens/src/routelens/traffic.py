"""Synthetic traffic generator — a realistic mix of OpenAI-shaped requests across
task classes, deterministic by seed.

It deliberately bakes in the patterns the analytics should *find*:

* a **large shared system prefix** on the extraction tasks (so the prompt-cache
  strategy has something real to detect), and
* a handful of **exact-repeat deterministic requests** (so the response-cache
  strategy has something real to detect).

All content is synthetic and fictional. The ``model`` stamped on each request is
the *baseline* the customer "intended"; routelens decides whether a cheaper model
can serve it.
"""

from __future__ import annotations

import random

# A long, stable extraction system prompt (~1.5k tokens) shared across many
# requests — exactly the kind of prefix worth caching.
_EXTRACTION_SYSTEM = (
    "You are an enterprise document-extraction engine. Return STRICT JSON only, "
    "no prose. Follow this schema and these rules exactly.\n\n"
    "SCHEMA: {invoice_number, vendor_name, vendor_tax_id, invoice_date (ISO-8601), "
    "due_date (ISO-8601), currency (ISO-4217), subtotal, tax, total, "
    "line_items:[{sku, description, quantity, unit_price, amount}], "
    "po_number, payment_terms, remit_to_address, notes}.\n\n"
    "RULES:\n"
    + "\n".join(f"- Rule {i}: normalize, validate, and never invent a value; emit "
                f"null when a field is genuinely absent from the source document; "
                f"preserve original currency; recompute totals and flag mismatches."
                for i in range(1, 26))
    + "\n\nReturn JSON only."
)

_TASKS: dict[str, list[dict]] = {
    "extraction": [
        {"system": _EXTRACTION_SYSTEM,
         "user": "Extract this invoice:\nACME Corp #{n}\nDate 2026-0{m}-1{d}\n"
                 "Widget x{q} @ ${p}\nSubtotal ${p}\nTax $3\nTotal ${t}",
         "json": True},
    ],
    "classification": [
        {"system": "Classify the support ticket as one of: billing, bug, "
                   "feature_request, account, other. Reply with one word.",
         "user": "Ticket: My card was charged twice for order {n}, please help."},
        {"system": "Label the sentiment as positive, negative, or neutral.",
         "user": "Review: product {n} arrived late and the box was crushed."},
    ],
    "summarization": [
        {"system": "Summarize in two sentences.",
         "user": "Meeting {n}: the team reviewed the Q{q} roadmap, agreed to ship "
                 "the routing feature first, deferred the dashboard, and flagged a "
                 "staffing risk on the data team that needs an exec decision."},
    ],
    "chat": [
        {"system": "You are a concise assistant.",
         "user": "What's a good name for a {q}-person standup ritual?"},
        {"system": "You are a concise assistant.",
         "user": "Give me one tip for reviewing pull request {n} faster."},
    ],
    "codegen": [
        {"system": "You write small, correct Python functions.",
         "user": "Write a function that returns the {q}th Fibonacci number."},
    ],
    "reasoning": [
        {"system": "Think carefully and explain your reasoning step by step.",
         "user": "A train leaves at {m}:00 going {p} mph and another at {m}:30 "
                 "going {t} mph on the same track {n} miles apart. Do they meet, "
                 "and if so when? Show the steps."},
    ],
}


def generate(n: int = 60, seed: int = 1,
             baseline_id: str = "claude-sonnet-4-6") -> list[dict]:
    rng = random.Random(seed)
    classes = list(_TASKS)
    # weight toward the cheap-to-downgrade classes that dominate real traffic
    weights = {"extraction": 4, "classification": 4, "summarization": 2,
               "chat": 3, "codegen": 1, "reasoning": 2}
    pool = [c for c in classes for _ in range(weights.get(c, 1))]
    out: list[dict] = []
    for _ in range(n):
        tc = rng.choice(pool)
        tpl = rng.choice(_TASKS[tc])
        fills = {"n": rng.randint(1000, 9999), "m": rng.randint(1, 9),
                 "d": rng.randint(0, 9), "q": rng.randint(2, 12),
                 "p": rng.randint(5, 99), "t": rng.randint(100, 999)}
        user = tpl["user"].format(**fills)
        msgs = []
        if tpl.get("system"):
            msgs.append({"role": "system", "content": tpl["system"]})
        msgs.append({"role": "user", "content": user})
        req = {"model": baseline_id, "messages": msgs, "max_tokens": 400,
               "temperature": 0.0}
        if tpl.get("json"):
            req["response_format"] = {"type": "json_object"}
        out.append(req)

    # inject exact repeats so response-cache has something real to find
    if out:
        repeat = out[0]
        for _ in range(max(2, n // 12)):
            out.append({k: v for k, v in repeat.items()})
    rng.shuffle(out)
    return out
