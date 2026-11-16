"""Authenticated original turn recordings and independently reviewed transcripts."""

import asyncio
import base64
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import timedelta
import hashlib
import http.client
import json
import logging
import math
import os
import ssl
import subprocess
import shutil
import sqlite3
import threading
import time
from pathlib import Path
from typing import Callable
from uuid import UUID, uuid4

from .rooms import RoomError, Rooms, StartedGame
from . import simulation as sim
from . import gameplay
from .rules import valid_unicode

MAX_BYTES = 10_000_000
MIMES = {'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav', 'audio/x-wav'}
EXTENSIONS = {'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4', 'audio/wav': 'wav', 'audio/x-wav': 'wav'}
log = logging.getLogger('boardroom.recordings')


class ScribeError(Exception):
    """The provider answered with an error status. The response body is never kept: it can echo request details."""

    def __init__(self, status):
        super().__init__(f'Speech to text returned HTTP {status}')
        self.status = status


def failure(error):
    """A log safe reason: our own messages in full, anything else by type only (provider errors can carry bodies)."""
    return str(error) if isinstance(error, (ScribeError, ValueError)) else type(error).__name__


class ScribeClient:
    """ElevenLabs Scribe over HTTPS connections that are kept open between clips.

    Measured Nov 16 2026: opening a connection (DNS, TCP, TLS) took 0.25 to 0.5 seconds, about as long as Scribe
    itself needs for a short clip (0.45 to 0.9 seconds), and the first clip also paid 1.4 seconds to import
    truststore. So connections are reused, and while members are recording a spare one is kept ready in the
    background (a TLS handshake only; no provider request and no cost).
    """
    HOST = 'api.elevenlabs.io'
    IDLE_SECONDS = 60       # The provider kept idle connections for at least 90 seconds when measured.
    REFRESH_SECONDS = 35    # The spare is replaced once it is this old, well before it could go stale.
    KEEP_SECONDS = 900      # Keep a spare ready this long after the last sign that members are speaking.
    SPARES = 4

    # The longest dictation the browser allows (two minutes) took 2.65 seconds when measured, so 30 leaves room.
    def __init__(self, key, language='en', timeout=30, connect=None, clock=time.monotonic, spawn=None, sleep=time.sleep):
        if not key:
            raise ValueError('ELEVENLABS_API_KEY is not set')
        self.key, self.language, self.timeout = key, language, timeout
        self._connect, self._clock, self._sleep = connect or self._open, clock, sleep
        self._spawn = spawn or (lambda target: threading.Thread(target=target, name='scribe-keep-ready', daemon=True).start())
        self._lock = threading.Lock()
        self._idle = []  # (connection, parked at), newest last
        self._context = None
        self._active_until = -math.inf
        self._keeping = False

    def _open(self):
        if self._context is None:
            try:
                import truststore
                self._context = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            except ImportError:
                self._context = ssl.create_default_context()
        connection = http.client.HTTPSConnection(self.HOST, timeout=self.timeout, context=self._context)
        connection.connect()
        return connection

    def _alive(self, connection):
        """False once the provider has closed a parked connection, so a clip is never sent into a dead socket."""
        sock = getattr(connection, 'sock', None)
        if sock is None:
            return False
        try:
            sock.setblocking(False)
            try:
                sock.recv(1)  # An idle connection has nothing to read; data or end of stream means it is unusable.
                return False
            except (ssl.SSLWantReadError, BlockingIOError, InterruptedError):
                return True
            finally:
                sock.settimeout(self.timeout)
        except (OSError, ValueError):
            return False

    def _prune(self, now):
        fresh = []
        for connection, parked in self._idle:
            if now - parked <= self.IDLE_SECONDS:
                fresh.append((connection, parked))
            else:
                connection.close()
        self._idle = fresh

    def _take(self):
        with self._lock:
            self._prune(self._clock())
            while self._idle:
                connection, _ = self._idle.pop()
                if self._alive(connection):
                    return connection
                connection.close()
        return None

    def _park(self, connection):
        with self._lock:
            if len(self._idle) < self.SPARES:
                self._idle.append((connection, self._clock()))
                return
        connection.close()

    def touch(self):
        """A member is recording, dictating or reading transcripts: keep a connection ready. Never blocks."""
        with self._lock:
            self._active_until = self._clock() + self.KEEP_SECONDS
            if self._keeping:
                return
            self._keeping = True
        self._spawn(self._keep)

    def _keep(self):
        while True:
            with self._lock:
                now = self._clock()
                if now >= self._active_until:
                    self._keeping = False
                    return
                self._prune(now)
                ready = any(now - parked <= self.REFRESH_SECONDS for _, parked in self._idle)
            if not ready:
                try:
                    self._park(self._connect())
                except Exception as error:  # Only a spare: the next clip opens its own connection.
                    log.info('Speech to text spare connection failed: %s', type(error).__name__)
            self._sleep(10)

    def close(self):
        with self._lock:
            self._active_until = -math.inf
            idle, self._idle = self._idle, []
        for connection, _ in idle:
            connection.close()

    def transcribe(self, raw, mime):
        boundary = 'boardroom_' + uuid4().hex
        fields = {'model_id': 'scribe_v2', 'diarize': 'false', 'tag_audio_events': 'false', 'timestamps_granularity': 'none'}
        if self.language:
            # Without a hint Scribe guesses the language of every clip. A short English recording from a real
            # microphone was detected as Khmer (probability 0.39) and came back with full width punctuation.
            fields['language_code'] = self.language
        parts = [f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode() for name, value in fields.items()]
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="turn.{EXTENSIONS.get(mime, "webm")}"\r\n'
                     f'Content-Type: {mime}\r\n\r\n'.encode() + raw + b'\r\n')
        parts.append(f'--{boundary}--\r\n'.encode())
        body = b''.join(parts)
        headers = {'xi-api-key': self.key, 'Content-Type': 'multipart/form-data; boundary=' + boundary}
        connection = self._take()
        reused = connection is not None
        while True:
            if connection is None:
                connection = self._connect()
            try:
                connection.request('POST', '/v1/speech-to-text', body=body, headers=headers)
                break
            except TimeoutError:
                connection.close()
                raise
            except OSError:
                connection.close()
                if not reused:
                    raise
                # The kept connection closed while the clip was being written, so the provider never received a
                # complete request. This is not a paid retry. Failures after the clip is sent are never retried.
                connection, reused = None, False
            except BaseException:
                connection.close()
                raise
        try:
            response = connection.getresponse()
            data = response.read()
        except BaseException:
            connection.close()
            raise
        if response.status != 200 or response.will_close:
            connection.close()
        else:
            self._park(connection)
        if response.status != 200:
            raise ScribeError(response.status)
        return json.loads(data)['text']


@dataclass
class Recording:
    recording_id: UUID
    room_id: UUID
    member_id: UUID
    round_id: UUID
    round_number: int
    phase_id: UUID
    begun: float
    deadline: float
    started_at: object
    status: str = 'awaiting_audio'
    transcript: str = ''
    reviewed_text: str | None = None
    error: str | None = None
    mime_type: str | None = None
    digest: str | None = None
    audio_available: bool = False
    task: asyncio.Task | None = None
    duration_seconds: float | None = None
    submitted: float | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def view(self):
        return {key: getattr(self, key) for key in ('recording_id', 'member_id', 'round_number', 'phase_id',
                'status', 'transcript', 'reviewed_text', 'error', 'mime_type', 'audio_available')} | {
                    'round_id': self.round_id, 'started_at': self.started_at, 'duration_seconds': self.duration_seconds,
                    'ended_at': self.started_at + timedelta(seconds=self.duration_seconds) if self.duration_seconds is not None else None}


class Recordings:
    def __init__(self, rooms: Rooms, root: Path | None = None, transcriber: Callable | None = None,
                 touch: Callable | None = None):
        self.rooms = rooms
        self.root = root or Path(os.getenv('BOARDROOM_RECORDINGS_DIR', '.local/recordings'))
        self.transcriber = transcriber
        # Called (never blocking) when members record or read transcripts, so the provider connection is ready.
        self.touch = touch or (lambda: None)
        self.entries: dict[UUID, Recording] = {}
        self.commands: dict[tuple[str, UUID], UUID] = {}
        # Its own threads: the shared default pool is also used by multi second writing and speech calls, and a
        # small server has only a handful of those threads, so a clip could wait behind them.
        self.workers: ThreadPoolExecutor | None = None

    def _threaded(self, call, *values):
        if self.workers is None:
            self.workers = ThreadPoolExecutor(max_workers=4, thread_name_prefix='boardroom-stt')
        return asyncio.get_running_loop().run_in_executor(self.workers, call, *values)

    @classmethod
    def from_env(cls, rooms):
        transcribe = touch = None
        if os.getenv('BOARDROOM_STT_ENABLED') == 'true':
            try:
                cap = float(os.getenv('BOARDROOM_VOICE_BUDGET_USD', '0'))
                rate = float(os.getenv('BOARDROOM_STT_USD_PER_MINUTE', '0'))
                key = os.getenv('ELEVENLABS_API_KEY', '')
                ledger = os.getenv('BOARDROOM_TTS_LEDGER', '')
                language = os.getenv('BOARDROOM_STT_LANGUAGE', 'en').strip().lower()
                if language in ('', 'auto'):
                    language = None  # Scribe guesses the language of each clip.
                elif not (language.isascii() and language.isalpha() and len(language) in (2, 3)):
                    raise ValueError('BOARDROOM_STT_LANGUAGE must be a two or three letter language code, or auto')
                missing = [name for name, present in (
                    ('a positive BOARDROOM_VOICE_BUDGET_USD', math.isfinite(cap) and cap > 0),
                    ('a positive BOARDROOM_STT_USD_PER_MINUTE', math.isfinite(rate) and rate > 0),
                    ('ELEVENLABS_API_KEY', bool(key)), ('BOARDROOM_TTS_LEDGER', bool(ledger))) if not present]
                if missing:
                    raise ValueError('missing ' + ', '.join(missing))
                from rehearsal.voice import VoiceBudget
                budget = VoiceBudget(ledger, cap)
                client = ScribeClient(key, language)
                def convert(raw, mime):
                    budget.reserve('stt', rate)
                    return client.transcribe(raw, mime)
                transcribe, touch = convert, client.touch
                client.touch()  # Pays the slow first import and handshake now, not on the first member's clip.
            except (ValueError, OSError, sqlite3.Error) as error:
                # Earlier this was silent: Dictate and Mic then only ever said transcription was turned off.
                log.warning('BOARDROOM_STT_ENABLED is true but speech to text stays off: %s', failure(error))
                transcribe = touch = None
        return cls(rooms, transcriber=transcribe, touch=touch)

    async def begin(self, session, room_id, command_id, phase_id, round_id):
        room = self.rooms.require_room(room_id)
        self.touch()
        async with room.lock:
            member = room.member(session)
            now = self.rooms.clock()
            self.rooms.reconcile(room, now)
            previous = self.commands.get((session, command_id))
            if previous:
                item = self.entries[previous]
                if (item.room_id, item.phase_id, item.round_id) != (room_id, phase_id, round_id):
                    raise RoomError(409, 'command_conflict', 'Recording command was reused')
                return item.view()
            if not isinstance(room.phase, StartedGame):
                raise RoomError(409, 'not_started', 'Start the game first')
            state = room.phase.state
            phase = state.phase
            if not isinstance(phase, sim.SpeakingPhase) or phase.phase_id != phase_id or state.round_id != round_id:
                raise RoomError(409, 'stale_turn', 'Recording requires the current speaking turn')
            if gameplay.speaker_of(phase) != member.member_id:
                raise RoomError(403, 'speaker_required', 'Only the current speaker may record')
            existing = next((item for item in self.entries.values() if item.phase_id == phase_id and item.member_id == member.member_id), None)
            if existing:
                self.commands[(session, command_id)] = existing.recording_id
                return existing.view()
            item = Recording(uuid4(), room_id, member.member_id, round_id, state.round_number, phase_id,
                             now, min(phase.deadline if math.isfinite(phase.deadline) else now + 60,
                                      state.session_deadline or math.inf), gameplay.at(state, now))
            self.entries[item.recording_id] = item
            self.commands[(session, command_id)] = item.recording_id
            room.touch(session, now)
            return item.view()

    def require(self, session, room_id, recording_id, own=False):
        room = self.rooms.require_room(room_id)
        member = room.member(session)
        item = self.entries.get(recording_id)
        if item is None or item.room_id != room_id:
            raise RoomError(404, 'recording_not_found', 'Recording is unavailable')
        if own and item.member_id != member.member_id:
            raise RoomError(403, 'recording_owner_required', 'Only the recording owner can submit or review it')
        return item

    async def upload(self, session, room_id, recording_id, encoded, mime):
        item = self.require(session, room_id, recording_id, own=True)
        async with item.lock:
            return await self._upload(item, encoded, mime)

    async def _upload(self, item, encoded, mime):
        recording_id = item.recording_id
        mime = mime.split(';')[0].lower()
        if mime not in MIMES or len(encoded) > 13_333_336:
            raise RoomError(422, 'invalid_audio', 'Use supported audio up to 10 MB')
        try:
            raw = base64.b64decode(encoded, validate=True)
        except ValueError as error:
            raise RoomError(422, 'invalid_audio', 'Invalid audio encoding') from error
        signatures = {'audio/webm': raw.startswith(b'\x1aE\xdf\xa3'), 'audio/ogg': raw.startswith(b'OggS'),
                      'audio/mp4': len(raw) > 12 and raw[4:8] == b'ftyp',
                      'audio/wav': raw.startswith(b'RIFF') and raw[8:12] == b'WAVE',
                      'audio/x-wav': raw.startswith(b'RIFF') and raw[8:12] == b'WAVE'}
        if not 12 <= len(raw) <= MAX_BYTES or not signatures[mime]:
            raise RoomError(422, 'invalid_audio', 'Audio container does not match its type')
        digest = hashlib.sha256(raw).hexdigest()
        if item.digest:
            if item.digest != digest or item.mime_type != mime:
                raise RoomError(409, 'recording_frozen', 'Original audio cannot be replaced')
            return item.view()
        if self.rooms.clock() > item.deadline + 60:
            raise RoomError(409, 'recording_expired', 'The upload grace period has elapsed')
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root.chmod(0o700)
        path = self.root / (str(recording_id) + '.audio')
        # No await occurs between the immutable claim and atomic file replacement.
        temporary = path.with_suffix('.pending')
        temporary.write_bytes(raw)
        temporary.chmod(0o600)
        temporary.replace(path)
        item.digest, item.mime_type, item.audio_available = digest, mime, True
        item.submitted = self.rooms.clock()
        item.status = 'validating_audio'
        self.persist(item)
        item.task = asyncio.create_task(self._process(item, raw, path))
        return item.view()

    def _duration(self, path):
        binary = shutil.which('ffmpeg')
        if binary is None:
            raise ValueError('Install ffmpeg to validate browser recording duration')
        result = subprocess.run([binary, '-nostdin', '-v', 'error', '-i', str(path), '-t', '31',
                                 '-map', '0:a:0', '-f', 'null', '-', '-progress', 'pipe:1'],
                                capture_output=True, text=True, timeout=10, check=True)
        times = [int(line.split('=', 1)[1]) / 1_000_000 for line in result.stdout.splitlines() if line.startswith('out_time_us=')]
        duration = max(times, default=0)
        if not 0.1 <= duration <= 30.25:
            raise ValueError('Record 0.1 to 30 seconds')
        return duration

    def persist(self, item):
        data = item.view() | {'room_id': item.room_id, 'sha256': item.digest}
        path = self.root / (str(item.recording_id) + '.json')
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(data, default=str, indent=2))
        temporary.chmod(0o600)
        temporary.replace(path)

    async def _process(self, item, raw, path):
        try:
            item.duration_seconds = await self._threaded(self._duration, path)
            available = min(30, item.deadline - item.begun, item.submitted - item.begun)
            room = self.rooms.require_room(item.room_id)
            if isinstance(room.phase, StartedGame):
                completed = next((turn for turn in room.phase.state.turns if turn.phase_id == item.phase_id), None)
                if completed is not None:
                    available = min(available, (completed.ended_at - item.started_at).total_seconds())
            if item.duration_seconds > available + .25:
                raise ValueError('Audio extends past its authoritative speaking turn')
            if not self.transcriber:
                item.status = 'transcription_disabled'
                self.persist(item)
                return
            item.status = 'transcribing'
            await self._transcribe(item, raw)
        except Exception as error:
            # These are local checks (ffmpeg, duration, turn limits), so the reason is safe to log in full.
            log.warning('Recording %s failed validation: %s: %s', item.recording_id, type(error).__name__, error)
            item.status, item.error = 'audio_validation_failed', 'Audio could not be decoded or exceeds the allowed duration. Original bytes remain saved.'
        self.persist(item)

    async def _transcribe(self, item, raw):
        began = time.monotonic()
        try:
            text = await self._threaded(self.transcriber, raw, item.mime_type)
            if not isinstance(text, str) or not valid_unicode(text) or not text.strip() or len(text) > 12000:
                raise ValueError('Invalid transcript')
            item.transcript, item.status = text, 'review_required'
            log.info('Recording %s transcribed in %.2f s', item.recording_id, time.monotonic() - began)
        except Exception as error:
            log.warning('Recording %s was not transcribed after %.2f s: %s', item.recording_id, time.monotonic() - began, failure(error))
            item.status, item.error = 'transcription_failed', 'Transcription unavailable. Original audio remains saved.'

    async def dictate(self, session, room_id, encoded, mime):
        """Dictation: one short clip transcribed for the member and returned, nothing stored. The browser's own
        speech recognition is missing or silently fails in many browsers, so Dictate records audio and sends it here."""
        self.rooms.require_room(room_id).member(session)
        if not self.transcriber:
            raise RoomError(503, 'dictation_unavailable', 'Voice transcription is turned off on this server; type instead')
        self.touch()  # Private sessions dictate answer after answer: keep the connection ready for the next one.
        mime = mime.split(';')[0].lower()
        if mime not in MIMES or len(encoded) > 13_333_336:
            raise RoomError(422, 'invalid_audio', 'Use supported audio up to 10 MB')
        try:
            raw = base64.b64decode(encoded, validate=True)
        except ValueError as error:
            raise RoomError(422, 'invalid_audio', 'Invalid audio encoding') from error
        if not 12 <= len(raw) <= MAX_BYTES:
            raise RoomError(422, 'invalid_audio', 'Audio is empty or too large')
        began = time.monotonic()
        try:
            text = await self._threaded(self.transcriber, raw, mime)
        except Exception as error:
            # Provider errors can contain keys or response bodies, so only a safe reason is logged.
            log.warning('Dictation was not transcribed after %.2f s: %s', time.monotonic() - began, failure(error))
            raise RoomError(502, 'transcription_failed', 'Transcription is unavailable right now; type instead or try again') from None
        log.info('Dictation of %d bytes transcribed in %.2f s', len(raw), time.monotonic() - began)
        if not isinstance(text, str) or not valid_unicode(text) or len(text) > 12000:
            raise RoomError(502, 'transcription_failed', 'Transcription returned no usable text')
        return {'text': ' '.join(text.split())}

    async def review(self, session, room_id, recording_id, text):
        item = self.require(session, room_id, recording_id, own=True)
        if not isinstance(text, str) or not valid_unicode(text) or not 0 < len(text.strip()) <= 12000:
            raise RoomError(422, 'invalid_transcript', 'Review 1 to 12000 characters')
        if item.reviewed_text is not None:
            if item.reviewed_text != text:
                raise RoomError(409, 'transcript_frozen', 'Reviewed transcripts are immutable')
            return item.view()
        if item.status != 'review_required':
            raise RoomError(409, 'transcript_not_ready', 'Wait for transcription before reviewing')
        item.reviewed_text, item.status = text, 'reviewed'
        self.persist(item)
        return item.view()

    def audio(self, session, room_id, recording_id):
        item = self.require(session, room_id, recording_id)
        if not item.audio_available:
            raise RoomError(404, 'audio_not_ready', 'Audio has not been saved')
        return (self.root / (str(recording_id) + '.audio')).read_bytes(), item.mime_type

    def listing(self, session, room_id):
        self.rooms.require_room(room_id).member(session)
        self.touch()
        return [item.view() for item in self.entries.values() if item.room_id == room_id]

    async def close(self):
        pending = [item for item in self.entries.values() if item.task is not None and not item.task.done()]
        for item in pending:
            item.task.cancel()
        await asyncio.gather(*(item.task for item in pending), return_exceptions=True)
        for item in pending:
            item.status, item.error = 'processing_interrupted', 'Server stopped during processing. Original audio is retained; no paid retry was made.'
            if item.audio_available:
                self.persist(item)
        if self.workers is not None:
            self.workers.shutdown(wait=False, cancel_futures=True)
            self.workers = None
