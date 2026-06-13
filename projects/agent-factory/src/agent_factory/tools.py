"""Safe, deterministic tools an agent can call.

Every tool is pure, offline, and side-effect-free, and returns a bare string
(so one tool's result can be substituted into a later tool's arguments). The
calculator parses an AST and evaluates a whitelist of node types — never
``eval`` — because a tool an agent invokes must be sandboxed. Each tool carries
a typed parameter spec so the planner (and the UI) know how to call it.
"""

import ast
import json
import operator
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime


class ToolError(ValueError):
    """Raised when a tool is given input it can't safely handle."""


@dataclass(frozen=True)
class Param:
    name: str
    type: str  # "string" | "number"
    description: str
    required: bool = True


@dataclass(frozen=True)
class Tool:
    name: str
    fn: Callable[..., str]
    description: str
    params: tuple[Param, ...]

    def signature(self) -> str:
        inner = ", ".join(
            p.name if p.required else f"{p.name}?" for p in self.params
        )
        return f"{self.name}({inner})"


# ---- arithmetic ----------------------------------------------------------

_OPS = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
    ast.Div: operator.truediv, ast.Pow: operator.pow, ast.Mod: operator.mod,
    ast.USub: operator.neg, ast.UAdd: operator.pos,
}


def calculator(expression: str) -> str:
    """Evaluate an arithmetic expression via a whitelisted AST walk (no eval)."""
    expr = str(expression).replace("^", "**").strip()

    def _eval(node: ast.AST) -> float:
        if isinstance(node, ast.Expression):
            return _eval(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return node.value
        if isinstance(node, ast.BinOp) and type(node.op) in _OPS:
            return _OPS[type(node.op)](_eval(node.left), _eval(node.right))
        if isinstance(node, ast.UnaryOp) and type(node.op) in _OPS:
            return _OPS[type(node.op)](_eval(node.operand))
        raise ToolError(f"unsupported expression: {expression!r}")

    try:
        result = _eval(ast.parse(expr, mode="eval"))
    except (SyntaxError, TypeError, ZeroDivisionError, ValueError) as exc:
        raise ToolError(f"cannot evaluate {expression!r}: {exc}") from exc
    return str(int(result)) if float(result).is_integer() else str(round(result, 6))


# ---- unit conversion -----------------------------------------------------

_UNITS = {
    "length": ({"m": 1.0, "km": 1000.0, "cm": 0.01, "mm": 0.001, "mi": 1609.344,
                "ft": 0.3048, "in": 0.0254, "yd": 0.9144}, "m"),
    "mass": ({"kg": 1.0, "g": 0.001, "lb": 0.453592, "oz": 0.0283495}, "kg"),
}
_UNIT_ALIASES = {
    "meter": "m", "meters": "m", "metre": "m", "kilometer": "km",
    "kilometers": "km", "kilometre": "km", "mile": "mi", "miles": "mi",
    "foot": "ft", "feet": "ft", "inch": "in", "inches": "in", "yard": "yd",
    "yards": "yd", "centimeter": "cm", "centimeters": "cm", "millimeter": "mm",
    "millimeters": "mm", "kilogram": "kg", "kilograms": "kg", "gram": "g",
    "grams": "g", "pound": "lb", "pounds": "lb", "ounce": "oz", "ounces": "oz",
    "celsius": "c", "fahrenheit": "f", "kelvin": "k",
}


def _canon(unit: str) -> str:
    return _UNIT_ALIASES.get(str(unit).lower().strip(), str(unit).lower().strip())


def _convert_temp(value: float, src: str, dst: str) -> float:
    celsius = {"c": value, "f": (value - 32) * 5 / 9, "k": value - 273.15}[src]
    return {"c": celsius, "f": celsius * 9 / 5 + 32, "k": celsius + 273.15}[dst]


def convert(value: float, from_unit: str, to_unit: str) -> str:
    """Convert a value between units of the same dimension (length/mass/temp)."""
    try:
        value = float(value)
    except (TypeError, ValueError) as exc:
        raise ToolError(f"value must be a number: {value!r}") from exc
    src, dst = _canon(from_unit), _canon(to_unit)
    if {src, dst} <= {"c", "f", "k"}:
        return f"{round(_convert_temp(value, src, dst), 4)} {dst}"
    for table, _base in _UNITS.values():
        if src in table and dst in table:
            return f"{round(value * table[src] / table[dst], 6)} {dst}"
    raise ToolError(f"cannot convert {from_unit!r} to {to_unit!r}")


def date_diff(start: str, end: str) -> str:
    """Whole days between two ISO (YYYY-MM-DD) dates (absolute)."""
    try:
        d1 = datetime.strptime(str(start).strip(), "%Y-%m-%d")
        d2 = datetime.strptime(str(end).strip(), "%Y-%m-%d")
    except ValueError as exc:
        raise ToolError(f"dates must be YYYY-MM-DD: {exc}") from exc
    return str(abs((d2 - d1).days))


# ---- text + data ---------------------------------------------------------

_WORD = re.compile(r"[a-z0-9]+")
_SENT = re.compile(r"[.!?]+")


def text_stats(text: str) -> str:
    """Word / sentence / character counts for a block of text."""
    s = str(text)
    words = len(_WORD.findall(s.lower()))
    sentences = len([x for x in _SENT.split(s) if x.strip()])
    return f"words={words} sentences={sentences} chars={len(s)}"


def regex_extract(pattern: str, text: str) -> str:
    """Return all non-overlapping matches of ``pattern`` in ``text`` (comma-sep)."""
    try:
        matches = re.findall(str(pattern), str(text))
    except re.error as exc:
        raise ToolError(f"invalid regex {pattern!r}: {exc}") from exc
    flat = [m if isinstance(m, str) else "/".join(m) for m in matches]
    return ", ".join(flat) if flat else "(no matches)"


def json_get(data: str, path: str) -> str:
    """Read a dotted ``path`` (e.g. ``a.b.0``) out of a JSON document string."""
    try:
        cur = json.loads(data) if isinstance(data, str) else data
    except (ValueError, TypeError) as exc:
        raise ToolError(f"not valid JSON: {exc}") from exc
    for part in str(path).split("."):
        if not part:
            continue
        try:
            cur = cur[int(part)] if isinstance(cur, list) else cur[part]
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            raise ToolError(f"path {path!r} not found at {part!r}: {exc}") from exc
    return cur if isinstance(cur, str) else json.dumps(cur)


# ---- knowledge base + document store (synthetic, offline) ----------------

_KB = {
    "ai-portfolio is a monorepo of independent, production-grade AI engineering "
    "projects, each runnable offline.": ("ai", "portfolio", "monorepo", "projects"),
    "An agent factory turns a declarative spec — prompt, tools, planner, model, "
    "guardrails — into a running agent.": ("agent", "factory", "spec", "build"),
    "A ReAct agent interleaves reasoning (thoughts) with actions (tool calls) and "
    "observations until it can answer.": ("react", "reasoning", "tools", "thought",
                                          "loop"),
    "Retrieval-augmented generation grounds a model's answer in retrieved "
    "documents to reduce hallucination.": ("rag", "retrieval", "grounding",
                                           "augmented", "hallucination"),
    "Guardrails scan an agent's input for injection and its output for secret or "
    "PII leakage before returning.": ("guardrail", "guardrails", "safety",
                                      "injection", "pii"),
    "Model routing sends a request to a free, paid, or local provider by policy, "
    "with fallback when one is unavailable.": ("routing", "router", "provider",
                                               "free", "fallback", "model"),
}

_DOCS = {
    "onboarding": "New agents start from a template, then you tune the spec: "
                  "system prompt, enabled tools, planner, model mode, step budget.",
    "pricing": "Free models cost nothing and are rate-limited; paid models need "
               "your own key; offline uses a deterministic mock — no network.",
    "limits": "A run is capped by max_steps; each step is one tool call. Tools "
              "outside the agent's allowlist are refused.",
}


def kb_search(query: str) -> str:
    """Keyword search over a small synthetic knowledge base."""
    terms = set(_WORD.findall(str(query).lower()))
    best, best_score = None, 0
    for fact, keys in _KB.items():
        score = len(terms & set(keys))
        if score > best_score:
            best, best_score = fact, score
    return best if best else "No matching entry in the knowledge base."


def doc_fetch(doc_id: str) -> str:
    """Fetch a document by id from the offline document store (no network)."""
    key = str(doc_id).strip().lower()
    if key in _DOCS:
        return _DOCS[key]
    raise ToolError(f"unknown document {doc_id!r}; have: {', '.join(_DOCS)}")


# ---- registry ------------------------------------------------------------

_ALL = [
    Tool("calculator", calculator,
         "Evaluate an arithmetic expression (safe AST eval).",
         (Param("expression", "string", "e.g. '3 * (4 + 5)'"),)),
    Tool("convert", convert,
         "Convert a value between units of length, mass, or temperature.",
         (Param("value", "number", "the quantity to convert"),
          Param("from_unit", "string", "source unit, e.g. 'mi'"),
          Param("to_unit", "string", "target unit, e.g. 'km'"))),
    Tool("date_diff", date_diff,
         "Whole days between two YYYY-MM-DD dates.",
         (Param("start", "string", "start date YYYY-MM-DD"),
          Param("end", "string", "end date YYYY-MM-DD"))),
    Tool("text_stats", text_stats,
         "Count words, sentences, and characters in text.",
         (Param("text", "string", "the text to measure"),)),
    Tool("regex_extract", regex_extract,
         "Extract all regex matches from a block of text.",
         (Param("pattern", "string", "a Python regular expression"),
          Param("text", "string", "the text to search"))),
    Tool("json_get", json_get,
         "Read a dotted path out of a JSON document.",
         (Param("data", "string", "a JSON document"),
          Param("path", "string", "dotted path, e.g. 'items.0.name'"))),
    Tool("kb_search", kb_search,
         "Keyword search over a small synthetic knowledge base.",
         (Param("query", "string", "what to look up"),)),
    Tool("doc_fetch", doc_fetch,
         "Fetch a document by id (onboarding, pricing, limits).",
         (Param("doc_id", "string", "document id"),)),
]

TOOLS: dict[str, Tool] = {t.name: t for t in _ALL}
TOOL_NAMES = list(TOOLS)


def tool_catalog(names: list[str] | None = None) -> list[dict]:
    """JSON-able catalog (for the API/UI and the planner prompt)."""
    chosen = names or TOOL_NAMES
    return [
        {"name": t.name, "description": t.description, "signature": t.signature(),
         "params": [vars(p) for p in t.params]}
        for n in chosen if (t := TOOLS.get(n))
    ]
