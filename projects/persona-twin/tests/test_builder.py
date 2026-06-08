"""Persona builder: redaction preview, runtime create/delete, persistence."""

import httpx
import pytest

from persona_twin.api.app import _load_records, app, build_state
from persona_twin.chunking import get_chunker
from persona_twin.config import Settings
from persona_twin.models import HexacoProfile
from persona_twin.persona.store import (
    PersonaStore,
    StoredDoc,
    StoredPersona,
    slugify,
    valid_persona_id,
)
from persona_twin.pipeline import ingest_corpus

HEX = HexacoProfile(
    honesty_humility=0.5, emotionality=0.5, extraversion=0.5,
    agreeableness=0.5, conscientiousness=0.5, openness=0.5,
)


def _spec(**over):
    base = {
        "name": "Zed Tester",
        "tagline": "Synthetic test twin",
        "bio": "A fictional persona authored for tests.",
        "hexaco": HEX.model_dump(),
        "voice_notes": ["Terse"],
        "documents": [
            {
                "name": "facts",
                "text": "Zed runs marathons and his lucky number is "
                "forty-two. Reach him at zed@example.com or 555-123-4567.",
            }
        ],
    }
    base.update(over)
    return base


# ---- store unit ----

def test_slugify_and_validation():
    assert slugify("Jo Rivera!!") == "jo-rivera"
    assert slugify("   ", fallback="x") == "x"
    assert valid_persona_id("jo-rivera")
    assert not valid_persona_id("Jo Rivera")
    assert not valid_persona_id("../etc")


def test_persona_store_roundtrip(tmp_path):
    store = PersonaStore(tmp_path)
    sp = StoredPersona(
        persona_id="zed-test", name="Zed", tagline="t", bio="b", hexaco=HEX,
        documents=[StoredDoc(name="d", text="hello world")],
    )
    store.save(sp)
    assert store.exists("zed-test")
    loaded = store.load_all()
    assert [p.persona_id for p in loaded] == ["zed-test"]
    rec = loaded[0].to_record()
    assert rec.persona.doc_count == 1
    assert rec.documents[0].doc_id == "zed-test/d"
    assert store.delete("zed-test") and not store.exists("zed-test")


def test_load_records_merges_user_and_baked(tmp_path):
    store = PersonaStore(tmp_path)
    store.save(StoredPersona(
        persona_id="zed-test", name="Zed", tagline="t", bio="b", hexaco=HEX,
        documents=[StoredDoc(name="d", text="hi")],
    ))
    ids = {r.persona.persona_id for r in _load_records(store)}
    assert "zed-test" in ids and "ada-quill" in ids  # user + baked-in


# ---- endpoints ----

@pytest.fixture
async def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PERSONA_TWIN_USER_PERSONAS_DIR", str(tmp_path / "twins"))
    app.state.twin = build_state(Settings(_env_file=None))
    st = app.state.twin
    await ingest_corpus(get_chunker("content_aware"), st.embedder, st.store,
                        records=st.records)
    st.bm25.build(await st.store.all_chunks())
    async with httpx.ASGITransport(app=app) as transport, httpx.AsyncClient(
        transport=transport, base_url="http://test") as c:
        yield c


async def test_redaction_preview_counts_no_value_leak(client):
    r = await client.post("/redaction/preview", json={"documents": [
        {"name": "a", "text": "Email me at jo@example.com or call 555-123-4567."},
    ]})
    assert r.status_code == 200
    body = r.json()
    assert body["total_counts"].get("EMAIL") == 1
    assert body["total_counts"].get("PHONE") == 1
    assert body["total"] == 2
    # tokenized, never the raw values
    assert "[EMAIL_1]" in body["documents"][0]["redacted"]
    assert "jo@example.com" not in str(body)
    assert "555-123-4567" not in str(body)


async def test_create_persona_queryable_with_pii_redacted(client):
    r = await client.post("/personas", json=_spec())
    assert r.status_code == 201
    created = r.json()
    assert created["persona"]["persona_id"] == "zed-tester"  # slug from name
    assert created["chunks"] > 0
    assert created["redactions"].get("EMAIL") == 1
    assert created["redactions"].get("PHONE") == 1

    # shows up in the listing
    ids = {p["persona_id"] for p in (await client.get("/personas")).json()}
    assert "zed-tester" in ids

    # immediately queryable, grounded in its own doc
    ask = await client.post("/ask", json={
        "persona_id": "zed-tester",
        "question": "What is your lucky number?",
        "debug": True,
    })
    body = ask.json()
    assert body["answered"] is True
    assert "forty-two" in body["answer"]
    # PII never reached the store: not in the answer nor the retrieved chunks
    assert "zed@example.com" not in str(body)
    assert "555-123-4567" not in str(body)


async def test_create_duplicate_conflicts(client):
    assert (await client.post("/personas", json=_spec())).status_code == 201
    assert (await client.post("/personas", json=_spec())).status_code == 409
    # explicit clash with a baked-in id
    assert (await client.post("/personas", json=_spec(persona_id="ada-quill"))
            ).status_code == 409


async def test_create_validation_errors(client):
    assert (await client.post("/personas", json=_spec(documents=[]))
            ).status_code == 422
    assert (await client.post("/personas", json=_spec(persona_id="Bad Id"))
            ).status_code == 422
    bad_hex = {**HEX.model_dump(), "openness": 1.5}
    assert (await client.post("/personas", json=_spec(hexaco=bad_hex))
            ).status_code == 422


async def test_delete_user_persona_but_not_baked_in(client):
    await client.post("/personas", json=_spec())
    assert (await client.delete("/personas/zed-tester")).status_code == 200
    # gone from listing and no longer queryable
    ids = {p["persona_id"] for p in (await client.get("/personas")).json()}
    assert "zed-tester" not in ids
    assert (await client.post("/ask", json={
        "persona_id": "zed-tester", "question": "anything?"})).status_code == 404
    # baked-in personas are not deletable
    assert (await client.delete("/personas/ada-quill")).status_code == 404
    # and remaining twins still answer
    ada = await client.post("/ask", json={
        "persona_id": "ada-quill",
        "question": "What tomato variety are you growing this year?"})
    assert ada.json()["answered"] is True
