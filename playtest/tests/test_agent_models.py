from concurrent.futures import ThreadPoolExecutor
import io
import json
from pathlib import Path
import tempfile
import unittest
import urllib.error

from backend.app.agent_text import AGENTS, MODEL, AgentTextError, SpendLedger
from playtest.agent_models import AgentModels


class Socket:
    """Scripted agent conversation: no network."""

    def __init__(self, text='{"ready":true}', error=None, pieces=None, finish=True):
        self.text, self.error, self.pieces, self.finish, self.calls = text, error, pieces, finish, []

    def events(self, agent_id, prompt, timeout):
        self.calls.append((agent_id, prompt))
        if self.error:
            raise self.error
        for piece in self.pieces or ():
            yield ('delta', piece)
        if self.finish:
            yield ('answer', self.text, {'conversation_id': 'conv_test', 'seconds': 0.1})

    def ask(self, agent_id, prompt, timeout):
        for event in self.events(agent_id, prompt, timeout):
            if event[0] == 'answer':
                return event[1], event[2]
        raise AgentTextError('no answer')


class AgentModelTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def test_analyst_agent_answers_and_health_never_spends(self):
        socket = Socket()
        p = AgentModels('test-secret', self.temp.name, socket=socket)
        self.assertFalse(p.request('/api/status')['verified'])
        self.assertEqual(socket.calls, [])  # health never spends
        result = p.run('Return a ready JSON object')
        self.assertEqual(socket.calls[0][0], AGENTS['analyst'])
        self.assertEqual(result['model'], MODEL)
        self.assertEqual(result['provider'], 'elevenlabs-agents')
        self.assertEqual(result['usage']['conversation_id'], 'conv_test')
        self.assertTrue(p.request('/api/status')['verified'])

    def test_temperature_picks_the_agent_and_is_validated(self):
        socket = Socket(); provider = AgentModels('test-secret', self.temp.name, socket=socket)
        provider.run('Return JSON', temperature=0)
        provider.run('Return JSON', temperature=0.3)
        self.assertEqual([call[0] for call in socket.calls], [AGENTS['analyst'], AGENTS['drafter']])
        with self.assertRaises(ValueError): provider.run('Return JSON', temperature=True)
        self.assertEqual(len(socket.calls), 2)

    def test_extraction_requires_literal_source_spans_and_does_not_invent_scores(self):
        text = 'Jeff will call IT before 3 PM. Is the backup verified?'
        obj = {'kind': 'mixed', 'spans': [{'label': 'person', 'text': 'Jeff'},
               {'label': 'deadline', 'text': '3 PM'}, {'label': 'person', 'text': 'Alice'},
               {'label': 'secret', 'text': 'backup'}, {'label': 'action', 'text': ''}]}
        p = AgentModels('test-secret', self.temp.name, socket=Socket(json.dumps(obj)))
        result = p.run(text, model='extract')
        self.assertEqual(result['kind'], 'mixed')
        self.assertEqual(len(result['spans']), 2)
        for span in result['spans']:
            self.assertEqual(text[span['start']:span['end']], span['text'])
            self.assertIsNone(span['raw_score'])

    def test_atomic_budget_persists_and_does_not_expand_on_restart(self):
        path = Path(self.temp.name) / 'budget.sqlite'
        budget = SpendLedger(path, 100)
        def attempt(_):
            try:
                budget.reserve(5)
                return True
            except AgentTextError:
                return False
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(attempt, range(40)))
        self.assertEqual(sum(results), 20)
        restarted = SpendLedger(path, 200)
        self.assertEqual(restarted.status()['cap_usd'], 1)
        self.assertEqual(restarted.status()['reserved_usd'], 1)
        with self.assertRaises(AgentTextError):
            restarted.reserve(1)

    def test_error_is_sanitized_reserved_and_never_retried(self):
        error = urllib.error.HTTPError('https://api.elevenlabs.io/x', 403, 'test-secret', {}, io.BytesIO(b'test-secret'))
        socket = Socket(error=error)
        p = AgentModels('test-secret', self.temp.name, socket=socket)
        with self.assertRaises(AgentTextError) as caught:
            p.run('Return JSON')
        self.assertNotIn('test-secret', str(caught.exception))
        self.assertEqual(len(socket.calls), 1)
        self.assertEqual(p.budget.status()['reserved_usd'], .02)
        self.assertFalse(p.request('/api/status')['online'])

    def test_invalid_outputs_fail_and_oversize_input_never_spends(self):
        socket = Socket('not JSON')
        p = AgentModels('test-secret', self.temp.name, socket=socket)
        with self.assertRaises(ValueError):
            p.run('x'*20001)
        self.assertEqual(p.budget.status()['attempts'], 0)
        with self.assertRaises(AgentTextError):
            p.run('Return JSON')
        self.assertEqual(p.budget.status()['attempts'], 1)

    def test_stream_yields_pieces_from_the_writer_and_reserves_once(self):
        socket = Socket('First. Second.', pieces=['First. ', 'Second.'])
        provider = AgentModels('test-key', self.temp.name, socket=socket)
        self.assertEqual(list(provider.stream('A prompt')), ['First. ', 'Second.'])
        self.assertEqual(socket.calls[0][0], AGENTS['writer'])
        self.assertEqual(provider.budget.status()['attempts'], 1)
        self.assertEqual(provider.budget.status()['reserved_usd'], .01)

    def test_incomplete_stream_fails_without_automatic_retry(self):
        socket = Socket(pieces=['Partial'], finish=False)
        provider = AgentModels('test-key', self.temp.name, socket=socket)
        with self.assertRaises(AgentTextError): list(provider.stream('Prompt'))
        self.assertEqual(len(socket.calls), 1)
        self.assertEqual(provider.budget.status()['attempts'], 1)

    def test_missing_key_never_spends(self):
        provider = AgentModels('', self.temp.name, socket=Socket())
        with self.assertRaises(AgentTextError): provider.run('Return JSON')
        with self.assertRaises(AgentTextError): list(provider.stream('Prompt'))
        self.assertEqual(provider.budget.status()['attempts'], 0)


if __name__ == '__main__':
    unittest.main()
