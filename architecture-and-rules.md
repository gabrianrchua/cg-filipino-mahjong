# First-Release Architecture and Rules

This document is the normative implementation reference for the first release of
Filipino Mahjong. The broader rules in
[filipino-mahjong-rules.md](./filipino-mahjong-rules.md) are the source for the
game. Where that source is optional, ambiguous, or describes features outside
this release, the decisions in this document control the engine and interface.

## Architecture

The application runs as one authoritative, long-lived Node process. It owns all
rooms, guest sessions, controllers, timers, and game state in memory. The first
release supports one process and one replica: restarting or replacing the
process loses active rooms and sessions.

The process is divided into these responsibilities:

- The **game engine** contains tile rules and hand transitions. It does not
  depend on Express, Socket.IO, browser APIs, or wall-clock timers. It accepts
  explicit actions and injected randomness, returns accepted or rejected
  transitions, and does not mutate its input when rejecting an action.
- The **room orchestrator** owns sessions, seats, readiness, pauses, votes,
  controller changes, expiry, and command ordering. It serializes human, bot,
  and lifecycle operations for each room before applying them to the engine.
- A **seat controller** is either a connected or reserved human session, or a
  bot. Human and bot controllers submit through the same authoritative action
  path and may choose only actions that the engine declares legal.
- The **transport layer** validates and authenticates commands, passes them to
  the orchestrator, and publishes the committed result. It contains no game
  rules.
- A **recipient view** is an allowlisted projection of authoritative state for
  one recipient. It can contain that player's concealed tiles and legal actions,
  public melds, flower tiles, discards, concealed counts, controller and
  connection state, and masked secrets. It must not contain the wall order,
  another player's concealed tiles, another player's secret identity, session
  credentials, private bot state, or unresolved claim choices.

The browser renders recipient views and submits declared choices. It does not
decide whether a hand, meld, claim, or discard is legal.

## Tiles, Seats, and Wall

Every room has four stable seats. Play and seat progression move
counterclockwise, to the player on the current player's right.

The set contains 144 uniquely identified physical tiles:

- 108 suited tiles: four copies of ranks 1 through 9 in each of sticks, balls,
  and characters.
- 36 flower tiles: every remaining standard-set tile, including winds, dragons,
  seasons, and conventional flowers. They all have the same rules category in
  this release.

Flowers never remain concealed and cannot be discarded or used in a meld or
winning decomposition. Whenever a player receives one, it is exposed
automatically and replaced from the back of the wall. Replacement continues
until the player receives a suited tile.

The shuffled tiles form one shared wall with a front and a back. Initial deals
and ordinary turn draws consume the front. Flower replacements and gifts
consume the back. The two ends never overlap and a physical tile can be
consumed only once. If the required end cannot supply a tile because the ends
have met, the hand immediately ends as an exhaustion draw. This rule applies
during the initial deal, an initial replacement chain, an ordinary draw, a gift,
or a flower replacement after a gift.

## Hand Setup and Phases

The initial dealer is selected uniformly at random from the four seats. The
shuffled wall may also be produced from injected randomness for deterministic
tests.

Setup proceeds automatically:

1. Starting with the dealer and moving counterclockwise, deal eight tiles to
   each player from the front of the wall.
2. Repeat that eight-tile round, giving every player 16 tiles.
3. Give the dealer a seventeenth tile from the front as the dealer's first draw.
4. Expose and replace flowers from the back, starting with the dealer and moving
   counterclockwise. Finish each player's entire replacement chain before
   continuing to the next seat.
5. If setup has not exhausted the wall, enter the dealer's action phase. The
   dealer may declare a win or another legal action, or discard without drawing
   again.

The engine uses the following hand phases. A room pause can prevent progress in
any active engine phase but does not replace or discard the engine phase.

| Phase | Allowed progression |
| --- | --- |
| Setup | Deal, expose flowers, and perform replacements automatically; then enter the dealer's action phase or end in an exhaustion draw. |
| Player action | The acting player may manually declare a legal win, secret, or sagása, or discard a suited concealed tile. Automatic gift and flower draws complete before another choice is requested. |
| Discard responses | Each of the three opponents submits one final claim or pass. Resolve only after all three responses, then end the hand, transfer action to a claimant, or advance to the next draw. |
| Hand ended | Record a win, exhaustion draw, or abort and the next dealer. Return the room to between-hand readiness without changing its seats. |

After an unclaimed discard, it remains dead in the discard area. The next seat
counterclockwise draws automatically from the front, including mandatory flower
replacement, and then enters its action phase. A player who takes a discard for
a non-winning meld enters their action phase without an ordinary front draw;
an open káng receives its required back-wall gift first.

Dealing, ordinary draws, gifts, and every flower replacement are automatic.
Human wins and optional melds are never declared automatically. Bots explicitly
choose from their legal actions through their controller.

## Melds and Discard Claims

A **chow** is three consecutive ranks of one suit. A **pong** is three identical
suited tiles. A **káng** is four identical suited tiles. A declared four-tile
meld uses four physical tiles but counts as one meld when validating a win.

An open chow, pong, or káng uses the latest discard plus selected concealed
tiles. Once declared, an open meld is locked except for the specific sagása rule
below. An open káng receives a gift from the back of the wall; flowers found in
that gift chain are exposed and replaced from the back.

Every discard creates a response phase for all three opponents, including
players whose only legal response is pass. A response is final, there is no
claim deadline, and resolution waits for all three responses. While responses
are pending, other recipients may learn who has responded but not whether that
response was a pass or a claim, nor which concealed tiles were selected.

Claims resolve independently of arrival order:

1. A winning claim has priority over every meld claim.
2. A pong or open-káng claim has priority over a chow claim.
3. A non-winning chow is available only to the next seat counterclockwise after
   the discarder.
4. If multiple players claim a win, the winner is the first claimant encountered
   counterclockwise after the discarder.

A discarded tile may complete any required part of a winning hand, including a
pair, chow, or pong, for any opponent. The non-winning chow restriction does not
restrict a winning claim.

### Secret and sagása

A **secret** is a concealed káng. A player may declare one only during their own
action phase while all four matching suited tiles are in their concealed hand.
The four tiles become one locked meld and the player takes a gift from the back.
Other players can see that a four-tile secret meld exists, but not its tile
identity. The owner retains its identity in their private view.

**Sagása** upgrades an existing open pong to a four-tile meld. It is legal only
during the owner's action phase and only when the matching fourth tile is the
tile that player just drew. A matching tile retained from an earlier draw cannot
be used. A discarded fourth tile cannot extend the pong. The upgrade changes
the existing meld rather than creating another, and it is followed by a gift
from the back. This release has no rule for robbing a káng or sagása.

## Winning Hands

The player must explicitly declare a win while the engine offers it as a legal
action or discard response.

An **ordinary win** consists of five melds and one pair. Each meld is a chow,
pong, open káng, secret, or sagása meld. Every declared four-tile meld counts as
one of the five melds even though it contains an extra physical tile. Existing
declared melds are fixed; the engine decomposes the remaining concealed suited
tiles into the number of melds still needed plus one pair. It must explore all
valid decompositions when repeated ranks admit more than one arrangement.

The alternate **seven pairs plus a pong** win uses a fully concealed 17-tile
suited hand. Its tiles must have a disjoint decomposition into seven pairs and
one pong, with no declared melds. Four identical tiles may form two of the
pairs. The pong and pairs together must consume all 17 physical tiles exactly
once.

A win can use the dealer's opening tile, an ordinary front-wall draw, a suited
tile at the end of a replacement or gift chain, or another player's discard.
The outcome records the winner, the winning tile and source, and one valid
decomposition. There is no scoring or payout calculation in this release.

## Hands, Dealers, and Readiness

The room plays an open-ended sequence of hands rather than a fixed number of
wind rounds.

- If the dealer wins, that seat remains dealer.
- If another seat wins, the dealer advances one seat counterclockwise.
- After an exhaustion draw, the dealer advances one seat counterclockwise.
- After an aborted hand, the dealer does not advance.

After every win, draw, or abort, all seated human players become unready. Every
connected seated human must explicitly ready up before the next hand. Bots are
always ready. A reserved but disconnected human seat blocks a start until its
owner reconnects or the connected humans unanimously replace it with a bot.

## Rooms, Controllers, and Disconnections

Rooms are hostless. All seated humans have the same permission to change
waiting-room settings, configure bot seats, ready themselves, and initiate or
vote on eligible collective decisions. There is no owner or host privilege.
Rooms contain one to four humans and use bots for the other occupied seats;
spectators are not supported.

Changing the waiting-room seat roster clears every human's readiness. An
explicit leave in the waiting room vacates that human's seat and also resets
readiness. A transient waiting-room disconnect reserves the human's seat and
prevents the hand from starting until that player returns or is unanimously
replaced.

A disconnect or explicit leave during a hand preserves the human seat and
pauses gameplay and bot scheduling. Existing engine state, including submitted
discard responses, remains intact. The connected seated humans may wait,
propose aborting the hand, or propose replacing a specific disconnected seat
with a bot.

Only one collective proposal is active at a time. The proposer approves it
automatically, and every currently connected seated human must approve for it
to commit. One connected human can therefore approve alone; with no connected
humans, no proposal can pass. A rejection cancels the proposal. Any change to
the connected-human roster, including another disconnect, a return, or a human
taking over a bot, cancels the current proposal and its votes.

Replacing multiple disconnected players is handled one seat at a time. The room
remains paused until every reserved disconnected seat has either returned or
been replaced. An approved abort ends the current hand, preserves the dealer,
and returns the room to between-hand readiness.

An authenticated, unseated guest may request control of an available bot seat.
Control transfers between serialized actions and preserves the seat's tiles,
melds, flowers, position, and dealer status. If a discard-response phase is
active, the takeover is reserved and commits only after that phase resolves;
the bot remains responsible for any response needed from its seat. Private seat
state is sent to the guest only after the transfer commits. A previously
replaced human has no special claim on their old seat.

When the last connected human leaves or disconnects, all room execution pauses
and a 15-minute expiration period starts, even if bots occupy seats. A human
reconnect or successful bot-seat takeover cancels that expiration. If no human
connects before it expires, the process deletes the room and its associated
state. A later reconnect receives an expired or not-found outcome and returns
to the lobby rather than recreating the room.

## First-Release Interpretations

These decisions intentionally narrow or clarify the source rules:

| Source topic | First-release interpretation |
| --- | --- |
| Flower replacement is described as optional during setup. | Flower exposure and replacement are mandatory during setup and every later draw. |
| The physical wall is broken using dice and wall segments. | Software shuffles one wall and tracks non-overlapping front and back consumption; no wall-break dice simulation is required. |
| The alternate win is introduced as “seven pairs.” | It is exactly a fully concealed 17-tile decomposition into seven pairs plus a pong; a four-of-a-kind may supply two pairs. |
| Dealer choice can use winds or dice, and play is described in finite rounds. | The first dealer is random, hands continue without a round limit, and dealer progression follows the outcome rules above. |
| A discarded tile must be claimed immediately. | All opponents submit a final claim or pass with no timer; the server resolves after all three respond. |
| The source focuses on physical declarations and dealing. | Humans manually declare wins and optional melds; software automatically performs dealing, draws, gifts, and flower replacement. |
| Scoring, doubles, jai alai, and jokers are described. | Scoring and payouts, finite wind rounds, jai alai or other pots, doubles, and jokers are deferred. |

Accounts, spectators, and chat are also deferred. Guest reconnect credentials
exist only to restore session and seat control; they are not accounts.

## Phase Walkthroughs

### Regular hand

The dealer receives the first draw during setup and enters the player-action
phase. The dealer discards a suited tile. All three opponents pass, so the
discard becomes dead. The next player counterclockwise draws from the front;
after any automatic flower replacement, that player may manually win, declare a
legal secret or sagása, or discard. This draw, response, and action cycle
continues until a win or wall exhaustion.

### Competing wins

A player discards a tile that completes winning hands for two opponents. All
three opponents still respond, and neither pending winning choice is revealed.
After the last response, both winning claims outrank any pong, káng, or chow.
The claimant nearest to the discarder in counterclockwise order wins. The dealer
stays only when that selected claimant is the dealer; otherwise the dealer
advances counterclockwise.

### Replacement chain

A player declares an open káng and consumes its claimed discard exactly once.
The gift from the back is a flower, so it is exposed and another back tile is
taken. A second flower is exposed in the same way. The next suited tile becomes
the player's current drawn tile, preserving gift provenance for a possible
self-drawn win and for sagása eligibility. If the wall ends anywhere in this
chain, the hand ends as an exhaustion draw and the dealer advances.

### Alternate win

A player with no declared melds draws a suited tile and now has 17 concealed
suited tiles. The engine finds a disjoint decomposition into seven pairs and a
pong; four equal tiles may account for two of those pairs. The player must still
choose the offered win action. The result records the decomposition and draw
source, and the dealer is retained only if that player was the dealer.

### Aborted hand

A human disconnects during a discard-response phase. The room pauses without
clearing responses already submitted. A connected human proposes an abort and
all currently connected seated humans approve. The hand ends as aborted, its
dealer remains unchanged, and every human becomes unready. The room can start
another hand only after all reserved disconnected seats return or are replaced
and all connected seated humans ready up again.
