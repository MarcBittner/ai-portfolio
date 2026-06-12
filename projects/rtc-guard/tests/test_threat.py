from rtc_guard.threat_model import threat_model


def test_threat_model_shape():
    tm = threat_model()
    assert tm["count"] == len(tm["threats"]) >= 6
    for t in tm["threats"]:
        assert {"id", "category", "title", "threat", "mitigation", "control"} <= set(t)


def test_covers_data_channel_prompt_injection():
    # the AI-specific threat: untrusted data-channel input reaching the agent's LLM
    cats = {t["category"] for t in threat_model()["threats"]}
    assert "agent" in cats and "token" in cats and "egress" in cats
