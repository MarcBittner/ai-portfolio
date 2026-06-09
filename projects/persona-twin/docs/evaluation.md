# Evaluation: why a single "fidelity %" hides what matters

It is tempting to grade a RAG/persona system with one number — "the
twin is 93% accurate." This project deliberately refuses to, and the
refusal is the design. `./run.sh eval` produces three tables
(`eval-report.md`), one per pipeline layer, and never a composite.

## The problem with one number

A single fidelity score is an average over failures with *different
causes, different costs, and different fixes*. Concretely, a system
can post 93% while:

- **failing every unanswerable question** — confidently inventing
  answers for the 7% of questions it should have refused. Refusals are
  a tiny slice of any eval set, so hallucination-on-miss barely moves
  a composite. It is also the single most damaging behavior in
  production.
- **citing nothing it actually used** — answers correct *by luck of
  the parametric weights*, not grounded in the retrieved record. Looks
  identical in a composite; collapses the moment the corpus and the
  model's priors diverge (i.e., on exactly the data you built RAG for).
- **hiding a retrieval regression behind a strong generator** — the
  model paper-overs rank-7 evidence with plausible filler. The
  composite drifts down 2 points; nobody can say which stage moved.

And the inverse problem: a composite *punishes* honest behavior. A
correct refusal scores zero against a reference answer. Verbose-but-
factual answers score low on token overlap. One number can't tell
caution from failure or verbosity from hallucination.

## The three layers

Each layer asks a question only that layer can answer, and each
failure points at the stage that owns it:

| Layer | Question | Metrics | A failure means |
|---|---|---|---|
| **Retrieval** | Did the evidence reach the context? | hit-rate@k, MRR — per chunking strategy, ± rerank | Fix chunking/embedding/rerank. No prompt will help. |
| **Grounding** | Is the answer *from* the evidence? | citation precision, claim support (LLM-judge live / lexical heuristic offline), refusal recall, false-refusal rate | Fix prompting/validation. Retrieval may be fine. |
| **Quality** | Is the answer good? | token F1, fact presence, voice violations | Fix generation/model choice — *only after* the layers above pass. |

The current offline report is a live demonstration of why the layers
must stay separate:

- **Rerank earns its place quantitatively**: MRR jumps ~0.74 → ~0.94
  across all three chunking strategies. A composite would have buried
  the stage's entire contribution in noise.
- **Token F1 reads "bad" (0.24) while fact presence reads "decent"
  (0.64)** — the extractive mock answers verbosely but factually.
  One number would average these into a meaningless 0.4; two numbers
  diagnose verbosity, not hallucination.
- **Refusal recall is 1.0 and false refusals are visible (≈0.11)** —
  the caution/coverage tradeoff is explicit and tunable instead of
  invisibly folded into an accuracy figure.

## Measurement honesty

- The **claim-support judge is labeled** in every report:
  `llm-judge` when a real provider is configured, `lexical-heuristic`
  offline. A weaker instrument is fine; an unlabeled one is not.
- The eval dataset is **committed** (`data/eval/questions.yaml`,
  32 items, 4 deliberately unanswerable) and the offline run is fully
  deterministic — the numbers in `eval-report.md` reproduce exactly.
- Unanswerables are first-class eval items, not edge cases: a twin
  that won't say "my notes don't cover that" is broken regardless of
  its accuracy elsewhere.

## Operational rule

When a change lands, run `./run.sh eval` and read the tables *top down*:
a retrieval regression invalidates everything below it; a grounding
regression invalidates quality. Improving a lower layer while an upper
one is broken is wasted motion — which is precisely the information a
single fidelity % deletes.
