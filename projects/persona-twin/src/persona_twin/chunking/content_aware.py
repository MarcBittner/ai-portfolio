"""Content-aware chunking: respect document structure.

Parses lightweight markdown structure into blocks — headings, list
runs, Q&A pairs, paragraphs — then groups blocks into chunks:

- a heading always travels with the content that follows it
- a list run (consecutive items) is atomic
- a Q/A pair is atomic
- oversized atomic blocks fall back to sentence packing
"""

import re
from dataclasses import dataclass
from typing import Literal

from persona_twin.chunking.base import build_chunks, sentence_spans
from persona_twin.models import Chunk

BlockKind = Literal["heading", "list", "qa", "paragraph"]

_HEADING = re.compile(r"^#{1,6}\s+\S")
_LIST_ITEM = re.compile(r"^\s*([-*+]|\d+[.)])\s+\S")
_QUESTION = re.compile(r"^(Q[:.]|\*\*Q)", re.IGNORECASE)
_ANSWER = re.compile(r"^(A[:.]|\*\*A)", re.IGNORECASE)


@dataclass
class _Block:
    kind: BlockKind
    start: int
    end: int

    @property
    def size(self) -> int:
        return self.end - self.start


class ContentAwareChunker:
    strategy = "content_aware"

    def __init__(self, target_size: int = 800, max_size: int = 1600) -> None:
        if target_size > max_size:
            raise ValueError("target_size must be <= max_size")
        self.target_size = target_size
        self.max_size = max_size

    def chunk(self, text: str, *, doc_id: str, persona_id: str) -> list[Chunk]:
        blocks = _parse_blocks(text)
        spans = self._group(blocks, text)
        return build_chunks(
            spans, text, strategy=self.strategy, doc_id=doc_id, persona_id=persona_id
        )

    def _group(self, blocks: list[_Block], text: str) -> list[tuple[int, int]]:
        spans: list[tuple[int, int]] = []
        current: tuple[int, int] | None = None
        pending_heading: _Block | None = None

        def flush() -> None:
            nonlocal current
            if current is not None:
                spans.append(current)
                current = None

        for block in blocks:
            if block.kind == "heading":
                # A heading starts a new chunk and must keep its content.
                # Consecutive headings merge and travel together.
                flush()
                if pending_heading is not None:
                    block = _Block("heading", pending_heading.start, block.end)
                pending_heading = block
                continue

            start = pending_heading.start if pending_heading else block.start
            pending_heading = None

            if block.size > self.max_size:
                # Oversized atomic block: flush and sentence-pack it.
                flush()
                spans.extend(self._sentence_pack(text, start, block.end))
                continue

            if current is None:
                current = (start, block.end)
            elif block.end - current[0] <= self.target_size:
                current = (current[0], block.end)
            else:
                flush()
                current = (start, block.end)
        flush()
        if pending_heading is not None:  # trailing heading with no content
            spans.append((pending_heading.start, pending_heading.end))
        return spans

    def _sentence_pack(self, text: str, start: int, end: int) -> list[tuple[int, int]]:
        from persona_twin.chunking.semantic import SemanticChunker

        packer = SemanticChunker(target_size=self.target_size, max_size=self.max_size)
        return packer._pack(sentence_spans(text[start:end], offset=start))


def _parse_blocks(text: str) -> list[_Block]:
    """Split into structural blocks with character offsets."""
    # Line offsets
    lines: list[tuple[int, int, str]] = []  # (start, end, content)
    pos = 0
    for raw in text.splitlines(keepends=True):
        content = raw.rstrip("\n")
        lines.append((pos, pos + len(content), content))
        pos += len(raw)

    blocks: list[_Block] = []
    i = 0
    while i < len(lines):
        start, end, content = lines[i]
        if not content.strip():
            i += 1
            continue
        if _HEADING.match(content):
            blocks.append(_Block("heading", start, end))
            i += 1
        elif _LIST_ITEM.match(content):
            # Consume the whole list run (items + indented continuations).
            j = i
            last_end = end
            while j < len(lines):
                _, l_end, l_content = lines[j]
                if not l_content.strip():
                    # blank line ends the run unless the next line is another item
                    if j + 1 < len(lines) and _LIST_ITEM.match(lines[j + 1][2]):
                        j += 1
                        continue
                    break
                if _LIST_ITEM.match(l_content) or l_content.startswith(("  ", "\t")):
                    last_end = l_end
                    j += 1
                else:
                    break
            blocks.append(_Block("list", start, last_end))
            i = j
        elif _QUESTION.match(content.strip()):
            # Q line plus everything through the end of the A paragraph.
            j = i + 1
            last_end = end
            seen_answer = False
            while j < len(lines):
                _, l_end, l_content = lines[j]
                if not l_content.strip():
                    if seen_answer:
                        break
                    j += 1
                    continue
                if _QUESTION.match(l_content.strip()) and seen_answer:
                    break
                if _ANSWER.match(l_content.strip()):
                    seen_answer = True
                last_end = l_end
                j += 1
            blocks.append(_Block("qa", start, last_end))
            i = j
        else:
            # Paragraph: lines until blank or structural line.
            j = i
            last_end = end
            while j < len(lines):
                _, l_end, l_content = lines[j]
                if not l_content.strip():
                    break
                if j > i and (
                    _HEADING.match(l_content)
                    or _LIST_ITEM.match(l_content)
                    or _QUESTION.match(l_content.strip())
                ):
                    break
                last_end = l_end
                j += 1
            blocks.append(_Block("paragraph", start, last_end))
            i = j
    return blocks
