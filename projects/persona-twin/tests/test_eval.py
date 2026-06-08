"""Eval harness: dataset integrity, metric primitives, offline smoke run."""

from persona_twin.corpus import load_personas
from persona_twin.embedding import HashEmbedder
from persona_twin.eval.dataset import load_eval_dataset
from persona_twin.eval.judge import judge_voice
from persona_twin.eval.metrics import (
    contains_reference,
    lexical_support,
    token_f1,
    voice_heuristic,
    voice_violations,
)
from persona_twin.eval.run import evaluate_retrieval
from persona_twin.llm import MockProvider
from persona_twin.llm.registry import ModelRegistry
from persona_twin.llm.router import LLMRouter


class TestDataset:
    def test_loads_and_references_real_corpus(self):
        items = load_eval_dataset()
        assert len(items) >= 25
        records = {r.persona.persona_id: r for r in load_personas()}
        for item in items:
            assert item.persona_id in records, item.id
            doc_ids = {d.doc_id for d in records[item.persona_id].documents}
            for src in item.source_docs:
                assert src in doc_ids, f"{item.id} cites unknown doc {src}"

    def test_includes_unanswerables(self):
        items = load_eval_dataset()
        assert sum(1 for i in items if not i.answerable) >= 3


class TestMetrics:
    def test_token_f1_identity_and_disjoint(self):
        assert token_f1("Black Krim", "Black Krim") == 1.0
        assert token_f1("entirely different words", "Black Krim") == 0.0

    def test_token_f1_partial(self):
        score = token_f1("the variety is Black Krim this year", "Black Krim")
        assert 0.0 < score < 1.0

    def test_contains_reference_normalizes(self):
        assert contains_reference("It's 3,200 square feet of space.", "3,200 square feet")
        assert not contains_reference("about 18,000 copies", "Black Krim")

    def test_lexical_support(self):
        assert lexical_support("tomato seedlings", ["I repotted tomato seedlings"]) == 1.0
        assert lexical_support("quantum finance", ["I repotted tomato seedlings"]) == 0.0

    def test_voice_violations(self):
        assert voice_violations("As an AI, I cannot answer.") != []
        assert "no first-person voice" in voice_violations(
            "The ferry crossing takes about twenty-two minutes in fair weather conditions."
        )
        assert voice_violations("I grow Black Krim tomatoes on my balcony.") == []


class TestRetrievalEval:
    async def test_rerank_does_not_hurt(self):
        items = load_eval_dataset()
        records = load_personas()
        embedder = HashEmbedder()
        plain = await evaluate_retrieval(items, embedder, records, "content_aware", False)
        reranked = await evaluate_retrieval(
            items, embedder, records, "content_aware", True
        )
        assert plain.n == reranked.n >= 25
        assert reranked.mrr >= plain.mrr
        assert reranked.hit_rate >= 0.8  # offline floor; report shows actuals


class TestVoiceJudge:
    def test_voice_heuristic_rewards_in_character_prose(self):
        # clean first-person, no assistant-isms → full marks
        assert voice_heuristic("I grow Black Krim tomatoes on my balcony.") == 1.0
        # assistant-ism + no first person → penalized
        low = voice_heuristic("As an AI language model, the tomato is a fruit.")
        assert low < 1.0

    async def test_judge_voice_offline_uses_heuristic(self):
        persona = load_personas()[0].persona
        router = LLMRouter(ModelRegistry([]), {"mock": MockProvider()})
        score, method = await judge_voice(
            "I write longhand every morning in my notebooks.", persona, router
        )
        assert method == "heuristic"
        assert 0.0 <= score <= 1.0
