# Devlog: the lighthouse game, month 26

The new game is about restoring an automated lighthouse after the
keeper AI has quietly gone strange. Working title *Foghouse*. (The
title is the most stable system in the project.)

This month I ripped out the dialogue tree and replaced it with a
salience model — the keeper AI surfaces memories based on what you've
repaired recently, rather than walking a fixed tree. It's better. It
is also the third dialogue system this project has had, and I can hear
the *Attic Light* sticky note judging me from the monitor.

Technical notes:
- Salience scoring is embarrassingly simple: recency × a hand-tuned
  topic weight. I tried fancier. Simple read better in playtests.
- Playtest group is seven people; five said the fog shader made them
  feel "watched," which is exactly right, so the shader is done. I
  will not touch it. (I touched it twice since writing that sentence.)

Estimated completion: eighteen months, which historically means
thirty.
