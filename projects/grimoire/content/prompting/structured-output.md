---
title: Structured Output and Tool Schemas
description: Getting reliable, machine-parseable JSON out of a model.
tags: [prompting, structured-output, json, tools]
summary: Constrain the format with schemas and validation, not just polite requests.
status: published
---

# Structured Output and Tool Schemas

When a model's output feeds into code — a database, an API call, a UI — you need it in
a predictable, parseable shape, usually JSON. "Please respond in JSON" gets you *mostly*
JSON, and *mostly* is a production incident waiting to happen: a stray markdown fence,
a trailing comment, a hallucinated field. This page is about getting the *reliable*
version.

## Levels of enforcement, weakest to strongest

1. **Ask nicely in the prompt.** Describe the exact shape and give an example. Works
   often, fails occasionally, and the failures are unpredictable. Fine for
   experiments, not for pipelines.
2. **JSON mode.** Many providers offer a flag that guarantees *syntactically valid*
   JSON. It stops "here's your JSON:" preambles and broken syntax — but it does **not**
   guarantee your *schema* (right fields, right types).
3. **Schema-constrained / structured output.** The provider constrains generation to a
   JSON Schema you supply, so the output is valid *and* conforms to your fields and
   types. This is the strongest and the one to prefer when available. Support and exact
   capabilities vary by provider and move quickly — check current docs.
4. **Tool / function calling.** You declare functions with typed parameter schemas; the
   model emits a structured call matching a schema. Even if you never execute the
   "tool," this is a robust way to extract typed structured data. It is the same
   mechanism [agents](../agents/react-and-tool-use.md) use to act.

## Always validate, regardless

Even with schema-constrained output, validate on your side:

```
raw = model.generate(...)
try:
    data = json.loads(raw)
    validate(data, schema)      # e.g. a JSON Schema / pydantic / zod check
except (ParseError, SchemaError):
    # retry once with the error message fed back, then fail loudly
```

Treat model output as **untrusted input** to your program. A validate-and-retry loop —
feeding the parse or schema error back to the model on the retry — recovers most
transient formatting slips cheaply.

## Designing a good schema

- **Flat beats deeply nested.** Models fill shallow structures more reliably.
- **Constrain with enums.** `"severity": "low" | "medium" | "high"` is far more robust
  than a free-text severity field.
- **Name fields descriptively.** `customer_email` guides the model better than `field2`.
  The schema *is* part of the prompt.
- **Make optionality explicit.** Say whether a field may be null and what null means, or
  the model will invent a plausible value rather than omit it.
- **Add a "not found" path.** For extraction, give the model a legitimate way to report
  "this isn't in the source" (e.g. `"amount": null`), so it doesn't fabricate to fill
  the slot.

## A worked example: extraction

```
Schema: { "vendor": string, "total": number, "currency": string (ISO 4217),
          "date": string (YYYY-MM-DD), "confidence": "high" | "low" }

Instruction: Extract the invoice fields from the text between <doc> tags.
If a field is absent, use null. Set "confidence": "low" if you are unsure.
```

The `confidence` field is a cheap, useful trick: it gives the model a way to flag
uncertainty instead of guessing, and gives your code a signal to route low-confidence
extractions to a human.

## Keep temperature low

Structured tasks want predictability, so run them at a low
[temperature](../foundations/sampling-and-decoding.md) (0–0.2). Creativity is the enemy
of a stable schema.

Next: [Few-Shot vs Zero-Shot](few-shot-vs-zero-shot.md).
