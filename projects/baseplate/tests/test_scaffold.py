"""The scaffolder: the offline parser extracts the spec, generated files are
present and deterministic, and the k8s manifest parses + carries the paved-road
contract."""

import yaml

from baseplate import scaffold
from baseplate.scaffold import ServiceSpec


def test_offline_parser_extracts_python_db_http():
    spec, _ = scaffold.extract_spec(
        "A Python FastAPI service called rate-ingest that reads rates from "
        "Postgres and serves them over HTTP", mode="offline")
    assert spec.name == "rate-ingest"
    assert spec.language == "python"
    assert spec.needs_db is True
    assert spec.exposes_http is True


def test_offline_parser_handles_negation():
    # "no database" / "no http" must override the keyword hits in the sentence.
    spec, _ = scaffold.extract_spec(
        "A Go API named price-gateway, no database, exposes HTTP endpoints",
        mode="offline")
    assert spec.name == "price-gateway"
    assert spec.language == "go"
    assert spec.needs_db is False
    assert spec.exposes_http is True

    worker, _ = scaffold.extract_spec(
        "A Python scheduled batch job named nightly-reconcile, no http",
        mode="offline")
    assert worker.name == "nightly-reconcile"
    assert worker.exposes_http is False


def test_offline_parser_returns_offline_provider():
    _, routing = scaffold.extract_spec("a python api called foo", mode="offline")
    assert routing["provider"] == "offline"


def test_unsupported_language_defaults_to_python():
    spec = ServiceSpec(name="x", language="haskell").normalized()
    assert spec.language == "python"


def test_name_is_slugified():
    spec = ServiceSpec(name="My Cool Service!!").normalized()
    assert spec.name == "my-cool-service"


def _gen(name="rate-ingest", language="python", needs_db=True, exposes_http=True):
    return scaffold.generate(ServiceSpec(name, language, needs_db, exposes_http))


def test_all_required_files_present():
    gen = _gen()
    paths = set(gen["files"])
    assert "Dockerfile" in paths
    assert ".github/workflows/ci.yml" in paths
    assert "slo.yaml" in paths
    assert "deploy/k8s/rate-ingest.yaml" in paths
    assert "deploy/terraform/rate-ingest.tf" in paths
    assert "deploy/argocd/rate-ingest.yaml" in paths


def test_generation_is_deterministic():
    assert _gen()["files"] == _gen()["files"]


def test_k8s_manifest_parses_and_has_contract():
    gen = _gen(exposes_http=True)
    text = gen["files"]["deploy/k8s/rate-ingest.yaml"]
    docs = [d for d in yaml.safe_load_all(text) if d]
    kinds = {d["kind"] for d in docs}
    assert {"Namespace", "Deployment", "Service", "HorizontalPodAutoscaler",
            "PodDisruptionBudget"} <= kinds
    dep = next(d for d in docs if d["kind"] == "Deployment")
    pod = dep["spec"]["template"]["spec"]
    assert pod["securityContext"]["runAsNonRoot"] is True
    container = pod["containers"][0]
    assert "readinessProbe" in container and "livenessProbe" in container


def test_non_http_service_omits_service_and_probes():
    gen = _gen(name="nightly-reconcile", needs_db=False, exposes_http=False)
    text = gen["files"]["deploy/k8s/nightly-reconcile.yaml"]
    docs = [d for d in yaml.safe_load_all(text) if d]
    kinds = {d["kind"] for d in docs}
    assert "Service" not in kinds
    dep = next(d for d in docs if d["kind"] == "Deployment")
    container = dep["spec"]["template"]["spec"]["containers"][0]
    assert "readinessProbe" not in container


def test_db_service_wires_database_url_secret():
    text = _gen(needs_db=True)["files"]["deploy/k8s/rate-ingest.yaml"]
    assert "DATABASE_URL" in text
    text2 = _gen(needs_db=False)["files"]["deploy/k8s/rate-ingest.yaml"]
    assert "DATABASE_URL" not in text2


def test_terraform_invokes_service_module():
    text = _gen()["files"]["deploy/terraform/rate-ingest.tf"]
    assert 'source       = "../modules/service"' in text
    # hyphenated names become underscore module labels
    assert 'module "rate_ingest"' in text


def test_ci_uses_oidc_and_scan_and_rollback():
    text = _gen()["files"][".github/workflows/ci.yml"]
    assert "id-token: write" in text
    assert "trivy-action" in text
    assert "rollback" in text


def test_slo_stub_has_data_quality_when_db():
    text = _gen(needs_db=True)["files"]["slo.yaml"]
    assert "availability" in text
    assert "burn_rate_alerts" in text
