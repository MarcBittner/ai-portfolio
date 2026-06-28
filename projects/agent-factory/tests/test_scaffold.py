"""Tests for the paved-road scaffolder and the AI-assisted spec customizer."""

import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient

from agent_factory.api import app
from agent_factory.scaffold import (
    LANGUAGES,
    customize_spec,
    dockerfile,
    pkg_name,
    scaffold,
    scaffold_zip,
    slug,
)
from agent_factory.spec import AgentSpec, template

client = TestClient(app)


# ---- naming -------------------------------------------------------------- #

def test_slug_and_pkg_names_are_safe():
    assert slug("Rate Helper!") == "rate-helper"
    assert pkg_name("Rate Helper!") == "rate_helper"
    assert pkg_name("123 bot") == "a_123_bot"  # not a leading digit
    assert slug("") == "agent" and pkg_name("") == "agent"


# ---- Python target ------------------------------------------------------- #

def test_python_project_has_industry_standard_layout():
    files = scaffold(template("calculator"), "python")
    pkg = pkg_name("calculator")
    required = {
        "README.md", "Dockerfile", "pyproject.toml", ".env.example", ".gitignore",
        "agent_spec.json", "tests/test_agent.py",
        f"src/{pkg}/__init__.py", f"src/{pkg}/agent.py", f"src/{pkg}/orchestrate.py",
        f"src/{pkg}/cli.py", f"src/{pkg}/api.py",
    }
    assert required <= set(files)


def test_generated_python_compiles():
    files = scaffold(AgentSpec(name="quant-bot"), "python")
    for path, content in files.items():
        if path.endswith(".py"):
            compile(content, path, "exec")  # raises SyntaxError on bad codegen


def test_generated_python_clones_the_runtime_under_the_new_package():
    pkg = pkg_name("my-agent")
    files = scaffold(AgentSpec(name="my-agent"), "python")
    agent_src = files[f"src/{pkg}/agent.py"]
    assert "agent_factory" not in agent_src  # imports were rewritten
    assert f"from {pkg}" in agent_src


def test_agent_spec_roundtrips_into_the_generated_project():
    spec = template("analyst")
    files = scaffold(spec, "python")
    embedded = AgentSpec.model_validate(json.loads(files["agent_spec.json"]))
    assert embedded == spec


# ---- TypeScript target --------------------------------------------------- #

def test_typescript_project_has_industry_standard_layout():
    files = scaffold(template("researcher"), "typescript")
    required = {
        "README.md", "Dockerfile", "package.json", "tsconfig.json", ".env.example",
        "agent-spec.json", "test/agent.test.ts",
        "src/agent.ts", "src/orchestrate.ts", "src/cli.ts", "src/server.ts",
        "src/tools.ts", "src/spec.ts",
    }
    assert required <= set(files)
    pkg = json.loads(files["package.json"])
    assert pkg["name"] == "researcher" and "build" in pkg["scripts"]


# ---- Dockerfile-only + zip output --------------------------------------- #

@pytest.mark.parametrize("language", LANGUAGES)
def test_dockerfile_only_output(language):
    df = dockerfile(template("assistant"), language)
    assert df.startswith("#") and "FROM" in df


@pytest.mark.parametrize("language", LANGUAGES)
def test_zip_contains_the_whole_tree_with_readme_and_dockerfile(language):
    spec = AgentSpec(name="zip-agent")
    data = scaffold_zip(spec, language)
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = zf.namelist()
        assert "zip-agent/README.md" in names
        assert "zip-agent/Dockerfile" in names
        assert zf.testzip() is None  # archive integrity


def test_unknown_language_is_rejected():
    with pytest.raises(ValueError):
        scaffold(AgentSpec(), "rust")


# ---- AI-assisted customization (offline fallback) ----------------------- #

def test_customize_spec_falls_back_deterministically_offline():
    spec, meta = customize_spec("an agent that does math and converts units")
    assert meta["source"] in ("offline", "llm")
    # with no model configured the deterministic path picks tools by keyword
    if meta["source"] == "offline":
        assert "calculator" in spec.tools and "convert" in spec.tools
    assert isinstance(spec, AgentSpec) and spec.system_prompt


def test_customize_spec_refines_a_base_template():
    base = template("researcher")
    spec, _ = customize_spec("focus on date math", base)
    assert isinstance(spec, AgentSpec)


# ---- API surface --------------------------------------------------------- #

def test_api_scaffold_languages():
    r = client.get("/scaffold/languages")
    assert r.status_code == 200 and set(r.json()["languages"]) == set(LANGUAGES)


def test_api_scaffold_files_and_dockerfile():
    r = client.post("/scaffold", json={"template": "calculator", "language": "python"})
    assert r.status_code == 200
    body = r.json()
    assert body["language"] == "python" and body["project"] == "calculator"
    assert "src/calculator/agent.py" in body["files"]

    r2 = client.post("/scaffold?format=dockerfile",
                     json={"template": "calculator", "language": "typescript"})
    assert r2.status_code == 200 and "FROM node" in r2.json()["dockerfile"]


def test_api_scaffold_zip_download():
    r = client.post("/scaffold/zip", json={"template": "analyst", "language": "python"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    assert "attachment" in r.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        assert any(n.endswith("README.md") for n in zf.namelist())


def test_api_scaffold_rejects_unknown_language():
    r = client.post("/scaffold", json={"template": "assistant", "language": "cobol"})
    assert r.status_code == 422


def test_api_spec_customize():
    r = client.post("/spec/customize",
                    json={"prompt": "an agent that extracts fields from JSON"})
    assert r.status_code == 200
    body = r.json()
    assert "spec" in body and "meta" in body
    AgentSpec.model_validate(body["spec"])  # the proposed spec is valid
