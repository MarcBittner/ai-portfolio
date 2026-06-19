# Source — real public data

The item descriptions, vendor SKUs, units, forecasted quantities, and unit prices in this
scenario are taken **verbatim from a real public document**:

> IDEA Public Schools — Office Supplies bid tabulation, solicitation **34-CNPOF-0625**
> (published 2025).
> https://ideapublicschools.org/wp-content/uploads/2025/08/34-CNPOF-0625-Office-Supplies-Bid-Tabulation.pdf

Unit prices are the **first vendor column** of that tabulation (a real submitted bid). The
PO (`contract-PO-…`) lists those items at those real prices. The invoice (`invoice-INV-…`)
bills the same real items, and **four lines were deliberately modified** to plant
discrepancies so reconciliation has something to find (everything else is at the contract
price):

- **Wireless mouse Logitech M720** (`LOG910004790`): billed **$39.50** vs contract **$33.89**
  → +16.5%, expect **red** (~$280.50 recoverable on 50 units).
- **Wired keyboard Logitech K120** (`LOG920002478`): 50 × $10.65 = $532.50 but the invoice
  prints **$560.00** → expect **red (math error)**.
- **Correction tape** (`OFD699459`): billed **$4.99** vs **$4.78** → +4.4%, expect **yellow**.
- **Restocking fee**: a line not on the PO → expect **yellow (unmatched)**.

Note the real document also contains OCR/encoding noise (e.g. "QuoƟng" for "Quoting") — a
realistic wrinkle the LLM tolerates and a naive parser does not.
