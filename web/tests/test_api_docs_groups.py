"""/docs groups: the agent-facing routes are documented where an agent author will look."""
from server import app


def _schema():
    app.openapi_schema = None
    return app.openapi()


def test_agent_worker_routes_are_grouped_and_say_how_to_authenticate():
    schema = _schema()
    tags = {t["name"]: t.get("description", "") for t in schema["tags"]}
    assert "X-Plexar-Session-Token" in tags["Agent workers"]
    agent_paths = [p for p in schema["paths"] if p.startswith("/api/agent")]
    assert len(agent_paths) >= 9
    for p in agent_paths:
        for op in schema["paths"][p].values():
            assert op["tags"] == ["Agent workers"], p


def test_subagents_route_is_grouped_and_the_api_no_longer_claims_no_auth_anywhere():
    schema = _schema()
    assert schema["paths"]["/api/subagents"]["get"]["tags"] == ["Claude agents (read-only)"]
    desc = schema["info"]["description"]
    assert "most routes have **no authentication**" in desc
    assert "/api/agent/*" in desc and "PLEXAR_STUDIO_CLI" in desc
