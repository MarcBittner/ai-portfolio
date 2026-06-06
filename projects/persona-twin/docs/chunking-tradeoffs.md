# Chunking strategy tradeoffs

Chunking decides what the retriever can ever find. Each strategy below is
implemented in `src/persona_twin/chunking/` behind one `Chunker`
interface, and every chunk is an **exact substring** of its source
document, so spans are verifiable and citations can highlight original
text.

> Measured numbers (hit-rate@k, MRR per strategy on the bundled corpus)
> are produced by the eval harness — see the table at the bottom, filled
> in once Phase 7 lands.

## fixed — size + overlap

The baseline: slide a window of `size` chars with `overlap`.

- **Pros:** trivial, predictable chunk count and memory, language-agnostic.
- **Cons:** blind to meaning. It splits mid-sentence and mid-thought, so
  (a) embeddings average over fragments of two unrelated thoughts, and
  (b) the generator receives clipped evidence, which both hurts grounding.
  Overlap papers over boundary loss at the cost of index size and
  duplicated retrievals that crowd out distinct evidence at fixed k.
- **Use when:** uniform unstructured text, or as a control to measure how
  much structure-awareness actually buys you (that's its job here).

## semantic — sentence packing to a size target

Pack whole sentences greedily up to `target_size`; never split inside a
sentence (a pathological sentence longer than `max_size` is hard-split).
Paragraph breaks count as sentence boundaries, so headings and list items
don't fuse with neighbors.

- **Pros:** chunks are coherent claims. Embeddings sharpen, and cited
  excerpts read as complete thoughts. Cheap — regex sentence splitting,
  no model calls.
- **Cons:** still blind to *document* structure: a section heading can be
  packed away from its body, and a list can be split across chunks.
  Sentence regexes also misfire on abbreviations ("Dr."), decimals, and
  informal text.
- **Use when:** prose-heavy corpora; usually the best quality/cost
  default.

## content_aware — structure first

Parse lightweight markdown structure (headings, list runs, Q&A pairs,
paragraphs), then group blocks to `target_size` under hard rules: a
heading travels with its content, list runs and Q&A pairs are atomic,
oversized blocks fall back to sentence packing.

- **Pros:** retrieval units match how authors organized meaning. A
  shopping list stays one unit; "Q: … A: …" stays answerable; a heading
  gives its section context. This typically shows up as better answer
  faithfulness more than better hit-rate — the retrieved chunk *contains
  the whole answer* instead of half of it.
- **Cons:** most code, most assumptions. Parsing heuristics are
  format-specific (this one assumes markdown-ish text); badly structured
  input degrades it to roughly semantic behavior. Variable chunk sizes
  complicate context-window budgeting.
- **Use when:** documents have real structure (journals, FAQs, posts —
  i.e., this project's corpus).

## What actually matters

1. **Chunking interacts with k and rerank.** Bigger chunks → fewer, denser
   candidates → recall pressure at small k; smaller chunks → ordering
   pressure that reranking must fix. Measure the pipeline, not the
   chunker.
2. **Eval per stage.** A chunking change shows up in retrieval hit-rate;
   if you only watch end-to-end answer scores you can't attribute the
   movement. This is why the harness reports per-strategy retrieval
   metrics separately (see `docs/evaluation.md`).
3. **Provenance is non-negotiable.** Exact char spans cost nothing at
   chunk time and make citations, dedup, and debugging tractable forever
   after.

## Measured results (Phase 7)

| Strategy | hit-rate@5 | MRR | + rerank hit-rate@5 | + rerank MRR |
|---|---|---|---|---|
| fixed | _tbd_ | _tbd_ | _tbd_ | _tbd_ |
| semantic | _tbd_ | _tbd_ | _tbd_ | _tbd_ |
| content_aware | _tbd_ | _tbd_ | _tbd_ | _tbd_ |
