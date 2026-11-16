"""The ElevenLabs Agents text provider and local passage retrieval, with fakes only (no network, no spending)."""

import asyncio
import io
import json
import os
import queue
import tempfile
import threading
import time
import unittest
import unittest.mock
from pathlib import Path

from backend.app import agent_text
from backend.app.agent_text import (AGENTS, MAX_CAP_CENTS, AgentSocket, AgentText, AgentTextError, SpendLedger,
                                    parse_json_object, reservation_cents)
from backend.app.grounding import Grounding

os.environ["BOARDROOM_AGENTS_ENABLED"] = "false"


class Transport:
    """Scripted answers: text, an Exception to raise, or 'hang' to block until released."""

    def __init__(self, plan):
        self.plan, self.calls, self.release = list(plan), [], threading.Event()

    def __call__(self, agent_id, prompt, timeout):
        self.calls.append((agent_id, prompt, timeout))
        step = self.plan.pop(0) if self.plan else "ok"
        if step == "hang":
            self.release.wait(timeout)
            raise TimeoutError("hung")
        if isinstance(step, Exception):
            raise step
        return step, {"conversation_id": f"conv_{len(self.calls)}", "seconds": 0.1}


def provider(plan, folder, **options):
    transport = Transport(plan)
    return AgentText("test-key", ledger=Path(folder) / "agents" / "ledger.sqlite", transport=transport, **options), transport


class AgentTextTests(unittest.IsolatedAsyncioTestCase):
    def test_env_configuration_is_off_unless_explicitly_enabled(self):
        with unittest.mock.patch.dict(os.environ, {"ELEVENLABS_API_KEY": "test-key"}):
            os.environ.pop("BOARDROOM_AGENTS_ENABLED", None)
            self.assertFalse(AgentText.from_env().configured, "a key alone never enables paid calls")
        with unittest.mock.patch.dict(os.environ, {"ELEVENLABS_API_KEY": "test-key", "BOARDROOM_AGENTS_ENABLED": "true"}):
            self.assertTrue(AgentText.from_env().configured)
            with unittest.mock.patch.dict(os.environ, {"BOARDROOM_AGENT_ANALYST_ID": "agent_other"}):
                self.assertEqual(AgentText.from_env().agent_ids["analyst"], "agent_other")
                self.assertEqual(AgentText.from_env().agent_ids["writer"], AGENTS["writer"])
        with unittest.mock.patch.dict(os.environ, {"ELEVENLABS_API_KEY": "", "BOARDROOM_AGENTS_ENABLED": "true"}):
            self.assertFalse(AgentText.from_env().configured)
        os.environ["BOARDROOM_AGENTS_ENABLED"] = "false"

    def test_parse_json_object(self):
        self.assertEqual(parse_json_object('```json\n{"a": 1}\n```'), {"a": 1})
        for bad in ("no json", "[1]", 'Sure: {"a": 1}', '{"a": 1} trailing'):
            with self.assertRaises(ValueError):
                parse_json_object(bad)

    def test_role_follows_output_kind_and_temperature(self):
        self.assertEqual(AgentText.role_for(False, 0.0), "writer")
        self.assertEqual(AgentText.role_for(True, 0.0), "analyst")
        self.assertEqual(AgentText.role_for(True, 0.4), "drafter")

    def test_reservation_covers_message_prompt_and_output_cap(self):
        self.assertEqual(reservation_cents("short", 600), 1)
        # 20 KB prompt and the whole quiz output: 0.3 + (6667 + 400) * 0.000125 + 12288 * 0.0005 = 7.33 cents.
        self.assertEqual(reservation_cents("x" * 20000, 12288), 8)

    async def test_generate_routes_reserves_and_records_usage(self):
        with tempfile.TemporaryDirectory() as folder:
            agents, transport = provider(['{"options": []}', "A spoken line."], folder)
            self.assertFalse(agents.ledger.exists(), "construction never touches disk")
            self.assertEqual(await agents.json("prompt", 5, temperature=0.0), {"options": []})
            self.assertEqual(await agents.text("prompt", 5, 600), "A spoken line.")
            self.assertEqual([call[0] for call in transport.calls], [AGENTS["analyst"], AGENTS["writer"]])
            status = agents.budget().status()
            self.assertEqual((status["attempts"], status["cap_usd"], status["unlimited"]), (2, 50.0, False))
            self.assertEqual(status["reserved_usd"], 0.03)  # 2 cents for 2048 JSON tokens, 1 cent for the line

    async def test_backup_attempt_answers_when_the_first_hangs(self):
        original = agent_text.TEXT_HEDGE_MARKS
        agent_text.TEXT_HEDGE_MARKS = (0.0, 0.1, 0.2)
        try:
            with tempfile.TemporaryDirectory() as folder:
                agents, transport = provider(["hang", "Second answer."], folder)
                self.assertEqual(await agents.text("prompt", 5), "Second answer.")
                self.assertEqual(len(transport.calls), 2)
                transport.release.set()
        finally:
            agent_text.TEXT_HEDGE_MARKS = original

    async def test_long_json_waits_longer_before_a_paid_backup(self):
        short, long = agent_text.JSON_HEDGE_MARKS, agent_text.LONG_JSON_HEDGE_MARKS
        agent_text.JSON_HEDGE_MARKS, agent_text.LONG_JSON_HEDGE_MARKS = (0.0, 0.05), (0.0, 5.0)
        try:
            with tempfile.TemporaryDirectory() as folder:
                def slow(agent_id, prompt, timeout):
                    calls.append(agent_id)
                    time.sleep(0.3)
                    return "{}", {}
                calls = []
                agents = AgentText("test-key", ledger=Path(folder) / "ledger.sqlite", transport=slow)
                await agents.json("prompt", 5, 12288)
                self.assertEqual(len(calls), 1, "the quiz does not start a backup while the first attempt is still writing")
                calls.clear()
                await agents.json("prompt", 5, 1024)
                self.assertEqual(len(calls), 2)
        finally:
            agent_text.JSON_HEDGE_MARKS, agent_text.LONG_JSON_HEDGE_MARKS = short, long

    async def test_failures_never_leak_the_key_and_keep_their_reservations(self):
        with tempfile.TemporaryDirectory() as folder:
            agents, transport = provider([RuntimeError("body with test-key"), RuntimeError("x"), RuntimeError("y")], folder)
            with self.assertRaises(AgentTextError) as caught:
                await agents.text("prompt", 5)
            self.assertNotIn("test-key", str(caught.exception))
            self.assertEqual(agents.budget().status()["attempts"], 3)  # the request and its two backups
            malformed, _ = provider(["not json", "not json", "not json"], folder)
            with self.assertRaises((AgentTextError, ValueError)):
                await malformed.json("prompt", 5)

    async def test_unconfigured_and_oversized_prompts_are_refused_before_any_call(self):
        with tempfile.TemporaryDirectory() as folder:
            off = AgentText("", ledger=Path(folder) / "ledger.sqlite", transport=Transport([]))
            with self.assertRaises(AgentTextError):
                await off.text("prompt", 5)
            agents, transport = provider([], folder)
            with self.assertRaises(ValueError):
                await agents.text("x" * 20001, 5)
            self.assertEqual(transport.calls, [])

    def test_ledger_cap_survives_restart_and_blocks_at_the_limit(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "ledger.sqlite"
            ledger = SpendLedger(path, 10)
            ledger.reserve(8)
            with self.assertRaises(AgentTextError):
                ledger.reserve(3)
            self.assertEqual(SpendLedger(path, MAX_CAP_CENTS).cap, 10, "a restart cannot enlarge the stored cap")
            ledger.authorize_increase(20)
            ledger.reserve(3)
            self.assertEqual(ledger.status()["remaining_usd"], 0.09)
            with self.assertRaises(ValueError):
                SpendLedger(Path(folder) / "other.sqlite", MAX_CAP_CENTS + 1)


class StepLabelTests(unittest.TestCase):
    """The timing log names a step by the start of its prompt; a member's display name must never be in it."""

    def test_member_names_are_dropped_whatever_they_contain(self):
        for name in ("Alex", "Dr. Lee, PhD", "A, the CEO on the board of a fictional organisation", "Line one\nLine two", "x" * 120):
            for rest in (" on the board of a fictional organisation in a crisis exercise. It is your speaking turn.",
                         ", in a private one to one session with a crisis coach about your decision."):
                label = agent_text.step_label(f"You are {name}, the CEO{rest}\n\nScenario: ...")
                self.assertTrue(label.startswith("You are (member)"), label)
                self.assertLessEqual(len(label), 70)
                for part in ("Alex", "Lee", "PhD", "Line", "xxx", "A, the CEO"):
                    self.assertNotIn(part, label)

    def test_other_steps_keep_their_first_line(self):
        label = agent_text.step_label("You are the AI facilitator opening a fictional board crisis exercise. Introduce it.\nMore")
        self.assertEqual(label, "You are the AI facilitator opening a fictional board crisis exercise. ")


class FakeResponse(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *args): self.close()


class FakeOpener:
    def __init__(self, payload): self.payload, self.requests = payload, []
    def open(self, request, timeout):
        self.requests.append(request)
        return FakeResponse(json.dumps(self.payload).encode())


class FakeSocket:
    def __init__(self, events): self.events, self.sent = list(events), []
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def send(self, message): self.sent.append(json.loads(message))
    def recv(self, timeout=None): return json.dumps(self.events.pop(0))


class AgentSocketTests(unittest.TestCase):
    def socket(self, signed, events):
        opener, link = FakeOpener({"signed_url": signed}), FakeSocket(events)
        urls = []

        def connect(url, **options):
            urls.append(url)
            return link
        return AgentSocket("test-key", context=object(), opener=opener, connect=connect), opener, link, urls

    def test_one_text_only_conversation(self):
        signed = "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=a&conversation_signature=s"
        client, opener, link, urls = self.socket(signed, [
            {"type": "conversation_initiation_metadata", "conversation_initiation_metadata_event": {"conversation_id": "conv_1"}},
            {"type": "ping", "ping_event": {"event_id": 7}},
            {"type": "agent_chat_response_part", "text_response_part": {"text": "An"}},
            {"type": "agent_response", "agent_response_event": {"agent_response": "An answer."}}])
        text, usage = client.ask("agent_a", "The task", 5)
        self.assertEqual((text, usage["conversation_id"]), ("An answer.", "conv_1"))
        self.assertEqual(urls, [signed])
        request = opener.requests[0]
        self.assertIn("agent_id=agent_a", request.full_url)
        self.assertEqual(request.get_header("Xi-api-key"), "test-key")
        self.assertEqual(link.sent[0], {"type": "conversation_initiation_client_data",
                                        "conversation_config_override": {"conversation": {"text_only": True}}})
        self.assertEqual(link.sent[1], {"type": "user_message", "text": "The task"})
        self.assertEqual(link.sent[2], {"type": "pong", "event_id": 7})

    def test_refuses_a_signed_url_on_another_host_and_reported_errors(self):
        client, _, _, urls = self.socket("wss://example.invalid/v1/convai/conversation", [])
        with self.assertRaises(AgentTextError):
            client.ask("agent_a", "The task", 5)
        self.assertEqual(urls, [])
        client, _, _, _ = self.socket("wss://api.elevenlabs.io/x", [{"type": "client_error"}])
        with self.assertRaises(AgentTextError):
            client.ask("agent_a", "The task", 5)


class LiveSocket:
    """A conversation that waits like a real one: recv blocks until an event arrives or the timeout passes, and the
    answer only arrives after the user message."""

    def __init__(self, answer):
        self.sent, self.inbox, self.answer, self.closed = [], queue.Queue(), answer, False
        self.inbox.put({"type": "conversation_initiation_metadata",
                        "conversation_initiation_metadata_event": {"conversation_id": "conv_warm"}})
        self.inbox.put({"type": "ping", "ping_event": {"event_id": 3}})

    def __enter__(self): return self
    def __exit__(self, *args):
        self.closed = True
        return False

    def send(self, message):
        event = json.loads(message)
        self.sent.append(event)
        if event["type"] == "user_message":
            self.inbox.put({"type": "agent_chat_response_part", "text_response_part": {"type": "delta", "text": "An"}})
            self.inbox.put({"type": "agent_response", "agent_response_event": {"agent_response": self.answer}})

    def recv(self, timeout=None):
        try:
            return json.dumps(self.inbox.get(timeout=timeout))
        except queue.Empty:
            raise TimeoutError from None


class WarmConversationTests(unittest.TestCase):
    signed = "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=a&conversation_signature=s"

    def client(self):
        opener, links = FakeOpener({"signed_url": self.signed}), []

        def connect(url, **options):
            links.append(LiveSocket(f"Answer {len(links) + 1}."))
            return links[-1]
        return AgentSocket("test-key", context=object(), opener=opener, connect=connect, warm=True), opener, links

    @staticmethod
    def wait(condition):
        deadline = time.monotonic() + 3
        while not condition() and time.monotonic() < deadline:
            time.sleep(0.01)
        return condition()

    def test_a_request_takes_the_conversation_opened_ahead(self):
        client, opener, links = self.client()
        try:
            client.prime("agent_a")
            self.assertTrue(self.wait(lambda: links and {"type": "pong", "event_id": 3} in links[0].sent))
            self.assertEqual(len(opener.requests), 1)
            text, usage = client.ask("agent_a", "The task", 5)
            # The first conversation answered: it was opened and initiated before the request, then got the message.
            self.assertEqual((text, usage["conversation_id"], usage.get("warm")), ("Answer 1.", "conv_warm", True))
            self.assertEqual([event["type"] for event in links[0].sent],
                             ["conversation_initiation_client_data", "pong", "user_message"])
            # And the next request already has its own conversation on the way.
            self.assertTrue(self.wait(lambda: len(links) == 2))
            self.assertEqual(client.ask("agent_a", "Another task", 5)[0], "Answer 2.")
        finally:
            client.close()

    def test_without_priming_or_after_expiry_the_request_opens_its_own(self):
        client, opener, links = self.client()
        try:
            with unittest.mock.patch("backend.app.agent_text.WARM_SECONDS", 0.0):
                client.prime("agent_a")
                self.assertTrue(self.wait(lambda: len(links) >= 1 and links[0].closed))  # Too old at once: closed unused.
                self.assertNotIn("user_message", [event["type"] for event in links[0].sent])
            cold = AgentSocket("test-key", context=object(), opener=opener,
                               connect=lambda url, **options: FakeSocket([
                                   {"type": "agent_response", "agent_response_event": {"agent_response": "Cold."}}]))
            self.assertEqual(cold.ask("agent_a", "The task", 5)[0], "Cold.")
            cold.prime("agent_a")  # A bare socket never opens anything ahead.
            self.assertEqual(cold._warm, {})
        finally:
            client.close()

    def test_a_conversation_that_fails_to_open_is_not_retried_in_a_loop(self):
        attempts = []

        def connect(url, **options):
            attempts.append(url)
            raise OSError("network down")
        client = AgentSocket("test-key", context=object(), opener=FakeOpener({"signed_url": self.signed}),
                             connect=connect, warm=True)
        client._last_request = time.monotonic()  # Requests are recent, so an expired conversation would be replaced.
        client.prime("agent_a")
        self.assertTrue(self.wait(lambda: len(attempts) == 1 and not client._warm.get("agent_a")))
        time.sleep(0.2)
        self.assertEqual(len(attempts), 1)  # One failed attempt, no automatic second one.
        client.close()

    def test_agent_text_primes_only_when_configured(self):
        with tempfile.TemporaryDirectory() as folder:
            off = AgentText("", ledger=Path(folder) / "ledger.sqlite")
            off.prime("writer")
            self.assertIsNone(off._socket)
            injected = AgentText("test-key", ledger=Path(folder) / "ledger.sqlite", transport=lambda *args: ("x", {}))
            injected.prime("writer")  # An injected transport has no socket to warm; never raises.
            self.assertIsNone(injected._socket)


class GroundingTests(unittest.IsolatedAsyncioTestCase):
    async def test_picks_the_passage_that_shares_distinctive_words(self):
        context = {"documents": [("Payroll", "The payroll vendor missed the Friday batch and staff wages are late."),
                                 ("Security", "An attacker used a stolen administrator password to reach the server.")],
                   "attached": [{"title": "Report", "sections": [("Media", "A journalist asked about customer data.")]}]}
        picked = await Grounding().select(context, "What should we tell staff about late wages?")
        self.assertEqual(picked[0][0], "Payroll")
        self.assertNotIn("Security", [label for label, _ in picked])
        self.assertIsNone(await Grounding().select(context, "zebra quantum"))
        self.assertIsNone(await Grounding().select({"documents": [("Only", "one passage")]}, "passage"))


if __name__ == "__main__":
    unittest.main()
