# Wiring up free models

Three tiers of $0 inference, all routed by the same policy engine and
benchmarkable side-by-side in `/analytics`.

## 1. Local — Ollama (private, unlimited, slower)

```sh
OLLAMA_BASE_URL=http://localhost:11434
```

Loaded models are auto-discovered at startup at $0 cost, so they win
`cost`-objective routing automatically.

## 2. OpenRouter free tier (one key, rotating big models)

Create a free key at <https://openrouter.ai>, then:

```sh
OPENROUTER_API_KEY=...
# PERSONA_TWIN_OPENROUTER_FREE=0   # to disable free-model discovery
```

At startup the service queries OpenRouter's catalog and merges every
model priced **$0/$0** (capped at 8, largest context first). The free
lineup churns weekly — discovery beats hardcoding. Expect rate limits.

## 3. Any other OpenAI-compatible free tier

Declare them as data — `PERSONA_TWIN_EXTRA_PROVIDERS` is a JSON list;
keys stay in their own env vars (the JSON never contains secrets):

```sh
PERSONA_TWIN_EXTRA_PROVIDERS='[
  {"name": "groq",
   "base_url": "https://api.groq.com/openai/v1",
   "api_key_env": "GROQ_API_KEY",
   "models": [
     {"id": "llama-3.3-70b-versatile", "quality": 7, "speed": 10},
     {"id": "llama-3.1-8b-instant",    "quality": 5, "speed": 10}]},
  {"name": "gemini",
   "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
   "api_key_env": "GEMINI_API_KEY",
   "models": [{"id": "gemini-2.0-flash", "quality": 7, "speed": 9}]},
  {"name": "cerebras",
   "base_url": "https://api.cerebras.ai/v1",
   "api_key_env": "CEREBRAS_API_KEY",
   "models": [{"id": "llama-3.3-70b", "quality": 7, "speed": 10}]}
]'
GROQ_API_KEY=...        # console.groq.com — free
GEMINI_API_KEY=...      # aistudio.google.com — free
CEREBRAS_API_KEY=...    # cloud.cerebras.ai — free
```

Known-good free tiers (verify current model ids on each console —
they churn):

| Service | Console | Base URL |
|---|---|---|
| Groq | console.groq.com | `https://api.groq.com/openai/v1` |
| Google AI Studio | aistudio.google.com | `https://generativelanguage.googleapis.com/v1beta/openai` |
| Cerebras | cloud.cerebras.ai | `https://api.cerebras.ai/v1` |
| Mistral | console.mistral.ai | `https://api.mistral.ai/v1` |
| GitHub Models | github.com/marketplace/models | `https://models.github.ai/inference` |

## The rules don't change

- **Policy stays first-party**: every model lands in the same registry
  and routes by the same objectives/pins (`/console`)
- **Trust nothing untested**: declared `quality`/`speed` are priors —
  run the model through `/analytics` before pinning a task to it
- **Free ≠ private**: hosted free tiers see your prompts (and several
  train on them). The synthetic corpus makes that harmless *here*; for
  real data, that's what local Ollama and the PII redactor are for.
- Structured-output support varies on free hosted models; a model that
  mangles the schema fails through the router's validation-retry and
  shows up as `errors` in benchmarks, never as silent bad data
