# MongoDB Atlas Vector Search setup (optional)

persona-twin runs offline by default (in-memory vector store). To use
Atlas Vector Search instead:

1. **Create a free M0 cluster** at <https://www.mongodb.com/atlas>
   - Database Access → create a database user
   - Network Access → allow your IP
2. **Set the environment** in `.env`:
   ```
   MONGODB_URI=mongodb+srv://USER:PASSWORD@yourcluster.example.mongodb.net
   MONGODB_DB=persona_twin
   MONGODB_VECTOR_INDEX=persona_chunks_index
   ```
3. **Install the extra**: `.venv/bin/pip install -e ".[mongo]"`
4. **Ingest once** (`make demo` or `POST /ingest`) so the `chunks`
   collection exists.
5. **Create the vector index**: Atlas UI → your `persona_twin.chunks`
   collection → *Atlas Search → Create Search Index → Vector Search
   (JSON editor)* → name it `persona_chunks_index` and paste
   [`deploy/atlas-vector-index.json`](../deploy/atlas-vector-index.json).

## numDimensions must match the active embedder

| Embedder | Active when | Dimensions |
|---|---|---|
| OpenAI `text-embedding-3-small` | `OPENAI_API_KEY` set | **1536** (committed default) |
| Ollama `nomic-embed-text` | `OLLAMA_BASE_URL` set, no OpenAI key | **768** |
| Hash embedder (offline) | neither configured | **256** |

The committed index JSON assumes the OpenAI embedder. If you run Atlas
with the hash embedder, change `numDimensions` to 256. The store
validates vector dimensionality on every upsert and fails loudly on
mismatch rather than ingesting unsearchable data.

Note the `persona_id` **filter field** in the index definition — it is
required for per-persona retrieval (`$vectorSearch.filter`); without it
filtered queries return errors.
