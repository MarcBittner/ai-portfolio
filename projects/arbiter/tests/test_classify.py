from arbiter.classify import classify


def test_extraction_via_json():
    f = classify([{"role": "user", "content": "give me the data"}], wants_json=True)
    assert f.task_class == "extraction"
    assert f.wants_json


def test_classification_keyword():
    f = classify([{"role": "user", "content": "Classify this as spam or not"}])
    assert f.task_class == "classification"


def test_codegen_detects_code():
    f = classify([{"role": "user", "content": "write a python def foo(): pass"}])
    assert f.task_class == "codegen"
    assert f.has_code


def test_reasoning_long_or_keyword():
    f = classify([{"role": "user", "content": "reason step by step about this"}])
    assert f.task_class == "reasoning"


def test_chat_short_singleturn():
    f = classify([{"role": "user", "content": "hello"}])
    assert f.task_class == "chat"


def test_token_estimate_and_prefix():
    msgs = [{"role": "system", "content": "x" * 400},
            {"role": "user", "content": "y" * 40}]
    f = classify(msgs)
    assert f.system_tokens >= 90
    assert f.approx_in_tokens >= 100
