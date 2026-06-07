# persona-twin eval report

_Backends: vector=memory, embeddings=hash, llm=['mock']_

Three layers, three tables. **No composite score** — see [docs/evaluation.md](docs/evaluation.md) for why.

## 1. Retrieval

| strategy | rerank | hit-rate@5 | MRR | n |
|---|---|---|---|---|
| fixed | no | 0.929 | 0.763 | 28 |
| fixed | yes | 1.000 | 0.940 | 28 |
| semantic | no | 0.929 | 0.744 | 28 |
| semantic | yes | 1.000 | 0.940 | 28 |
| content_aware | no | 0.964 | 0.727 | 28 |
| content_aware | yes | 1.000 | 0.929 | 28 |
| content_aware+hybrid | no | 1.000 | 0.815 | 28 |
| content_aware+hybrid | yes | 1.000 | 0.929 | 28 |

## 2. Grounding / faithfulness

| metric | value |
|---|---|
| citation precision | 0.711 |
| claim support rate (lexical-heuristic) | 1.000 |
| refusal recall (unanswerable → refused) | 1.000 |
| false refusal rate (answerable → refused) | 0.107 |

n = 28 answerable + 4 unanswerable

## 3. Answer quality

| metric | value |
|---|---|
| mean token F1 vs reference | 0.239 |
| fact presence rate | 0.640 |
| voice violation rate | 0.360 |

n = 25 answered items
