import io
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone

from pipeline import MyClawLaborAgent


class FakeResponse:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text

    def json(self):
        return self._payload


class FakeClient:
    def __init__(self, routes=None):
        self.routes = routes or {}
        self.calls = []

    async def get(self, path, **_kwargs):
        self.calls.append(("GET", path))
        return self.routes.get(("GET", path), FakeResponse(404, {}))

    async def post(self, path, **kwargs):
        self.calls.append(("POST", path, kwargs.get("json")))
        return self.routes.get(("POST", path), FakeResponse(200, {}))

    async def aclose(self):
        self.calls.append(("CLOSE", None))


class PipelineClaimTaskTests(unittest.IsolatedAsyncioTestCase):
    async def test_refreshes_claimed_task_until_submitted(self):
        client = FakeClient({
            ("GET", "/tasks/task-1"): FakeResponse(200, {
                "task": {
                    "id": "task-1",
                    "status": "submitted",
                    "result": "done",
                    "confirm_deadline": "2026-05-07T12:00:00Z",
                },
            }),
        })
        agent = MyClawLaborAgent(client=client)
        agent.active_tasks["task-1"] = {"status": "assigned"}

        out = io.StringIO()
        with redirect_stdout(out):
            await agent.refresh_active_tasks()

        self.assertEqual(agent.active_tasks["task-1"]["status"], "submitted")
        self.assertEqual(agent.active_tasks["task-1"]["result"], "done")
        self.assertIn("TASK RESULT SUBMITTED", out.getvalue())
        self.assertIn("/tasks/task-1", out.getvalue())

    async def test_check_deadlines_warns_for_task_confirmation_window(self):
        agent = MyClawLaborAgent(client=FakeClient())
        deadline = datetime.now(timezone.utc) + timedelta(minutes=30)
        agent.active_tasks["task-2"] = {
            "status": "submitted",
            "confirm_deadline": deadline.isoformat(),
        }

        out = io.StringIO()
        with redirect_stdout(out):
            await agent.check_deadlines()

        self.assertIn("URGENT: Task task-2", out.getvalue())

    async def test_accept_task_result_calls_claim_accept_endpoint(self):
        client = FakeClient({
            ("POST", "/tasks/task-3/accept"): FakeResponse(200, {"id": "task-3"}),
        })
        agent = MyClawLaborAgent(client=client)
        agent.active_tasks["task-3"] = {"status": "submitted"}

        with redirect_stdout(io.StringIO()):
            await agent.accept_task_result("task-3")

        self.assertIn(("POST", "/tasks/task-3/accept", {}), client.calls)
        self.assertNotIn("task-3", agent.active_tasks)


if __name__ == "__main__":
    unittest.main()
