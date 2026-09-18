#!/usr/bin/env python3
"""DE/EN stopword-vote language detection, shared by the bilingual TTS engine.

Detection is a stopword vote, not a language model — deliberately. The input is
one or two sentences of the operator's own prose, and a marker count is right far
more often than it is wrong at that length. A tie falls back to German, which is
the working language of this vault.
"""

DE = set(
    """der die das den dem des und ist sind war nicht ein eine einen einem mit
für auf von zu im in ich du wir ihr sie es auch noch aber wie was wenn schon nur
oder als bei nach über vor durch um haben hat hatte werden wird kann soll muss
sich dass man mehr sehr hier jetzt heute morgen gestern kein keine bitte danke""".split()
)
EN = set(
    """the and is are was were to of in on for with that this it you we they
have has had will would can could should must not but or as at by from about
there their your our its been being do does did have's what when where which who
how why now today tomorrow yesterday please thanks""".split()
)


def pick(text):
    """Vote on the words present; ties and empty input fall back to German."""
    words = [w.strip(".,!?;:()[]\"'—–…").lower() for w in text.split()]
    de = sum(1 for w in words if w in DE)
    en = sum(1 for w in words if w in EN)
    # Umlauts and eszett are a strong, cheap German signal that stopwords miss in
    # short input ("Zahnarzttermine prüfen" has no stopword at all).
    if any(c in text for c in "äöüßÄÖÜ"):
        de += 2
    return "en" if en > de else "de"
