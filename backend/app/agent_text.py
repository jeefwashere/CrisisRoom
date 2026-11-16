"""ElevenLabs Agents text provider for the main backend.

Approved by the user (Nov 16 2026): every text responsibility of the main game (opening briefing, adviser and coach
lines, AI replies, AI drafted ballot options, custom action resolution, the private response card and the Round 3
quiz) is written by ElevenLabs Agents running `gpt-6.1-terra`. Models only write text; Rooms remains the game
authority.

Three private agents in the owner's ElevenLabs workspace do the writing. A request is one text only conversation:
the backend asks ElevenLabs for a signed URL with the server side key, opens the conversation WebSocket, sends the
whole task as one user message and returns the agent's answer. No audio is produced and the browser never receives a
token.

  writer   spoken text                         temperature 0.4
  analyst  JSON that must be repeatable        temperature 0
  drafter  JSON that drafts options or a quiz  temperature 0.4

Temperature, model and output cap live on each agent (a conversation cannot override them), so the provider picks the
agent from the kind of output and the temperature the caller asks for. Every attempt reserves a conservative amount
in a persistent SQLite ledger before the request, including failures, under the authorized US$50 cap.
"""

import asyncio
from contextlib import closing
from datetime import date
import json
import math
import os
from pathlib import Path
import queue
import sqlite3
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from . import timing

API = "https://api.elevenlabs.io"
SOCKET_PREFIX = "wss://api.elevenlabs.io/"
MODEL = "gpt-6.1-terra"
# Agent identifiers are not credentials: the agents are private and every conversation needs a signed URL minted with
# the server side key. BOARDROOM_AGENT_WRITER_ID, BOARDROOM_AGENT_ANALYST_ID and BOARDROOM_AGENT_DRAFTER_ID override them.
AGENTS = {
    "writer": "agent_7201m7hd3kxfe5ft9saa0g5sdn1w",
    "analyst": "agent_8201m7hd3qe6f26aeejqxrdj1pc7",
    "drafter": "agent_5901m7hd3tdse3sr8b4p26k7xgtf",
}
# Output token cap stored on each agent. A reservation never assumes more output than the agent can produce.
OUTPUT_CAPS = {"writer": 1500, "analyst": 4096, "drafter": 12288}
DEFAULT_LEDGER = ".local/agents/ledger.sqlite"
MAX_PROMPT_BYTES = 20000
MAX_CAP_CENTS = 5000  # US$50, authorized by the user on Nov 16 2026.
# Prices read from two live conversations on Nov 16 2026 (ElevenLabs conversation charging records): US$0.003 for each
# text message, gpt-6.1-terra input at US$1.00 per million tokens (US$1.25 when written to the cache) and output at
# US$5.00 per million. A reservation assumes one token for every three prompt bytes, the cache write price, the system
# prompt and the whole output cap, rounded up to a whole cent.
PRICE_REVIEW = date(2027, 6, 1)
MESSAGE_CENTS = 0.3
INPUT_CENTS_PER_TOKEN = 1.25e-4
OUTPUT_CENTS_PER_TOKEN = 5e-4
SYSTEM_PROMPT_TOKENS = 400
# Backup requests (seconds after the first). A duplicate starts at each mark still without an answer (or at once when
# an attempt fails) and the first good answer wins, so a hung conversation costs seconds instead of the whole timeout.
# Measured Nov 16 2026: a 40 word spoken line took 2.7 s and an 18 KB JSON task 1.5 s, signed URL included. Later the
# same day, with conversations opened ahead, 61 spoken lines had a median of 1.7 s and none of the normal ones took
# 3.5 s, while about one request in thirty stalled for 5 to 14 s; so the first backup for a spoken line starts at
# 3.5 s instead of 5 s (a player is waiting for it), at the cost of an occasional second one cent request.
TEXT_HEDGE_MARKS = (0.0, 3.5, 8.0)
JSON_HEDGE_MARKS = (0.0, 8.0, 16.0)
# Long JSON (the Round 3 quiz, up to 12288 output tokens, 90 s timeout) took 12.3 s when measured on Nov 16 2026, so the
# short marks above would start a second paid attempt on every quiz. Its backups wait much longer.
LONG_JSON_HEDGE_MARKS = (0.0, 30.0, 60.0)
# Warm conversations. Opening a conversation (signed URL, TLS and WebSocket handshake) took 0.4 s on a quiet machine
# and up to 1.7 s on a busy one (measured Nov 16 2026), before the agent has read a word. A conversation opened ahead
# and left waiting answered normally after 60 s as long as its pings were answered, and an unused one has no
# messages and so no message fee. So after each request, and when the game says a request is coming, one more
# conversation per agent is opened in the background and kept for WARM_SECONDS; the next request takes it and skips
# the wait. Replacements stop KEEP_WARM_SECONDS after the last request, so an idle server opens nothing.
WARM_SECONDS = 40.0
KEEP_WARM_SECONDS = 90.0
MAX_WARM_PER_AGENT = 3


class AgentTextError(RuntimeError):
    pass


# Where the fixed wording resumes after "You are <display name>, the <role>" in the prompts that speak as a member.
MEMBER_PROMPT_ANCHORS = (" on the board of a fictional organisation", ", in a private one to one session with a crisis coach")


def step_label(prompt: str) -> str:
    """A short name for the timing log: the start of the prompt's instruction, which names the step.

    Prompts that speak as a member start with that member's display name. Everything before the fixed wording that
    follows the name and role is dropped, whatever the name contains, so the log never holds a player's name.
    """
    text = prompt.lstrip()
    if text.startswith("You are "):
        for anchor in MEMBER_PROMPT_ANCHORS:
            at = text.rfind(anchor, 0, 2000)
            if at > 0:
                return ("You are (member)" + text[at:].split("\n")[0])[:70]
    return text.split("\n")[0][:70]


def _flag(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None or not value.strip():
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def parse_json_object(text: str) -> dict:
    """Parse one JSON object, tolerating a Markdown code fence around it."""
    if not isinstance(text, str):
        raise ValueError("Expected text")
    start = text.find("{")
    if start < 0:
        raise ValueError("Expected a JSON object")
    value, used = json.JSONDecoder().raw_decode(text[start:])
    if text[:start].strip().strip("`").strip().lower() not in {"", "json"}:
        raise ValueError("Unexpected leading model text")
    if text[start + used:].strip().strip("`").strip():
        raise ValueError("Unexpected trailing model text")
    if not isinstance(value, dict):
        raise ValueError("Expected a JSON object")
    return value


def reservation_cents(prompt: str, output_tokens: int) -> int:
    """Whole cents that cover one attempt: the message fee, the prompt and the whole output cap."""
    tokens = len(prompt.encode("utf-8")) / 3 + SYSTEM_PROMPT_TOKENS
    return math.ceil(MESSAGE_CENTS + tokens * INPUT_CENTS_PER_TOKEN + max(output_tokens, 0) * OUTPUT_CENTS_PER_TOKEN)


class SpendLedger:
    """A local subbudget for the writing agents, not an account wide ElevenLabs billing meter.

    Every attempt reserves its estimated cost before the request and keeps it, including failures. The stored cap
    survives restarts: an ordinary restart cannot enlarge it, only `authorize_increase` can.
    """

    def __init__(self, path, cap_cents: int = MAX_CAP_CENTS):
        if type(cap_cents) is not int or not 0 <= cap_cents <= MAX_CAP_CENTS:
            raise ValueError(f"The agent ledger permits at most {MAX_CAP_CENTS} US cents")
        self.path = str(path)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("CREATE TABLE IF NOT EXISTS settings(cap INTEGER, unlimited INTEGER NOT NULL DEFAULT 0)")
            if not db.execute("SELECT cap FROM settings").fetchone():
                db.execute("INSERT INTO settings(cap) VALUES (?)", (cap_cents,))
            stored, unlimited = db.execute("SELECT cap, unlimited FROM settings").fetchone()
            self.cap = min(cap_cents, stored)
            self.unlimited = bool(unlimited)
            db.execute("CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, cents INTEGER, usage TEXT)")
        Path(path).chmod(0o600)

    def authorize_unlimited(self) -> None:
        """Explicit user authorization: keep usage accounting without an app cap."""
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("UPDATE settings SET unlimited=1")
        self.unlimited = True

    def authorize_increase(self, new_cap_cents: int) -> None:
        """Explicit operator authorization only; never clears prior calls or usage."""
        if type(new_cap_cents) is not int or not 0 <= new_cap_cents <= MAX_CAP_CENTS:
            raise ValueError(f"The agent ledger permits at most {MAX_CAP_CENTS} US cents")
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("BEGIN IMMEDIATE")
            stored = db.execute("SELECT cap FROM settings").fetchone()[0]
            if new_cap_cents < stored:
                raise ValueError("An authorized increase cannot lower the stored agent cap")
            db.execute("UPDATE settings SET cap=?", (new_cap_cents,))
        self.cap = new_cap_cents

    def reserve(self, cents: int) -> str:
        if date.today() >= PRICE_REVIEW:
            raise AgentTextError("Agent pricing requires review before further paid calls")
        if type(cents) is not int or cents < 1:
            raise ValueError("A reservation is at least one cent")
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("BEGIN IMMEDIATE")
            used = db.execute("SELECT COALESCE(SUM(cents),0) FROM calls").fetchone()[0]
            if not self.unlimited and used + cents > self.cap:
                raise AgentTextError("Agent spending cap reached")
            ident = uuid.uuid4().hex
            db.execute("INSERT INTO calls VALUES (?,?,NULL)", (ident, cents))
        return ident

    def record(self, ident: str, usage: dict) -> None:
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("UPDATE calls SET usage=? WHERE id=?", (json.dumps(usage), ident))

    def status(self) -> dict:
        with closing(sqlite3.connect(self.path)) as db:
            used, count = db.execute("SELECT COALESCE(SUM(cents),0),COUNT(*) FROM calls").fetchone()
        return {"cap_usd": None if self.unlimited else self.cap / 100, "reserved_usd": used / 100,
                "remaining_usd": None if self.unlimited else max(0, self.cap - used) / 100, "attempts": count,
                "unlimited": self.unlimited,
                "note": "Local reservations, including failures; excludes other account spending."}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise AgentTextError("Unexpected ElevenLabs redirect refused")


def _tls_context() -> ssl.SSLContext:
    try:
        import truststore
        return truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    except ImportError:
        return ssl.create_default_context()


class _Warm:
    """A conversation opened ahead of its request. Its own thread answers pings while it waits; once claimed, the
    same thread hands every event to the claimer, so no event is read twice or lost in a handover."""

    def __init__(self, owner: "AgentSocket", agent_id: str):
        self.agent_id = agent_id
        self.born = time.monotonic()
        self.ready = threading.Event()
        self.dead = threading.Event()
        self.conversation = None
        # True only when it waited its whole time unused. A conversation that failed to open is never replaced at
        # once, or a network fault or rate limit would turn into a tight loop of new attempts.
        self.expired = False
        self._owner = owner
        self._claimed = False
        self._lock = threading.Lock()
        self._events: queue.Queue = queue.Queue()
        self._socket = None
        threading.Thread(target=self._run, name="agent-warm", daemon=True).start()

    def _run(self) -> None:
        try:
            connect = self._owner._connect
            if connect is None:
                from websockets.sync.client import connect
            signed = self._owner.signed_url(self.agent_id, 15)
            with connect(signed, ssl=self._owner.context, open_timeout=15, close_timeout=1, max_size=2 ** 22) as socket:
                self._socket = socket
                socket.send(json.dumps({"type": "conversation_initiation_client_data",
                                        "conversation_config_override": {"conversation": {"text_only": True}}}))
                self.ready.set()
                while not self.dead.is_set():
                    if not self._claimed and time.monotonic() - self.born > WARM_SECONDS:
                        with self._lock:
                            if not self._claimed:
                                self.expired = True
                                return  # Too old to trust; never used, so nothing was charged.
                    try:
                        event = json.loads(socket.recv(timeout=0.25))
                    except TimeoutError:
                        continue
                    kind = event.get("type")
                    if kind == "ping":
                        socket.send(json.dumps({"type": "pong", "event_id": event.get("ping_event", {}).get("event_id")}))
                    elif kind == "conversation_initiation_metadata":
                        self.conversation = event.get("conversation_initiation_metadata_event", {}).get("conversation_id")
                    elif self._claimed:
                        self._events.put(event)
        except Exception as error:
            self._events.put(error)
        finally:
            self.dead.set()
            self.ready.set()
            self._events.put(ConnectionError("The warm conversation closed"))
            self._owner._forget(self)

    def claim(self) -> bool:
        """Take this conversation for one request. False when it is not usable (still opening, closed or too old)."""
        with self._lock:
            if self._claimed or self.dead.is_set() or not self.ready.is_set() or self._socket is None:
                return False
            if time.monotonic() - self.born > WARM_SECONDS:
                return False
            self._claimed = True
            return True

    def send(self, prompt: str) -> None:
        self._socket.send(json.dumps({"type": "user_message", "text": prompt}))

    def next_event(self, timeout: float) -> dict:
        try:
            event = self._events.get(timeout=max(timeout, 0.01))
        except queue.Empty:
            raise TimeoutError("No agent answer in time") from None
        if isinstance(event, BaseException):
            raise event
        return event

    def close(self) -> None:
        self.dead.set()


class AgentSocket:
    """One text only conversation with a private ElevenLabs agent: signed URL, one user message, one answer."""

    def __init__(self, key: str, context: ssl.SSLContext | None = None, opener=None, connect=None, warm: bool = False):
        self._key = key
        self.context = context or _tls_context()
        self.opener = opener or urllib.request.build_opener(
            NoRedirect(), urllib.request.HTTPSHandler(context=self.context))
        self._connect = connect
        # Warm conversations are opt in (AgentText turns them on), so a bare socket opens nothing by itself.
        self.warm = warm
        self._warm: dict[str, list[_Warm]] = {}
        self._warm_lock = threading.Lock()
        self._last_request = 0.0

    def _forget(self, conversation: "_Warm") -> None:
        """A warm conversation ended. One that expired unused is replaced while requests are still recent."""
        with self._warm_lock:
            waiting = self._warm.get(conversation.agent_id, [])
            unused = conversation in waiting
            if unused:
                waiting.remove(conversation)
        if unused and conversation.expired and self.warm and time.monotonic() - self._last_request < KEEP_WARM_SECONDS:
            self.prime(conversation.agent_id)

    def prime(self, agent_id: str, count: int = 1) -> None:
        """Open conversations ahead so the next `count` requests to this agent skip the connection time."""
        if not self.warm:
            return
        with self._warm_lock:
            waiting = self._warm.setdefault(agent_id, [])
            for _ in range(min(count, MAX_WARM_PER_AGENT) - len(waiting)):
                waiting.append(_Warm(self, agent_id))

    def _take(self, agent_id: str) -> "_Warm | None":
        with self._warm_lock:
            waiting = self._warm.get(agent_id, [])
            # Oldest first: it has had the longest to finish opening.
            for conversation in list(waiting):
                if conversation.claim():
                    waiting.remove(conversation)
                    return conversation
        return None

    def close(self) -> None:
        with self._warm_lock:
            waiting = [conversation for group in self._warm.values() for conversation in group]
            self._warm.clear()
        for conversation in waiting:
            conversation.close()

    def signed_url(self, agent_id: str, timeout: float) -> str:
        url = f"{API}/v1/convai/conversation/get-signed-url?agent_id={urllib.parse.quote(agent_id, safe='')}"
        request = urllib.request.Request(url, headers={"xi-api-key": self._key})
        with self.opener.open(request, timeout=timeout) as response:
            signed = json.load(response).get("signed_url")
        # The signed URL is a credential for one conversation. Only the ElevenLabs conversation host is accepted.
        if not isinstance(signed, str) or not signed.startswith(SOCKET_PREFIX):
            raise AgentTextError("Unexpected ElevenLabs signed URL")
        return signed

    def events(self, agent_id: str, prompt: str, timeout: float):
        """Blocking generator: ("delta", text) for each streamed piece, then ("answer", text, usage) once."""
        start = time.monotonic()
        deadline = start + timeout
        self._last_request = start

        def remaining() -> float:
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError("No agent answer in time")
            return left

        warm = self._take(agent_id) if self.warm else None
        if self.warm:
            self.prime(agent_id)  # The next request gets a conversation that is already open.
        if warm is not None:
            sent = False
            try:
                warm.send(prompt)
                sent = True
                first = None
                while True:
                    event = warm.next_event(remaining())
                    kind = event.get("type")
                    if kind == "agent_chat_response_part":
                        part = event.get("text_response_part", {})
                        if part.get("type") == "delta" and isinstance(part.get("text"), str) and part["text"]:
                            if first is None:
                                first = round(time.monotonic() - start, 2)
                            yield ("delta", part["text"])
                    elif kind == "agent_response":
                        text = event.get("agent_response_event", {}).get("agent_response")
                        if not isinstance(text, str):
                            raise AgentTextError("Unexpected agent response")
                        yield ("answer", text, {"conversation_id": warm.conversation, "first_seconds": first,
                                                "seconds": round(time.monotonic() - start, 2), "warm": True})
                        return
                    elif kind == "client_error":
                        raise AgentTextError("The agent conversation reported an error")
            except (ConnectionError, OSError):
                if sent:
                    raise  # The message may have been read: the caller's backup request covers it.
                # The conversation closed while it waited: nothing was sent, so open a fresh one below.
            finally:
                warm.close()

        connect = self._connect
        if connect is None:
            from websockets.sync.client import connect
        signed = self.signed_url(agent_id, remaining())
        conversation = None
        first = None
        with connect(signed, ssl=self.context, open_timeout=remaining(), close_timeout=1, max_size=2 ** 22) as socket:
            socket.send(json.dumps({"type": "conversation_initiation_client_data",
                                    "conversation_config_override": {"conversation": {"text_only": True}}}))
            socket.send(json.dumps({"type": "user_message", "text": prompt}))
            while True:
                event = json.loads(socket.recv(timeout=remaining()))
                kind = event.get("type")
                if kind == "conversation_initiation_metadata":
                    conversation = event.get("conversation_initiation_metadata_event", {}).get("conversation_id")
                elif kind == "ping":
                    socket.send(json.dumps({"type": "pong", "event_id": event.get("ping_event", {}).get("event_id")}))
                elif kind == "agent_chat_response_part":
                    part = event.get("text_response_part", {})
                    if part.get("type") == "delta" and isinstance(part.get("text"), str) and part["text"]:
                        if first is None:
                            first = round(time.monotonic() - start, 2)
                        yield ("delta", part["text"])
                elif kind == "agent_response":
                    text = event.get("agent_response_event", {}).get("agent_response")
                    if not isinstance(text, str):
                        raise AgentTextError("Unexpected agent response")
                    yield ("answer", text, {"conversation_id": conversation, "first_seconds": first,
                                            "seconds": round(time.monotonic() - start, 2)})
                    return
                elif kind == "client_error":
                    raise AgentTextError("The agent conversation reported an error")

    def ask(self, agent_id: str, prompt: str, timeout: float) -> tuple[str, dict]:
        """Blocking. The agent's answer and a small usage record (conversation id and seconds)."""
        for event in self.events(agent_id, prompt, timeout):
            if event[0] == "answer":
                return event[1], event[2]
        raise AgentTextError("The agent conversation ended without an answer")


class AgentText:
    """Text and JSON written by ElevenLabs Agents: one conversation per attempt, no automatic retries inside one."""

    source = "agent"
    # text() and json() send their own backup requests, so callers need not hedge again.
    hedges = True

    def __init__(self, key: str | None = None, *, enabled: bool = True, ledger: str | Path = DEFAULT_LEDGER,
                 unlimited: bool = False, cap_cents: int = MAX_CAP_CENTS, agents: dict | None = None,
                 transport=None):
        self._key = key or ""
        self.agent_ids = {**AGENTS, **{role: ident for role, ident in (agents or {}).items() if ident}}
        self.enabled = bool(enabled and self._key and all(self.agent_ids.get(role) for role in AGENTS))
        self.ledger = Path(ledger)
        self.unlimited = unlimited
        self.cap_cents = cap_cents
        # transport(agent_id, prompt, timeout) -> (text, usage). Created lazily so constructing the app opens nothing.
        self._transport = transport
        # The real socket behind the default transport (None for an injected transport), for warm conversations.
        self._socket: AgentSocket | None = None
        self._budget = None
        self._lock = threading.Lock()
        self.last_error: str | None = None

    @classmethod
    def from_env(cls) -> "AgentText":
        key = os.getenv("ELEVENLABS_API_KEY") or ""
        cap = os.getenv("BOARDROOM_AGENTS_CAP_CENTS", str(MAX_CAP_CENTS))
        return cls(key, enabled=_flag("BOARDROOM_AGENTS_ENABLED", False),
                   ledger=os.getenv("BOARDROOM_AGENTS_LEDGER") or DEFAULT_LEDGER,
                   unlimited=_flag("BOARDROOM_AGENTS_UNLIMITED", False),
                   cap_cents=int(cap) if cap.isdigit() else MAX_CAP_CENTS,
                   agents={role: os.getenv(f"BOARDROOM_AGENT_{role.upper()}_ID", "").strip() for role in AGENTS})

    @property
    def configured(self) -> bool:
        return self.enabled

    def budget(self) -> SpendLedger:
        # Created lazily so constructing the app never touches disk.
        with self._lock:
            if self._budget is None:
                self._budget = SpendLedger(self.ledger, min(max(self.cap_cents, 0), MAX_CAP_CENTS))
                if self.unlimited and not self._budget.unlimited:
                    self._budget.authorize_unlimited()
            return self._budget

    def status(self) -> dict:
        return {"configured": self.configured, "provider": "ElevenLabs Agents", "model": MODEL,
                "agents": dict(self.agent_ids), "last_error": self.last_error}

    def _ask(self, agent_id: str, prompt: str, timeout: float) -> tuple[str, dict]:
        with self._lock:
            if self._transport is None:
                self._socket = AgentSocket(self._key, warm=_flag("BOARDROOM_AGENTS_WARM", True))
                self._transport = self._socket.ask
            transport = self._transport
        return transport(agent_id, prompt, timeout)

    def prime(self, role: str = "writer", count: int = 1) -> None:
        """A request to this agent is coming: open its conversation now. Free until a message is sent, never raises."""
        try:
            if not self.configured or role not in self.agent_ids:
                return
            with self._lock:
                if self._transport is None:
                    self._socket = AgentSocket(self._key, warm=_flag("BOARDROOM_AGENTS_WARM", True))
                    self._transport = self._socket.ask
                socket = self._socket
            if socket is not None:
                socket.prime(self.agent_ids[role], count)
        except Exception:
            pass

    def close(self) -> None:
        socket = self._socket
        if socket is not None:
            socket.close()

    def _check(self, prompt: str) -> None:
        if not self.configured:
            raise AgentTextError("The writing agents are not configured")
        if not isinstance(prompt, str) or not prompt or len(prompt.encode("utf-8")) > MAX_PROMPT_BYTES:
            raise ValueError("Agent input limit exceeded")

    @staticmethod
    def role_for(json_output: bool, temperature: float) -> str:
        if not json_output:
            return "writer"
        return "analyst" if temperature <= 0.2 else "drafter"

    def generate(self, prompt: str, *, json_output: bool = False, max_output_tokens: int = 1024,
                 timeout: float = 30, temperature: float = 0.4) -> str:
        """Blocking call. Never raises provider bodies or credentials."""
        self._check(prompt)
        role = self.role_for(json_output, temperature)
        budget = self.budget()
        ident = budget.reserve(reservation_cents(prompt, min(max_output_tokens, OUTPUT_CAPS[role])))
        started = time.monotonic()
        step = {"agent": role, "step": step_label(prompt), "prompt_bytes": len(prompt.encode("utf-8"))}
        try:
            text, usage = self._ask(self.agent_ids[role], prompt, timeout)
            if isinstance(usage, dict):
                budget.record(ident, {"agent": role, **usage})
            text = text.strip() if isinstance(text, str) else ""
            if not text:
                raise AgentTextError("The agent returned empty text")
            self.last_error = None
            timing.log("agent", **step, seconds=round(time.monotonic() - started, 2), words=len(text.split()),
                       first_seconds=usage.get("first_seconds") if isinstance(usage, dict) else None,
                       warm=bool(isinstance(usage, dict) and usage.get("warm")), ok=True)
            return text
        except urllib.error.HTTPError as error:
            self.last_error = f"ElevenLabs HTTP {error.code}"
            error.close()
            timing.log("agent", **step, seconds=round(time.monotonic() - started, 2), ok=False)
            raise AgentTextError(self.last_error) from None
        except Exception:
            self.last_error = "Agent request failed or returned invalid output"
            timing.log("agent", **step, seconds=round(time.monotonic() - started, 2), ok=False)
            raise AgentTextError(self.last_error) from None

    async def _hedged(self, call, timeout: float, marks: tuple[float, ...]):
        """First good result of call(remaining_seconds, attempt_index) from staggered attempts, within timeout.

        A hung attempt keeps its worker thread until its own socket timeout; nothing waits for it.
        """
        loop = asyncio.get_running_loop()
        start = loop.time()
        deadline = start + timeout
        starts = list(marks)
        pending: set[asyncio.Future] = set()
        last: BaseException | None = None
        try:
            while True:
                elapsed = loop.time() - start
                remaining = deadline - loop.time()
                if starts and remaining > 0.5 and (starts[0] <= elapsed or not pending):
                    starts.pop(0)
                    pending.add(asyncio.ensure_future(asyncio.to_thread(call, remaining, len(marks) - len(starts) - 1)))
                    continue
                if not pending:
                    raise last if isinstance(last, (AgentTextError, ValueError)) else AgentTextError("The agent gave no answer")
                if remaining <= 0:
                    self.last_error = "The agent timed out"
                    raise AgentTextError(self.last_error)
                wait = min(remaining, max(starts[0] - elapsed, 0)) if starts else remaining
                done, pending = await asyncio.wait(pending, timeout=wait, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    if task.exception() is None:
                        return task.result()
                    last = task.exception()
        finally:
            for task in pending:
                task.cancel()

    async def text(self, prompt: str, timeout: float = 30, max_output_tokens: int = 1024,
                   temperature: float = 0.4) -> str:
        """Short spoken text (agent lines, AI replies, coach questions), written by the writer agent."""
        self._check(prompt)
        return await self._hedged(lambda remaining, attempt: self.generate(
            prompt, max_output_tokens=max_output_tokens, timeout=remaining, temperature=temperature),
            timeout, TEXT_HEDGE_MARKS)

    async def json(self, prompt: str, timeout: float = 30, max_output_tokens: int = 2048,
                   temperature: float = 0.4) -> dict:
        # Private coaching and rubric scoring pass temperature 0 (the analyst agent) for repeatable behaviour; ballot
        # options and the quiz use the drafter. A malformed answer counts as a failed attempt, so a backup request
        # covers it.
        self._check(prompt)
        return await self._hedged(lambda remaining, attempt: parse_json_object(self.generate(
            prompt, json_output=True, max_output_tokens=max_output_tokens, timeout=remaining,
            temperature=temperature)), timeout,
            LONG_JSON_HEDGE_MARKS if max_output_tokens > OUTPUT_CAPS["analyst"] else JSON_HEDGE_MARKS)
