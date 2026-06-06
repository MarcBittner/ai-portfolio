# The persona layer: HEXACO-shaped digital twins

A twin's **facts come from retrieval; its voice comes from the
profile.** That separation is the core design rule: the system prompt
may shape *how* a persona speaks, never *what it knows* — and the
grounding rules in the prompt explicitly override style.

## Why HEXACO

The [HEXACO model](https://hexaco.org/) describes personality on six
empirically-derived dimensions. It improves on Big Five for this use
case mainly through the **Honesty–Humility** axis — the difference
between a persona that deflects praise and one that talks itself up is
exactly the kind of voice signal an audience-intelligence twin needs to
carry. Each persona's profile is six floats (0–1) in its committed
`persona.yaml`.

## Score → prompt mapping

`persona_twin.persona.prompting` maps each dimension into one of three
bands — **low** (< 0.4), **mid**, **high** (> 0.7) — and each band to a
concrete style instruction. Concrete beats abstract: "prefer exact
numbers, lists, and specifics" steers a model; "be conscientious" does
not.

| Dimension | Low | High |
|---|---|---|
| Honesty–Humility | self-promoting framing (style only) | modest, deflects praise |
| Emotionality | even-keeled understatement | feelings on the page |
| Extraversion | reserved, brief, no exclamations | energetic, direct address |
| Agreeableness | blunt, won't soften opinions | warm, softens disagreement |
| Conscientiousness | loose, digressive | exact numbers and lists |
| Openness | concrete, no poetry | metaphor and tangents |

Worked example — Buck Ramirez (`extraversion 0.9, conscientiousness
0.8, openness 0.4, emotionality 0.3`) renders as: energetic and
talkative · precise with numbers · concrete, skip the poetry ·
even-keeled. Which is exactly a coach yelling sets and reps,
cheerfully.

## Grounding rules (the part that overrides style)

Every system prompt ends with non-negotiables:

1. Answer **only** from the provided context chunks
2. Cite the chunk ids used
3. If the context doesn't support an answer: `answered=false` and an
   in-character refusal — no guessing
4. First person, always

Note the interaction handled in rule 1 + the low-Honesty–Humility
instruction: a self-promoting persona may *frame* facts favorably but
may not *invent* them. Style shapes tone; retrieval bounds truth.

## Enforcement beyond the prompt

Prompts are requests, not guarantees, so the pipeline verifies:

- **Structured output** — generation returns `{answer, answered,
  citations}` against a strict JSON schema, not free text
- **Citation validation** — cited chunk ids are checked against what
  was actually retrieved; anything else is dropped and logged
- **Eval** — grounding/faithfulness is measured separately from answer
  quality and voice consistency (see `docs/evaluation.md`)
