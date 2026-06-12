from rate_atlas.data import SOURCES
from rate_atlas.normalize import normalize_source

_CANON = {"hospital", "code", "code_type", "description", "payer", "plan", "rate"}


def test_detects_each_shape():
    shapes = {}
    for name, raw in SOURCES.items():
        records, shape = normalize_source(name, raw)
        shapes[name] = shape
        assert records
        for r in records:
            assert set(r) == _CANON
            assert isinstance(r["rate"], float)
    assert shapes == {
        "alpha-medical-center": "cms_nested_json",
        "beta-health-system": "flat_json",
        "gamma-community-clinic": "pipe_csv",
    }


def test_hospital_names_resolved():
    a, _ = normalize_source("alpha-medical-center", SOURCES["alpha-medical-center"])
    assert a[0]["hospital"] == "Alpha Medical Center"   # from the file
    g, _ = normalize_source("gamma-community-clinic", SOURCES["gamma-community-clinic"])
    assert g[0]["hospital"] == "Gamma Community Clinic"  # derived from the name


def test_unrecognized_shape_raises():
    try:
        normalize_source("x", '{"foo": 1}')
        raise AssertionError("expected ValueError")
    except ValueError:
        pass
