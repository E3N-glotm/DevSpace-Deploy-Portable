"""Real self-update guard test: an older live Windows controller cannot downgrade Agent 1.1.47."""
import ast
import pathlib

source = pathlib.Path(__file__).resolve().parents[1] / "vendor/waishnav-devspace/dist/linux-agent/devspace-agent.py"
tree = ast.parse(source.read_text(encoding="utf8"))
klass = next(x for x in tree.body if isinstance(x, ast.ClassDef) and x.name == "AgentRuntime")
update = next(x for x in klass.body if isinstance(x, ast.FunctionDef) and x.name == "agent_self_update")
imported = ast.Module(body=[ast.ClassDef(name="GuardUnderTest", bases=[], keywords=[], body=[update], decorator_list=[])], type_ignores=[])
namespace = {"AGENT_VERSION": "1.1.48"}
exec(compile(ast.fix_missing_locations(imported), str(source), "exec"), namespace)
guard = namespace["GuardUnderTest"]()
for version in ("1.1.46", "1.1.47", "1.1.48", "1.1.0", "0.99.99"):
    result = guard.agent_self_update({"version": version, "url": "http://invalid.invalid/", "sha256": "invalid"})
    assert result == {"updated": False, "version": "1.1.48", "reason": "not-newer"}, result
for bad in ("", "garbage", "1.1.46-dev", "1.1.47.1"):
    try:
        guard.agent_self_update({"version": bad})
    except ValueError:
        pass
    else:
        raise AssertionError("Malformed update version accepted: " + bad)
print({"olderControllerDowngradeBlocked": True, "sameVersionBlocked": True, "invalidVersionRejected": True})
