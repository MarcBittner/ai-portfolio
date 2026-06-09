# Deploy the persona-twin demo for free (public URL)

The `persona-twin` app runs **fully offline** by default — deterministic mock LLM + in-memory
vector store, corpus self-ingested on startup, synthetic data only. So free hosting needs **no API
keys and costs nothing**. The Dockerfile serves the API + built UI on `$PORT`.

## Option A — Render (one click, recommended for a shareable link)
1. Go to https://render.com and sign in with GitHub.
2. **New → Blueprint** → pick `MarcBittner/ai-portfolio` → **Apply**.
   (Render reads `render.yaml` and builds `projects/persona-twin/Dockerfile`.)
3. You get a public URL like `https://persona-twin.onrender.com`. Open `/` for the UI.
- Free tier sleeps after ~15 min idle; first hit after sleep cold-starts in ~30-60s. Fine for a demo link.

## Option B — Hugging Face Spaces (best venue for an AI demo; ~5 manual steps)
HF Spaces can't build from a repo subdir, so copy persona-twin into a Docker Space:
1. https://huggingface.co/new-space → **SDK: Docker → Blank** → create (e.g. `MarcBittner/persona-twin`).
2. `git clone https://huggingface.co/spaces/MarcBittner/persona-twin && cd persona-twin`
3. Copy everything from this repo's `projects/persona-twin/` into the Space dir (it includes the Dockerfile).
4. Prepend this YAML front-matter to the Space's `README.md`:
   ```
   ---
   title: Persona Twin
   emoji: 🧠
   sdk: docker
   app_port: 8080
   ---
   ```
5. `git add -A && git commit -m "persona-twin demo" && git push` → live at `https://huggingface.co/spaces/MarcBittner/persona-twin`.

## Notes
- **Never set real OpenAI/Anthropic/Mongo keys on a free public host.** Offline mode is the default — leave the providers off; the demo is fully functional without them.
- Memory: the app fits the 512 MB free tiers (small synthetic corpus, in-memory store).
