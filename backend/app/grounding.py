"""Passage retrieval for AI replies: send the model the scenario passages most relevant to what is being said.

The reply prompt has room for about 2 KB of documents. Without retrieval it takes the opening of each document;
with retrieval it takes the passages that share the most distinctive words with the speaker's role, the latest
contributions or the coach's question. The ranking is plain word matching inside this process (rarer words count
for more): no network call, no cost and no provider. When nothing in the query matches the documents it returns
None and the caller falls back to the plain documents.
"""

import math
import re

PASSAGE_CHARACTERS = 480
WORD = re.compile(r"[a-z0-9]+(?:'[a-z]+)?")
# Common words that say nothing about which passage is relevant.
STOP = frozenset("""a about after all also an and any are as at be been before but by can could did do does for from
had has have he her his how i if in into is it its may me more most my no not of on one or our out she should so
some than that the their them then there these they this to up us was we were what when which who why will with
would you your""".split())


def passages(context: dict) -> list[tuple[str, str]]:
    """Split public documents and attached report sections into labelled passages of about 480 characters."""
    found: list[tuple[str, str]] = []
    sources = [(identity, text) for identity, text in context.get("documents", ())]
    for report in context.get("attached", ()):
        sources += [(f"{report['title']}: {title}", body) for title, body in report.get("sections", ())]
    for label, text in sources:
        words, part = " ".join(str(text).split()).split(" "), []
        for word in words:
            part.append(word)
            if sum(len(item) + 1 for item in part) >= PASSAGE_CHARACTERS:
                found.append((label, " ".join(part)))
                part = []
        if part and any(part):
            found.append((label, " ".join(part)))
    return found


def words(text: str) -> list[str]:
    """Lower case content words: stop words and single characters dropped, a plural s removed."""
    found = []
    for word in WORD.findall(text.lower()):
        word = word.split("'")[0]
        if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
            word = word[:-1]
        if len(word) > 1 and word not in STOP:
            found.append(word)
    return found


class Grounding:
    async def select(self, context: dict, query: str, limit: int = 2200) -> list[tuple[str, str]] | None:
        """The most relevant passages within `limit` characters, best first; None when retrieval is unavailable."""
        probe = set(words(query[:2000]))
        items = passages(context)
        if not probe or len(items) < 2:
            return None
        counts = [{} for _ in items]
        for index, (label, text) in enumerate(items):
            for word in words(f"{label} {text}"):
                counts[index][word] = counts[index].get(word, 0) + 1
        # A word found in fewer passages says more about which passage is meant.
        weight = {word: math.log(1 + len(items) / sum(1 for count in counts if word in count))
                  for word in probe if any(word in count for count in counts)}
        if not weight:
            return None
        scores = [sum(weight[word] * (1 + math.log(count[word])) for word in weight if word in count)
                  for count in counts]
        ranked = sorted(range(len(items)), key=lambda index: (-scores[index], index))
        chosen, used = [], 0
        for index in ranked:
            label, text = items[index]
            if scores[index] <= 0 or used + len(text) > limit:
                continue
            chosen.append((label, text))
            used += len(text)
        return chosen or None
