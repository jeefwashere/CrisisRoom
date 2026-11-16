"""Speech to text transport: request fields, kept connections, and no repeat of a clip the provider may have received."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.app.recordings import Recordings, ScribeClient, ScribeError, failure


class Sock:
    def __init__(self, closed_by_provider=False):
        self.closed_by_provider = closed_by_provider

    def setblocking(self, value):
        pass

    def settimeout(self, value):
        pass

    def recv(self, size):
        if self.closed_by_provider:
            return b''
        raise BlockingIOError


class Reply:
    def __init__(self, status=200, body=None, will_close=False):
        self.status, self.will_close = status, will_close
        self.body = json.dumps({'text': 'Preserve the logs.'}).encode() if body is None else body

    def read(self):
        return self.body


class Connection:
    def __init__(self, log, send_error=None, reply=None, reply_error=None):
        self.log, self.send_error, self.reply, self.reply_error = log, send_error, reply or Reply(), reply_error
        self.sock, self.requests, self.closed = Sock(), [], False

    def request(self, method, path, body=None, headers=None):
        if self.send_error:
            raise self.send_error
        self.requests.append((method, path, body, headers))
        self.log.append(self)

    def getresponse(self):
        if self.reply_error:
            raise self.reply_error
        return self.reply

    def close(self):
        self.closed = True


class Harness:
    def __init__(self, **options):
        self.now, self.sent, self.opened, self.queue = 0.0, [], [], []
        self.client = ScribeClient('secret-key', clock=lambda: self.now, connect=self.connect, spawn=lambda target: None, **options)

    def connect(self):
        connection = self.queue.pop(0) if self.queue else Connection(self.sent)
        self.opened.append(connection)
        return connection


class ScribeClientTests(unittest.TestCase):
    def test_request_names_english_the_real_container_and_no_timestamps(self):
        harness = Harness()
        self.assertEqual(harness.client.transcribe(b'\x1aE\xdf\xa3audio', 'audio/webm'), 'Preserve the logs.')
        method, path, body, headers = harness.sent[0].requests[0]
        self.assertEqual((method, path), ('POST', '/v1/speech-to-text'))
        self.assertEqual(headers['xi-api-key'], 'secret-key')
        for name, value in (('model_id', 'scribe_v2'), ('language_code', 'en'), ('timestamps_granularity', 'none'),
                            ('diarize', 'false'), ('tag_audio_events', 'false')):
            self.assertIn(f'name="{name}"\r\n\r\n{value}\r\n'.encode(), body)
        self.assertIn(b'filename="turn.webm"\r\nContent-Type: audio/webm\r\n\r\n\x1aE\xdf\xa3audio\r\n', body)
        harness.client.transcribe(b'RIFF', 'audio/x-wav')
        self.assertIn(b'filename="turn.wav"', harness.sent[1].requests[-1][2])

    def test_language_guessing_is_only_used_when_asked_for(self):
        harness = Harness(language=None)
        harness.client.transcribe(b'audio', 'audio/mp4')
        self.assertNotIn(b'language_code', harness.sent[0].requests[0][2])

    def test_one_connection_serves_consecutive_clips(self):
        harness = Harness()
        for _ in range(3):
            harness.client.transcribe(b'audio', 'audio/webm')
        self.assertEqual(len(harness.opened), 1)
        self.assertEqual(len(harness.opened[0].requests), 3)

    def test_a_connection_idle_too_long_or_closed_by_the_provider_is_replaced_before_sending(self):
        harness = Harness()
        harness.client.transcribe(b'audio', 'audio/webm')
        harness.now += ScribeClient.IDLE_SECONDS + 1
        harness.client.transcribe(b'audio', 'audio/webm')
        self.assertEqual(len(harness.opened), 2)
        self.assertTrue(harness.opened[0].closed)
        harness.opened[1].sock.closed_by_provider = True
        harness.client.transcribe(b'audio', 'audio/webm')
        self.assertEqual(len(harness.opened), 3)
        self.assertTrue(harness.opened[1].closed)
        self.assertEqual([len(item.requests) for item in harness.opened], [1, 1, 1])

    def test_a_clip_that_never_left_on_a_kept_connection_is_sent_once_on_a_new_one(self):
        harness = Harness()
        harness.client.transcribe(b'audio', 'audio/webm')
        harness.opened[0].send_error = BrokenPipeError()
        self.assertEqual(harness.client.transcribe(b'audio', 'audio/webm'), 'Preserve the logs.')
        self.assertEqual(len(harness.opened), 2)
        self.assertEqual(len(harness.sent), 2)  # the first clip, then exactly one delivery of the second

    def test_failures_after_the_clip_is_sent_are_never_repeated(self):
        harness = Harness()
        harness.client.transcribe(b'audio', 'audio/webm')
        harness.opened[0].reply_error = ConnectionResetError()
        with self.assertRaises(ConnectionResetError):
            harness.client.transcribe(b'audio', 'audio/webm')
        self.assertEqual(len(harness.opened), 1)
        self.assertTrue(harness.opened[0].closed)
        harness.queue.append(Connection(harness.sent, send_error=TimeoutError()))
        with self.assertRaises(TimeoutError):
            harness.client.transcribe(b'audio', 'audio/webm')
        harness.queue.append(Connection(harness.sent, send_error=BrokenPipeError()))
        with self.assertRaises(BrokenPipeError):  # a new connection that fails is a real failure, not a stale one
            harness.client.transcribe(b'audio', 'audio/webm')
        self.assertEqual(len(harness.opened), 3)

    def test_provider_error_status_is_reported_without_its_body_and_closes_the_connection(self):
        harness = Harness()
        harness.queue.append(Connection(harness.sent, reply=Reply(401, b'{"detail":"secret-key was rejected"}')))
        with self.assertRaises(ScribeError) as caught:
            harness.client.transcribe(b'audio', 'audio/webm')
        self.assertEqual(caught.exception.status, 401)
        self.assertNotIn('secret-key', failure(caught.exception))
        self.assertTrue(harness.opened[0].closed)
        self.assertEqual(failure(OSError('secret-key')), 'OSError')

    def test_a_spare_connection_is_kept_ready_only_while_members_are_active(self):
        harness = Harness(sleep=lambda seconds: setattr(harness, 'now', harness.now + seconds))
        spawned = []
        harness.client._spawn = spawned.append
        harness.client.touch()
        harness.client.touch()
        self.assertEqual(len(spawned), 1)  # one keeper however often members poll
        spawned[0]()  # runs until members have been quiet for KEEP_SECONDS
        self.assertGreaterEqual(harness.now, ScribeClient.KEEP_SECONDS)
        opened = len(harness.opened)
        self.assertGreaterEqual(opened, ScribeClient.KEEP_SECONDS // 60)
        self.assertLessEqual(opened, ScribeClient.KEEP_SECONDS // ScribeClient.REFRESH_SECONDS + 1)
        harness.client.transcribe(b'audio', 'audio/webm')
        self.assertEqual(len(harness.opened), opened)  # the clip used the spare: no handshake on the member's time
        harness.client.touch()
        self.assertEqual(len(spawned), 2)  # activity after a quiet spell starts keeping again

    def test_a_failed_spare_never_reaches_the_member(self):
        harness = Harness(sleep=lambda seconds: setattr(harness, 'now', harness.now + seconds))
        attempts = []
        def refuse():
            attempts.append(harness.now)
            raise OSError('network down')
        harness.client._connect = refuse
        spawned = []
        harness.client._spawn = spawned.append
        harness.client.touch()
        spawned[0]()
        self.assertGreater(len(attempts), 1)


class SpeechToTextConfigurationTests(unittest.TestCase):
    def configure(self, **values):
        folder = Path(self.enterContext(tempfile.TemporaryDirectory()))
        base = {'BOARDROOM_STT_ENABLED': 'true', 'BOARDROOM_VOICE_BUDGET_USD': '1', 'BOARDROOM_STT_USD_PER_MINUTE': '0.01',
                'ELEVENLABS_API_KEY': 'secret-key', 'BOARDROOM_TTS_LEDGER': str(folder / 'ledger.sqlite')}
        return patch.dict(os.environ, base | values), folder

    def test_a_missing_price_keeps_transcription_off_and_says_why_without_the_key(self):
        environment, _ = self.configure(BOARDROOM_STT_USD_PER_MINUTE='0')
        with environment, self.assertLogs('boardroom.recordings', 'WARNING') as logs:
            service = Recordings.from_env(None)
        self.assertIsNone(service.transcriber)
        self.assertIn('BOARDROOM_STT_USD_PER_MINUTE', logs.output[0])
        self.assertNotIn('secret-key', logs.output[0])

    def test_enabled_service_reserves_budget_once_per_clip_and_keeps_a_connection_ready(self):
        environment, folder = self.configure(BOARDROOM_STT_LANGUAGE='auto')
        with environment, patch.object(ScribeClient, 'touch') as touch, \
                patch.object(ScribeClient, 'transcribe', return_value='Preserve the logs.') as transcribe:
            service = Recordings.from_env(None)
            touch.assert_called_once()
            self.assertEqual(service.transcriber(b'audio', 'audio/webm'), 'Preserve the logs.')
            transcribe.assert_called_once_with(b'audio', 'audio/webm')
        import sqlite3
        rows = sqlite3.connect(folder / 'ledger.sqlite').execute('SELECT operation, cost FROM reservations').fetchall()
        self.assertEqual(rows, [('stt', 0.01)])

    def test_an_invalid_language_keeps_transcription_off(self):
        environment, _ = self.configure(BOARDROOM_STT_LANGUAGE='english please')
        with environment, self.assertLogs('boardroom.recordings', 'WARNING'):
            self.assertIsNone(Recordings.from_env(None).transcriber)


if __name__ == '__main__':
    unittest.main()
