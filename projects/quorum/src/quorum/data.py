"""Synthetic, clearly-fictional contracts with KNOWN planted risky clauses.

Nothing here is a real agreement: parties, terms, and amounts are invented for
this portfolio. Each contract carries a ``gold`` label set naming which **risk
classes** its clauses trigger, so the contract-review eval has ground truth to
score precision / recall against.

Risk classes the headline workflow scores (one parallel risk-scorer per class):

  auto_renewal        — evergreen / auto-renewing term with a short opt-out window
  unlimited_liability — uncapped or unlimited liability / indemnification
  ip_assignment       — broad assignment of IP / work product to the counterparty
  data_sharing        — broad rights to share, sublicense, or sell data
  unilateral_term     — counterparty may terminate or change terms unilaterally

Some clauses are deliberately benign (mutual NDA, standard governing law, a
liability CAP) so the scorers must discriminate, not just flag everything. A few
clauses embed synthetic PII (an email, a phone, an account number) to exercise
the orchestrator's redaction-before-model + redaction-before-audit guarantee.
"""

from __future__ import annotations

RISK_CLASSES = (
    "auto_renewal",
    "unlimited_liability",
    "ip_assignment",
    "data_sharing",
    "unilateral_term",
)

RISK_LABELS = {
    "auto_renewal": "Auto-renewal / evergreen term",
    "unlimited_liability": "Unlimited / uncapped liability",
    "ip_assignment": "Broad IP assignment",
    "data_sharing": "Broad data-sharing / resale rights",
    "unilateral_term": "Unilateral termination / change of terms",
}


# Each contract: id, title, a list of {clause_id, text, risks=[...]} where
# ``risks`` is the gold label set (empty list == benign).
_CONTRACTS: list[dict] = [
    {
        "id": "msa-001",
        "title": "Master Services Agreement — Northwind Analytics (FICTIONAL)",
        "clauses": [
            {
                "clause_id": "1",
                "text": (
                    "This Agreement commences on the Effective Date and shall "
                    "automatically renew for successive twelve (12) month terms "
                    "unless either party gives written notice of non-renewal no "
                    "later than ninety (90) days before the end of the then-current "
                    "term."
                ),
                "risks": ["auto_renewal"],
            },
            {
                "clause_id": "2",
                "text": (
                    "Supplier's aggregate liability under this Agreement shall be "
                    "unlimited and Supplier shall indemnify Customer against any and "
                    "all losses without cap or limitation of any kind."
                ),
                "risks": ["unlimited_liability"],
            },
            {
                "clause_id": "3",
                "text": (
                    "All work product, inventions, and intellectual property "
                    "conceived by Supplier in connection with this engagement shall "
                    "be irrevocably assigned to Customer upon creation, including "
                    "pre-existing materials incorporated therein."
                ),
                "risks": ["ip_assignment"],
            },
            {
                "clause_id": "4",
                "text": (
                    "Either party may disclose Confidential Information only to "
                    "employees with a need to know, who are bound by "
                    "confidentiality obligations no less protective than those "
                    "herein. Questions to legal@northwind-fictional.example or "
                    "+1 (415) 555-0142."
                ),
                "risks": [],
            },
            {
                "clause_id": "5",
                "text": (
                    "This Agreement shall be governed by the laws of the State of "
                    "Delaware, without regard to its conflict-of-laws principles."
                ),
                "risks": [],
            },
        ],
    },
    {
        "id": "saas-002",
        "title": "SaaS Subscription Terms — Helios Data Cloud (FICTIONAL)",
        "clauses": [
            {
                "clause_id": "1",
                "text": (
                    "Provider may share, sublicense, or sell Customer Data and any "
                    "derived datasets to third parties and affiliates for any "
                    "commercial purpose, including model training, at its sole "
                    "discretion."
                ),
                "risks": ["data_sharing", "unilateral_term"],
            },
            {
                "clause_id": "2",
                "text": (
                    "Provider reserves the right to modify these Terms, pricing, or "
                    "service levels at any time and in its sole discretion, with "
                    "changes effective immediately upon posting and without notice "
                    "to Customer."
                ),
                "risks": ["unilateral_term"],
            },
            {
                "clause_id": "3",
                "text": (
                    "The Subscription Term auto-renews for successive annual periods "
                    "unless cancelled at least thirty (30) days prior to renewal; "
                    "billing account #4929114450021188 is charged automatically."
                ),
                "risks": ["auto_renewal"],
            },
            {
                "clause_id": "4",
                "text": (
                    "Provider's total liability for any claim shall not exceed the "
                    "fees paid by Customer in the twelve (12) months preceding the "
                    "claim. This cap is the parties' agreed allocation of risk."
                ),
                "risks": [],
            },
            {
                "clause_id": "5",
                "text": (
                    "Each party retains all right, title, and interest in its own "
                    "pre-existing intellectual property; no assignment of IP is "
                    "made under these Terms."
                ),
                "risks": [],
            },
        ],
    },
    {
        "id": "dpa-003",
        "title": "Data Processing Addendum — Aurora Health Partners (FICTIONAL)",
        "clauses": [
            {
                "clause_id": "1",
                "text": (
                    "Processor may transfer and sell de-identified and identifiable "
                    "personal data to any sub-processor, partner, or data broker "
                    "worldwide without further consent from the Controller."
                ),
                "risks": ["data_sharing"],
            },
            {
                "clause_id": "2",
                "text": (
                    "Processor accepts unlimited liability for any data breach and "
                    "shall indemnify Controller without cap for all regulatory fines "
                    "and third-party claims arising therefrom."
                ),
                "risks": ["unlimited_liability"],
            },
            {
                "clause_id": "3",
                "text": (
                    "Controller may terminate this Addendum for convenience on "
                    "thirty (30) days' written notice; Processor shall return or "
                    "delete all personal data within fifteen (15) days thereafter."
                ),
                "risks": [],
            },
            {
                "clause_id": "4",
                "text": (
                    "Processor may unilaterally appoint or replace sub-processors "
                    "and amend the data-handling exhibits at any time without "
                    "Controller approval or notice."
                ),
                "risks": ["unilateral_term"],
            },
            {
                "clause_id": "5",
                "text": (
                    "The data-protection officer for the Controller is reachable at "
                    "dpo@aurora-fictional.example or 415-555-0199 for any inquiries "
                    "under this Addendum."
                ),
                "risks": [],
            },
        ],
    },
]


def contracts() -> list[dict]:
    """Return a deep-ish copy of the synthetic contracts."""
    return [
        {
            "id": c["id"],
            "title": c["title"],
            "clauses": [dict(cl, risks=list(cl["risks"])) for cl in c["clauses"]],
        }
        for c in _CONTRACTS
    ]


def get_contract(contract_id: str) -> dict | None:
    for c in contracts():
        if c["id"] == contract_id:
            return c
    return None


def contract_text(contract: dict) -> str:
    """Flatten a contract into the numbered clause text the workflow ingests."""
    lines = [f"CONTRACT: {contract['title']}", ""]
    for cl in contract["clauses"]:
        lines.append(f"Clause {cl['clause_id']}: {cl['text']}")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Second-workflow data: a support/policy knowledge base for policy-qa.          #
# Demonstrates the SAME engine running a different declarative spec.            #
# --------------------------------------------------------------------------- #

POLICY_KB: list[dict] = [
    {"id": "refund", "title": "Refund window",
     "text": "Customers may request a full refund within 30 days of purchase; "
             "after 30 days, refunds are prorated to the unused term."},
    {"id": "sla", "title": "Uptime SLA",
     "text": "The service targets 99.9% monthly uptime. Credits of 10% of the "
             "monthly fee apply for each full percentage point below target."},
    {"id": "security", "title": "Data residency",
     "text": "Customer data is stored in the customer's selected region and is "
             "never moved across regions without written authorization."},
    {"id": "support", "title": "Support tiers",
     "text": "Standard support responds within one business day; Premium support "
             "responds within two hours, 24/7."},
]
