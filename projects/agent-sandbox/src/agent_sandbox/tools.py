"""Safe, deterministic tools the agent can call.

Every tool is pure, offline, and side-effect-free, and returns a bare string
result (so results can be chained into a later tool's arguments). The
calculator parses an AST and evaluates a whitelist of node types — never
``eval`` — which is the point: tools an agent invokes must be sandboxed.
"""

import ast
import operator
import re
from datetime import datetime

_OPS = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
    ast.Div: operator.truediv, ast.Pow: operator.pow, ast.Mod: operator.mod,
    ast.USub: operator.neg, ast.UAdd: operator.pos,
}


class ToolError(ValueError):
    """Raised when a tool is given input it can't safely handle."""


def calculator(expression: str) -> str:
    """Evaluate an arithmetic expression via a whitelisted AST walk (no eval)."""
    expr = expression.replace("^", "**").strip()

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
    # tidy integers ("6.0" -> "6"); round floats
    return str(int(result)) if float(result).is_integer() else str(round(result, 6))


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
    u = unit.lower().strip()
    return _UNIT_ALIASES.get(u, u)


def convert(value: float, from_unit: str, to_unit: str) -> str:
    """Convert a value between units of the same dimension (length/mass/temp)."""
    value = float(value)
    src, dst = _canon(from_unit), _canon(to_unit)
    if {src, dst} <= {"c", "f", "k"}:
        return f"{round(_convert_temp(value, src, dst), 4)} {dst}"
    for table, _base in _UNITS.values():
        if src in table and dst in table:
            return f"{round(value * table[src] / table[dst], 6)} {dst}"
    raise ToolError(f"cannot convert {from_unit!r} to {to_unit!r}")


def _convert_temp(value: float, src: str, dst: str) -> float:
    celsius = {"c": value, "f": (value - 32) * 5 / 9, "k": value - 273.15}[src]
    return {"c": celsius, "f": celsius * 9 / 5 + 32, "k": celsius + 273.15}[dst]


def date_diff(start: str, end: str) -> str:
    """Whole days between two ISO (YYYY-MM-DD) dates (absolute)."""
    try:
        d1 = datetime.strptime(start.strip(), "%Y-%m-%d")
        d2 = datetime.strptime(end.strip(), "%Y-%m-%d")
    except ValueError as exc:
        raise ToolError(f"dates must be YYYY-MM-DD: {exc}") from exc
    return str(abs((d2 - d1).days))


_KB = {
    "ai-portfolio is a monorepo of independent, production-grade AI engineering "
    "projects.": ("ai", "portfolio", "monorepo", "projects"),
    "persona-twin queries RAG-grounded digital twins of synthetic HEXACO "
    "personas with citations.": ("persona", "twin", "rag", "hexaco", "personas"),
    "pii-redactor detects and redacts PII deterministically with checksum "
    "validation.": ("pii", "redactor", "redact", "privacy"),
    "A ReAct agent interleaves reasoning (thoughts) with actions (tool calls) "
    "and observations.": ("react", "agent", "reasoning", "tools", "thought"),
    "Retrieval-augmented generation grounds a model's answer in retrieved "
    "documents.": ("rag", "retrieval", "grounding", "augmented"),
}
_WORD = re.compile(r"[a-z0-9]+")


def search(query: str) -> str:
    """Keyword search over a small synthetic knowledge base."""
    terms = set(_WORD.findall(query.lower()))
    best, best_score = None, 0
    for fact, keys in _KB.items():
        score = len(terms & set(keys))
        if score > best_score:
            best, best_score = fact, score
    return best if best else "No matching entry in the knowledge base."


# name -> (callable, description)
TOOLS = {
    "calculator": (calculator, "Evaluate an arithmetic expression (safe AST eval)"),
    "convert": (convert, "Convert between units of length, mass, or temperature"),
    "date_diff": (date_diff, "Whole days between two YYYY-MM-DD dates"),
    "search": (search, "Keyword search over a small knowledge base"),
}
TOOL_NAMES = list(TOOLS)
