"""OCR token model, sample documents, and a pluggable OCR backend.

The pipeline operates on **OCR tokens** (a word plus its bounding box), which
is exactly what an OCR engine emits. The offline default builds tokens from
bundled sample documents via a fixed monospace layout — so the whole
detect→redact-by-box pipeline is real and deterministic without any model. A
real backend (Tesseract) is opt-in via ``ocr_image`` and only used if
``pytesseract`` + the tesseract binary are installed.
"""

from dataclasses import dataclass

CHAR_W = 9
LINE_H = 28
TOKEN_H = 20


@dataclass
class OcrToken:
    text: str
    x: int
    y: int
    w: int
    h: int


def layout(lines: list[str]) -> list[OcrToken]:
    """Synthesize tokens (word + box) from text lines, monospace-style.
    This is what an OCR pass would return for the rendered document."""
    tokens: list[OcrToken] = []
    for row, line in enumerate(lines):
        col = 0
        y = row * LINE_H
        for word in line.split(" "):
            if not word:
                col += 1
                continue
            tokens.append(OcrToken(word, col * CHAR_W, y, len(word) * CHAR_W, TOKEN_H))
            col += len(word) + 1
    return tokens


# Bundled sample documents (synthetic; contain fictional PII to redact).
SAMPLES: dict[str, list[str]] = {
    "receipt": [
        "ACME STORE  —  Receipt #1042",
        "Customer: jane.doe@example.com",
        "Phone: (415) 555-0148",
        "Card: 4111 1111 1111 1111",
        "Total: $42.00   Thank you!",
    ],
    "intake_form": [
        "PATIENT INTAKE FORM",
        "Name: Jordan Rivera",
        "Email: jordan@example.org   SSN: 123-45-6789",
        "Contact phone 212-555-0170",
        "Notes: follow up in two weeks",
    ],
}
SAMPLE_NAMES = list(SAMPLES)


def sample_tokens(name: str) -> list[OcrToken]:
    if name not in SAMPLES:
        raise KeyError(name)
    return layout(SAMPLES[name])


class OcrUnavailable(RuntimeError):
    """Raised when a real OCR backend is requested but not installed."""


def ocr_image(image_bytes: bytes) -> list[OcrToken]:
    """Opt-in real OCR via Tesseract (pytesseract). Raises OcrUnavailable if
    the dependency/binary isn't present — the offline path uses samples."""
    try:
        import io

        import pytesseract  # type: ignore
        from PIL import Image  # type: ignore
    except ImportError as exc:  # pragma: no cover - opt-in path
        raise OcrUnavailable(
            "real OCR needs the 'ocr' extra (pytesseract + Pillow) and the "
            "tesseract binary; use a bundled sample or supply tokens instead"
        ) from exc
    data = pytesseract.image_to_data(  # pragma: no cover - requires binary
        Image.open(io.BytesIO(image_bytes)), output_type=pytesseract.Output.DICT
    )
    tokens: list[OcrToken] = []
    for i, text in enumerate(data["text"]):
        if text.strip():
            tokens.append(OcrToken(text, data["left"][i], data["top"][i],
                                   data["width"][i], data["height"][i]))
    return tokens
