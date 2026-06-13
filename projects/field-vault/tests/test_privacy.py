"""k-anonymity / re-identification risk on the de-identified surface."""

from field_vault import privacy, store


def test_deid_surface_has_singletons():
    store.reset()
    k = privacy.k_anonymity(store.records())
    # tokenizing direct identifiers does NOT prevent linkage: on the full quasi
    # tuple every row is unique (k=1) and re-identifiable.
    assert k["k_min"] == 1
    assert k["singleton_count"] == len(store.records())
    assert k["reidentifiable_by_linkage"] is True


def test_coarser_generalization_raises_k():
    store.reset()
    sweep = privacy.generalization_sweep(store.records())
    ks = [row["k_min"] for row in sweep]
    # the lever: as quasi-identifiers are coarsened/dropped, k_min is monotone
    # non-decreasing and the singleton count falls to zero.
    assert ks == sorted(ks)
    assert ks[-1] > ks[0]
    assert sweep[-1]["singletons"] == 0


def test_custom_quasi_set():
    store.reset()
    k = privacy.k_anonymity(store.records(), quasi=("zip",))
    # all records share the same ZIP-3 prefix → one big equivalence class
    assert k["equivalence_classes"] == 1
    assert k["k_min"] == len(store.records())
