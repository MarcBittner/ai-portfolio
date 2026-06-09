"""Deterministic, PII-free field generators.

Every generator draws from a seeded ``random.Random`` (reproducible across
processes and platforms) and from fictional pools, and the contact types are
**safe by construction**: emails use RFC 2606 ``example.*`` domains and phones
use the reserved fictional ``555-01xx`` range, so generated data can never
collide with a real person. That's the point — synthetic data you can commit,
share, and test against without governance risk.
"""

import random

FIRST_NAMES = [
    "Ada", "Bo", "Cleo", "Dev", "Esme", "Finn", "Gus", "Hana", "Ivo", "Jo",
    "Kai", "Lux", "Mara", "Nico", "Opal", "Pax", "Quin", "Remy", "Sage", "Tao",
]
LAST_NAMES = [
    "Quill", "Ramirez", "Okafor", "Tanaka", "Vance", "Holt", "Mercer", "Asher",
    "Bloom", "Cruz", "Dane", "Frost", "Greer", "Hale", "Ives", "Kerr",
]
CITIES = [
    "Gullsworth", "Port Maren", "Ashfield", "Riverton", "Calder Bay", "Highmoor",
    "Westwick", "Lumen", "Marrow", "Sable City",
]
COMPANIES = [
    "Acme Works", "Northwind Labs", "Larkspur", "Cobalt Systems", "Tindra",
    "Meridian Co", "Birchwood", "Quanta", "Halcyon", "Verdant",
]
STREETS = [
    "Market", "Willow", "Birch", "Harbor", "Foundry", "Linden", "Sutter",
    "Beacon", "Crescent", "Aldous",
]
WORDS = [
    "the", "quiet", "ledger", "hums", "while", "a", "small", "fox", "maps",
    "harbor", "garden", "after", "dusk", "kettle", "warms", "long", "evening",
    "notes", "lantern", "tide", "orchard", "signal",
]
EMAIL_DOMAINS = ["example.com", "example.org", "example.net"]  # RFC 2606 reserved


def _name(rng: random.Random) -> tuple[str, str]:
    return rng.choice(FIRST_NAMES), rng.choice(LAST_NAMES)


def gen_id(rng, spec, i):  # sequential, stable
    return spec.get("start", 1) + i


def gen_uuid(rng, spec, i):
    hexd = "".join(rng.choice("0123456789abcdef") for _ in range(32))
    return f"{hexd[:8]}-{hexd[8:12]}-{hexd[12:16]}-{hexd[16:20]}-{hexd[20:]}"


def gen_name(rng, spec, i):
    return " ".join(_name(rng))


def gen_first_name(rng, spec, i):
    return rng.choice(FIRST_NAMES)


def gen_email(rng, spec, i):
    first, last = _name(rng)
    tag = rng.randint(1, 999)
    return f"{first}.{last}{tag}@{rng.choice(EMAIL_DOMAINS)}".lower()


def gen_phone(rng, spec, i):
    # reserved fictional range 555-0100..555-0199 (never a real subscriber line)
    return f"({rng.randint(200, 989)}) 555-01{rng.randint(0, 99):02d}"


def gen_integer(rng, spec, i):
    return rng.randint(int(spec.get("min", 0)), int(spec.get("max", 100)))


def gen_float(rng, spec, i):
    lo, hi = float(spec.get("min", 0.0)), float(spec.get("max", 1.0))
    return round(rng.uniform(lo, hi), int(spec.get("decimals", 2)))


def gen_bool(rng, spec, i):
    return rng.random() < float(spec.get("p_true", 0.5))


def gen_choice(rng, spec, i):
    choices = spec.get("choices") or ["a", "b", "c"]
    return rng.choice(choices)


def gen_date(rng, spec, i):
    from datetime import date

    start = date.fromisoformat(spec.get("start", "2025-01-01")).toordinal()
    end = date.fromisoformat(spec.get("end", "2026-12-31")).toordinal()
    if end < start:
        start, end = end, start
    return date.fromordinal(rng.randint(start, end)).isoformat()


def gen_city(rng, spec, i):
    return rng.choice(CITIES)


def gen_company(rng, spec, i):
    return rng.choice(COMPANIES)


def gen_address(rng, spec, i):
    return f"{rng.randint(1, 1999)} {rng.choice(STREETS)} St, {rng.choice(CITIES)}"


def gen_sentence(rng, spec, i):
    n = int(spec.get("words", 8))
    words = [rng.choice(WORDS) for _ in range(max(1, n))]
    return words[0].capitalize() + " " + " ".join(words[1:]) + "."


def gen_llm(rng, spec, i):
    # deterministic placeholder; the API fills this column from the LLM router
    # (per the field's "description") when use_llm is on and a provider is up
    return gen_sentence(rng, spec, i)


TYPES = {
    "id": gen_id, "uuid": gen_uuid, "name": gen_name, "first_name": gen_first_name,
    "email": gen_email, "phone": gen_phone, "integer": gen_integer,
    "float": gen_float, "bool": gen_bool, "choice": gen_choice, "date": gen_date,
    "city": gen_city, "company": gen_company, "address": gen_address,
    "sentence": gen_sentence, "llm": gen_llm,
}
TYPE_NAMES = list(TYPES)
