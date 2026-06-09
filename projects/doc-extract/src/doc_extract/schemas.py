"""Built-in extraction schemas.

A schema is an ordered list of fields; each field declares a type (which
chooses the value pattern + validator) and label aliases used to anchor the
value in the document. Adding a document type is data, not code.
"""

from dataclasses import dataclass, field

# Supported field types (see extract.py for patterns/validators).
FIELD_TYPES = ("email", "phone", "url", "money", "date", "number", "string")


@dataclass(frozen=True)
class Field:
    name: str
    type: str
    labels: tuple[str, ...] = ()  # label aliases for anchored extraction
    description: str = ""


@dataclass(frozen=True)
class Schema:
    name: str
    description: str
    fields: tuple[Field, ...] = field(default_factory=tuple)


SCHEMAS: dict[str, Schema] = {
    "invoice": Schema(
        "invoice",
        "Vendor invoice — number, dates, total, contact",
        (
            Field("invoice_number", "string",
                  ("invoice number", "invoice no", "invoice #", "invoice"),
                  "Invoice identifier"),
            Field("invoice_date", "date", ("invoice date", "date of issue", "date"),
                  "Date issued"),
            Field("due_date", "date", ("due date", "payment due", "due"),
                  "Payment due date"),
            Field("total", "money",
                  ("total due", "amount due", "balance due", "grand total", "total"),
                  "Total amount due"),
            Field("vendor_email", "email", ("email", "e-mail", "contact"),
                  "Vendor email"),
            Field("vendor_phone", "phone", ("phone", "tel", "telephone"),
                  "Vendor phone"),
        ),
    ),
    "resume": Schema(
        "resume",
        "Candidate resume — contact and headline facts",
        (
            Field("name", "string", ("name",), "Candidate name"),
            Field("email", "email", ("email", "e-mail"), "Email address"),
            Field("phone", "phone", ("phone", "mobile", "tel"), "Phone number"),
            Field("linkedin", "url", ("linkedin",), "LinkedIn profile"),
            Field("github", "url", ("github",), "GitHub profile"),
            Field("years_experience", "number",
                  ("years of experience", "years experience", "experience"),
                  "Years of experience"),
        ),
    ),
    "contact": Schema(
        "contact",
        "Generic contact block — email, phone, site, address",
        (
            Field("email", "email", ("email", "e-mail"), "Email address"),
            Field("phone", "phone", ("phone", "tel", "mobile"), "Phone number"),
            Field("website", "url", ("website", "site", "web"), "Website"),
            Field("address", "string", ("address", "located at", "ship to"),
                  "Street address"),
        ),
    ),
}

SCHEMA_NAMES = list(SCHEMAS)
