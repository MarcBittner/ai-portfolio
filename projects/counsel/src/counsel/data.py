"""Synthetic, PII-free, deterministic finance dataset.

A single demo user's accounts (checking / savings / credit / brokerage), a year
of categorized transactions, and current holdings — all generated from a fixed
seed so the dataset is **safe by construction** (no real person, no real
balances) and **reproducible to the cent** (the eval and tests assert exact
numbers). There are no names, emails, card numbers, or SSNs anywhere: accounts
are identified by opaque ids like ``acct_checking`` and a masked last-four that
is itself synthetic.

This module is pure data + deterministic helpers. It never calls an LLM and
never mutates after build (the approval queue applies simulated changes to a
*copy* of the ledger, not here), so it is the trustworthy ground truth every
number in the product is computed from.
"""

from __future__ import annotations

import random
from dataclasses import asdict, dataclass
from datetime import date, timedelta

SEED = 20240601
# The "today" the demo is anchored to, so "last month" etc. are deterministic.
TODAY = date(2025, 6, 15)

CATEGORIES = [
    "dining", "groceries", "transport", "shopping", "utilities", "rent",
    "income", "entertainment", "health", "travel", "transfer", "fees",
]

# Merchant pools per category — synthetic brand-ish names, no real PII.
_MERCHANTS: dict[str, list[str]] = {
    "dining": ["Olive & Vine", "Corner Noodle", "Blue Mug Coffee", "Taqueria Sol",
               "Pier 7 Grill"],
    "groceries": ["GreenCart Market", "FreshFields", "DailyMart"],
    "transport": ["MetroRail", "RideNow", "ShellGo Fuel", "CityParking"],
    "shopping": ["Nimbus Online", "ThreadHouse", "GadgetBay"],
    "utilities": ["PowerGrid Co", "AquaServ", "FiberNet"],
    "rent": ["Maple Court Residences"],
    "entertainment": ["StreamPlus", "Cinema 12", "PlayPass"],
    "health": ["WellPharm", "ClearView Dental", "FitClub"],
    "travel": ["SkyHop Air", "RestEasy Hotels"],
    "fees": ["Bank Service Fee", "ATM Fee", "Foreign Tx Fee"],
}


@dataclass(frozen=True)
class Account:
    id: str
    name: str
    type: str          # checking | savings | credit | brokerage
    mask: str          # synthetic last-four, e.g. "••4021"
    opening_balance: float  # starting balance before the transaction window


@dataclass(frozen=True)
class Transaction:
    id: str            # txn_000123
    account_id: str
    date: str          # ISO yyyy-mm-dd
    merchant: str
    category: str
    amount: float      # signed: negative = money out, positive = money in


@dataclass(frozen=True)
class Holding:
    id: str            # hold_aapl
    account_id: str
    symbol: str
    shares: float
    price: float       # current price per share (synthetic)


@dataclass
class Dataset:
    accounts: list[Account]
    transactions: list[Transaction]
    holdings: list[Holding]

    # ---- lookups -----------------------------------------------------------
    def account(self, account_id: str) -> Account | None:
        return next((a for a in self.accounts if a.id == account_id), None)

    def txn(self, txn_id: str) -> Transaction | None:
        return next((t for t in self.transactions if t.id == txn_id), None)

    def to_dict(self) -> dict:
        return {
            "accounts": [asdict(a) for a in self.accounts],
            "transactions": [asdict(t) for t in self.transactions],
            "holdings": [asdict(h) for h in self.holdings],
            "today": TODAY.isoformat(),
        }


_ACCOUNTS = [
    Account("acct_checking", "Everyday Checking", "checking", "••4021", 1850.00),
    Account("acct_savings", "High-Yield Savings", "savings", "••7715", 24000.00),
    Account("acct_credit", "Rewards Credit Card", "credit", "••3390", 0.00),
    Account("acct_brokerage", "Brokerage", "brokerage", "••9982", 0.00),
]

_HOLDINGS = [
    Holding("hold_vti", "acct_brokerage", "VTI", 120.0, 268.40),
    Holding("hold_aapl", "acct_brokerage", "AAPL", 40.0, 212.75),
    Holding("hold_bnd", "acct_brokerage", "BND", 90.0, 72.10),
    Holding("hold_cash", "acct_brokerage", "CASH", 1.0, 3120.00),
]


def _round2(x: float) -> float:
    return round(x + 1e-9, 2)


def _gen_transactions(rng: random.Random) -> list[Transaction]:
    """One year of categorized transactions ending at TODAY, fully deterministic."""
    txns: list[Transaction] = []
    n = 0
    start = TODAY - timedelta(days=365)

    def add(account_id: str, d: date, merchant: str, category: str,
            amount: float) -> None:
        nonlocal n
        txns.append(Transaction(
            id=f"txn_{n:06d}", account_id=account_id, date=d.isoformat(),
            merchant=merchant, category=category, amount=_round2(amount)))
        n += 1

    # Monthly recurring: salary in, rent + utilities out. Walk month by month.
    d = date(start.year, start.month, 1)
    while d <= TODAY:
        # paycheck on the 1st (biweekly-ish, modeled as twice a month)
        for day in (1, 15):
            pay_day = d.replace(day=day) if day <= 28 else d
            if start <= pay_day <= TODAY:
                add("acct_checking", pay_day, "Acme Corp Payroll", "income", 3200.00)
        rent_day = d.replace(day=3)
        if start <= rent_day <= TODAY:
            add("acct_checking", rent_day, "Maple Court Residences", "rent", -2150.00)
        util_day = d.replace(day=8)
        if start <= util_day <= TODAY:
            for m, amt in (("PowerGrid Co", -96.0), ("AquaServ", -41.0),
                           ("FiberNet", -70.0)):
                add("acct_checking", util_day, m, "utilities", -abs(amt))
        # monthly savings transfer
        sav_day = d.replace(day=5)
        if start <= sav_day <= TODAY:
            add("acct_savings", sav_day, "Transfer from Checking", "transfer", 800.00)
            add("acct_checking", sav_day, "Transfer to Savings", "transfer", -800.00)
        # advance one month
        d = date(d.year + (d.month // 12), (d.month % 12) + 1, 1)

    # Discretionary spend on the credit card across the year.
    day = start
    while day <= TODAY:
        # a few card swipes per day, weighted toward common categories
        for _ in range(rng.choice([0, 1, 1, 2, 3])):
            cat = rng.choices(
                ["dining", "groceries", "transport", "shopping", "entertainment",
                 "health", "travel"],
                weights=[28, 22, 16, 14, 9, 7, 4])[0]
            merch = rng.choice(_MERCHANTS[cat])
            base = {
                "dining": (8, 60), "groceries": (20, 140), "transport": (3, 45),
                "shopping": (12, 220), "entertainment": (9, 65),
                "health": (15, 180), "travel": (90, 600),
            }[cat]
            amt = -_round2(rng.uniform(*base))
            add("acct_credit", day, merch, cat, amt)
        day += timedelta(days=1)

    # A couple of card fees.
    add("acct_credit", TODAY - timedelta(days=20), "Foreign Tx Fee", "fees", -3.50)
    add("acct_credit", TODAY - timedelta(days=12), "ATM Fee", "fees", -3.00)

    # --- planted anomalies the "unusual charges" question should surface ---
    # A duplicate charge: same merchant + amount on the same day (classic dupe).
    dup_day = TODAY - timedelta(days=9)
    add("acct_credit", dup_day, "GadgetBay", "shopping", -129.99)
    add("acct_credit", dup_day, "GadgetBay", "shopping", -129.99)
    # An outlier: far larger than the user's typical dining spend.
    add("acct_credit", TODAY - timedelta(days=6), "Pier 7 Grill", "dining", -468.00)

    txns.sort(key=lambda t: (t.date, t.id))
    return txns


_CACHE: Dataset | None = None


def build_dataset() -> Dataset:
    """Build (or return the cached) deterministic dataset."""
    global _CACHE
    if _CACHE is None:
        rng = random.Random(SEED)
        _CACHE = Dataset(
            accounts=list(_ACCOUNTS),
            transactions=_gen_transactions(rng),
            holdings=list(_HOLDINGS),
        )
    return _CACHE


# --------------------------------------------------------------------------- #
# Pure helpers used by compute.py + retrieve.py (no LLM, no mutation)          #
# --------------------------------------------------------------------------- #

def account_balance(ds: Dataset, account_id: str) -> float:
    """Opening balance plus the net of all transactions on the account.

    For a credit card the running sum is negative (money owed); we report the
    balance as the signed sum so net-worth math treats a card as a liability.
    """
    acct = ds.account(account_id)
    if acct is None:
        return 0.0
    net = sum(t.amount for t in ds.transactions if t.account_id == account_id)
    return _round2(acct.opening_balance + net)


def in_range(t: Transaction, start: date, end: date) -> bool:
    d = date.fromisoformat(t.date)
    return start <= d <= end


def month_bounds(year: int, month: int) -> tuple[date, date]:
    start = date(year, month, 1)
    end = date(year + (month // 12), (month % 12) + 1, 1) - timedelta(days=1)
    return start, end


# A small registry so api/diagnostics can describe the dataset without leaking
# anything (counts only).
def summary(ds: Dataset) -> dict:
    return {
        "accounts": len(ds.accounts),
        "transactions": len(ds.transactions),
        "holdings": len(ds.holdings),
        "categories": sorted(CATEGORIES),
        "today": TODAY.isoformat(),
        "window_start": (TODAY - timedelta(days=365)).isoformat(),
    }
