"""Chunking: provenance integrity, boundary behavior, structure preservation."""

import re

import pytest

from persona_twin.chunking import (
    ContentAwareChunker,
    FixedChunker,
    SemanticChunker,
    get_chunker,
)

PROSE = (
    "The market research session ran long today. We covered three new product "
    "concepts and everyone had opinions. I liked the second concept best because "
    "it solved a real problem. The third one felt derivative. "
    "Afterwards we compared notes over coffee and agreed the pricing felt wrong. "
    "Nobody wants to pay a subscription for a bottle opener. "
) * 8

MARKDOWN = """# Weekly journal

## Monday

Started the week with a long run. Felt great afterwards and had ideas
about the garden project.

Shopping list for the garden:
- tomato seedlings
- compost (two bags)
- bamboo stakes
- twine

## Q&A with myself

Q: Why do I keep buying gadgets I never use?
A: Because the reviews are persuasive and I am an optimist about my
future habits. The juicer is exhibit A.

Q: Will the garden be different?
A: Yes, because dirt has no subscription fee.

## Friday

Wrapped up the week by repotting everything. The balcony looks like a
tiny jungle now and I could not be happier about it.
"""


@pytest.fixture(params=["fixed", "semantic", "content_aware"])
def chunker(request):
    return get_chunker(request.param)


class TestAllStrategies:
    def test_chunks_are_exact_substrings(self, chunker):
        for text in (PROSE, MARKDOWN):
            for c in chunker.chunk(text, doc_id="d1", persona_id="p1"):
                start, end = c.char_span
                assert text[start:end] == c.text

    def test_provenance_fields(self, chunker):
        chunks = chunker.chunk(PROSE, doc_id="doc-7", persona_id="ada")
        assert chunks
        for i, c in enumerate(chunks):
            assert c.doc_id == "doc-7"
            assert c.persona_id == "ada"
            assert c.strategy == chunker.strategy
            assert c.chunk_id == f"doc-7:{chunker.strategy}:{i:04d}"

    def test_empty_and_whitespace_input(self, chunker):
        assert chunker.chunk("", doc_id="d", persona_id="p") == []
        assert chunker.chunk("   \n\n  ", doc_id="d", persona_id="p") == []

    def test_full_coverage_of_meaningful_text(self, chunker):
        """Every non-whitespace character lands in at least one chunk."""
        chunks = chunker.chunk(MARKDOWN, doc_id="d", persona_id="p")
        covered = set()
        for c in chunks:
            covered.update(range(*c.char_span))
        missing = [i for i, ch in enumerate(MARKDOWN) if not ch.isspace() and i not in covered]
        assert missing == []


class TestFixed:
    def test_window_and_overlap(self):
        chunks = FixedChunker(size=100, overlap=20).chunk(PROSE, doc_id="d", persona_id="p")
        assert all(len(c.text) <= 100 for c in chunks)
        for a, b in zip(chunks, chunks[1:], strict=False):
            assert b.char_span[0] == a.char_span[0] + 80  # step = size - overlap
        assert chunks[-1].char_span[1] == len(PROSE)

    def test_short_text_single_chunk(self):
        chunks = FixedChunker(size=100, overlap=20).chunk(
            "hello world", doc_id="d", persona_id="p"
        )
        assert len(chunks) == 1
        assert chunks[0].text == "hello world"

    def test_overlap_must_be_smaller_than_size(self):
        with pytest.raises(ValueError):
            FixedChunker(size=100, overlap=100)


class TestSemantic:
    def test_never_splits_mid_sentence(self):
        chunks = SemanticChunker(target_size=200).chunk(PROSE, doc_id="d", persona_id="p")
        assert len(chunks) > 1
        for c in chunks:
            assert re.search(r"[.!?][\"')\]]*$", c.text.rstrip()), c.text[-50:]

    def test_respects_target_size_for_normal_sentences(self):
        chunks = SemanticChunker(target_size=200, max_size=1600).chunk(
            PROSE, doc_id="d", persona_id="p"
        )
        assert all(len(c.text) <= 200 for c in chunks)

    def test_oversized_sentence_hard_splits(self):
        monster = "word " * 500  # no sentence punctuation, ~2500 chars
        chunks = SemanticChunker(target_size=200, max_size=400).chunk(
            monster, doc_id="d", persona_id="p"
        )
        assert all(len(c.text) <= 400 for c in chunks)
        assert len(chunks) > 1


class TestContentAware:
    def chunks(self, **kwargs):
        return ContentAwareChunker(**kwargs).chunk(MARKDOWN, doc_id="d", persona_id="p")

    def test_heading_stays_with_following_content(self):
        for c in self.chunks(target_size=300):
            lines = [ln for ln in c.text.splitlines() if ln.strip()]
            if lines and lines[-1].startswith("#"):
                # a chunk may not END with a heading (heading orphaned from body)
                raise AssertionError(f"orphaned heading in chunk: {c.text!r}")

    def test_list_run_is_atomic(self):
        items = ["- tomato seedlings", "- compost (two bags)", "- bamboo stakes", "- twine"]
        containing = [c for c in self.chunks(target_size=300) if "tomato seedlings" in c.text]
        assert len(containing) == 1
        for item in items:
            assert item in containing[0].text

    def test_qa_pair_kept_together(self):
        for c in self.chunks(target_size=300):
            if "Why do I keep buying gadgets" in c.text:
                assert "exhibit A" in c.text
                return
        raise AssertionError("question not found in any chunk")

    def test_oversized_block_falls_back_to_sentences(self):
        big_paragraph = PROSE  # single-paragraph prose, far over max
        chunks = ContentAwareChunker(target_size=200, max_size=400).chunk(
            big_paragraph, doc_id="d", persona_id="p"
        )
        assert all(len(c.text) <= 400 for c in chunks)
