# Tanglement.ai — Decentralized, Multi-Provider LLM Routing

**Public work showcase by Marc Bittner (founding engineer).** Architecture & spec, the demo site, and the pitch — the engineering, not the production codebase.

Tanglement.ai is a peer-to-peer network that optimizes LLM access through intelligent **client-side routing**, with *no centralized company infrastructure in the request path*. Apps embed the SDK; a local routing engine picks the best provider per request (cost / latency / reliability); calls go **directly** to the provider (OpenAI, Anthropic, Google) using the user's **own API keys** — Tanglement never touches or stores credentials — and nodes share routing intelligence over a gossip protocol. Result: no proxy bottleneck, no single point of failure, and operating cost of roughly **$0–65/month vs. $100k+/month** for a traditional API gateway.

## My role
Founding engineer. I authored the architecture and the full multi-section technical specification, designed the routing / DHT / security model, built the Go + TypeScript implementation, and lead a team of 8 engineers. *(Design and early-implementation stage.)*

## In this showcase
- **[`docs/spec/`](docs/spec/)** — the technical specification: system overview, architecture, routing, security, performance, protocols, API, implementation, testing, operations, and the development plan (incl. **Chord DHT** + **NAT-traversal** strategy).
- **[`demo-site/`](demo-site/)** — the public teaser site (Next.js).
- **Code sample** — [`code/git-encrypt/`](code/git-encrypt/): a self-contained, stdlib-only Go CLI (transparent git file encryption, ECDH/ECDSA).
- **Pitch deck** — [`Tanglement.ai-Pitch-Deck.pdf`](Tanglement.ai-Pitch-Deck.pdf) (viewable) · [`.pptx`](Tanglement.ai-Pitch-Deck.pptx) source.

*(The production backend codebase is private; this is a curated showcase of the design and public-facing pieces.)*

## Engineering highlights
- **Client-side intelligent routing** — provider selection on cost/performance/reliability, computed locally, no middleman.
- **Zero-trust by design** — users keep their own keys; credentials never transit Tanglement.
- **P2P intelligence** — Chord DHT peer discovery + gossip-propagated routing intelligence over a WireGuard-encrypted mesh.
- **Polyglot SDK** — Python, TypeScript, Go, Rust, Java.

**Stack:** Go · TypeScript / Next.js · Chord DHT · gossip protocol · WireGuard · multi-provider LLM APIs.
