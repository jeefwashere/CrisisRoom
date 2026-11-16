from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest
from playtest.speech import CreditBudget
from backend.app.agent_text import SpendLedger


class BudgetIncreaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_speech_explicit_increase_preserves_reservations_and_survives_restart(self):
        path = self.root/'speech.sqlite'
        original = CreditBudget(path, 10000)
        original.reserve('tts', 5382)
        restarted = CreditBudget(path, 30000)
        self.assertEqual(restarted.status()['cap'], 10000)
        restarted.authorize_increase(30000)
        self.assertEqual(restarted.status()['reserved'], 5382)
        self.assertEqual(restarted.status()['remaining'], 24618)
        self.assertEqual(CreditBudget(path, 30000).status()['cap'], 30000)
        self.assertEqual(CreditBudget(path, 5000).status()['cap'], 5000)
        with closing(sqlite3.connect(path)) as db:
            self.assertEqual(db.execute('SELECT operation,amount FROM credits').fetchall(), [('tts', 5382)])

    def test_agent_explicit_increase_preserves_calls_and_usage(self):
        path = self.root/'agents.sqlite'
        original = SpendLedger(path, 200)
        ident = original.reserve(5)
        original.record(ident, {'totalTokenCount': 14})
        restarted = SpendLedger(path, 2000)
        self.assertEqual(restarted.status()['cap_usd'], 2)
        restarted.authorize_increase(2000)
        self.assertEqual(restarted.status()['reserved_usd'], .05)
        self.assertEqual(restarted.status()['remaining_usd'], 19.95)
        self.assertEqual(SpendLedger(path, 2000).status()['cap_usd'], 20)
        self.assertEqual(SpendLedger(path, 100).status()['cap_usd'], 1)
        with closing(sqlite3.connect(path)) as db:
            row = db.execute('SELECT id,cents,usage FROM calls').fetchone()
            self.assertEqual(row, (ident, 5, '{"totalTokenCount": 14}'))

    def test_speech_invalid_or_lower_increases_do_not_mutate(self):
        path = self.root/'speech.sqlite'
        budget = CreditBudget(path, 10000)
        for invalid in (9999, -1, 30001, 30000.0, True, '30000', None):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                budget.authorize_increase(invalid)
        self.assertEqual(budget.status()['cap'], 10000)
        with self.assertRaises(ValueError):
            CreditBudget(self.root/'invalid.sqlite', 30001)
        budget.authorize_increase(10000)
        self.assertEqual(budget.status()['cap'], 10000)

    def test_agent_invalid_or_lower_increases_do_not_mutate(self):
        path = self.root/'agents.sqlite'
        budget = SpendLedger(path, 200)
        for invalid in (199, -1, 5001, 2000.0, True, '2000', None):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                budget.authorize_increase(invalid)
        self.assertEqual(budget.status()['cap_usd'], 2)
        with self.assertRaises(ValueError):
            SpendLedger(self.root/'invalid.sqlite', 5001)
        budget.authorize_increase(200)
        self.assertEqual(budget.status()['cap_usd'], 2)

    def test_stale_instances_cannot_lower_persisted_authorization(self):
        speech_path, agent_path = self.root/'speech.sqlite', self.root/'agents.sqlite'
        first, stale = CreditBudget(speech_path, 10000), CreditBudget(speech_path, 10000)
        first.authorize_increase(30000)
        with self.assertRaises(ValueError):
            stale.authorize_increase(20000)
        first, stale = SpendLedger(agent_path, 200), SpendLedger(agent_path, 200)
        first.authorize_increase(2000)
        with self.assertRaises(ValueError):
            stale.authorize_increase(1000)

    def test_explicit_unlimited_speech_preserves_usage_and_survives_restart(self):
        path=self.root/'speech.sqlite'
        budget=CreditBudget(path,10)
        budget.reserve('before',5)
        budget.authorize_unlimited()
        budget.reserve('after',50000)
        restarted=CreditBudget(path)
        self.assertTrue(restarted.status()['unlimited'])
        self.assertIsNone(restarted.status()['cap'])
        self.assertIsNone(restarted.status()['remaining'])
        self.assertEqual(restarted.status()['reserved'],50005)
        restarted.reserve('continued',1)
        with closing(sqlite3.connect(path)) as db:
            self.assertEqual(db.execute('SELECT operation,amount FROM credits').fetchall(),
                             [('before',5),('after',50000),('continued',1)])

    def test_explicit_unlimited_agent_keeps_every_call(self):
        path=self.root/'agents.sqlite'
        budget=SpendLedger(path,5)
        first=budget.reserve(5);budget.record(first,{'totalTokenCount':14})
        budget.authorize_unlimited()
        for _ in range(3):budget.reserve(5)
        restarted=SpendLedger(path,0)
        self.assertTrue(restarted.status()['unlimited'])
        self.assertIsNone(restarted.status()['cap_usd'])
        self.assertIsNone(restarted.status()['remaining_usd'])
        self.assertEqual(restarted.status()['attempts'],4)
        restarted.reserve(5)
        with closing(sqlite3.connect(path)) as db:
            self.assertEqual(db.execute('SELECT usage FROM calls WHERE id=?',(first,)).fetchone()[0],
                             '{"totalTokenCount": 14}')


if __name__ == '__main__':
    unittest.main()
