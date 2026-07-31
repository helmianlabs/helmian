# Mark hands test

This folder is the sandbox for proving the phone can actually build something.

It is the ONLY place a message from the phone can touch. `helmion relay --hands`
pins every turn to this directory, and the agent's tool layer confines paths to
the workspace root it is given, so a message cannot reach the rest of the disk by
asking politely.

## The test

Troy speaks to Mark. Mark sends a line through the relay. Helmion receives it and
does the work here.

    Create a file called hello.txt with the text "it works"

If `hello.txt` appears in this folder with those words, the whole loop is proven:
voice → phone → relay → desktop → agent → file on disk.

## What is still true while this runs

Every tool call the agent makes still passes the ordinary guard — the destructive
patterns, the write lease, the Tier-B rules. Nothing about hands mode weakens
them. The lane got wider; the gate did not move.

## Turning it off

Stop the relay, or run it without `--hands`. Plain `helmion relay` prints
messages and does nothing else, exactly as it did before 2026-07-31.
