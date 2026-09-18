# Shared realtime contracts

This package is the public wire boundary between the browser and the authoritative
server. Every untrusted payload must be parsed with its exported Zod schema before
use. The TypeScript types are inferred from those schemas; do not add separate
handwritten wire types or export engine/orchestrator state from this package.

## Command and freshness model

Clients send every operation through the `command` Socket.IO event. Every command
has a newly generated UUID `commandId`. The server keeps a bounded history per
session: a repeated ID returns the original acknowledgement with `duplicate: true`
and does not apply the operation again.

Rejected acknowledgements use `commandId: null` only when an invalid payload did
not contain a valid command UUID and therefore cannot be correlated safely. A
rejected acknowledgement for any successfully parsed command retains its UUID.

Freshness is scoped to what a command changes:

- Waiting-room configuration uses `expectedRoomRevision`.
- Readiness uses `readinessId`, which changes whenever the roster clears readiness.
- Game actions use `handId`, `phaseId`, and a legal `choiceId` issued to that player.
- Votes use `proposalId`.

In particular, discard responses and votes do not carry a snapshot revision.
Responses for the same unresolved phase and votes for the same active proposal
remain independently valid as other players respond.

## Guest credential transport

An unauthenticated socket may submit `session.bootstrap`. Its accepted
acknowledgement returns a reconnect credential. The browser stores that opaque
credential in local storage and supplies it only as
`auth.reconnectCredential` in later Socket.IO connection handshakes.

The credential must never appear in a URL, room or lobby snapshot, normal command,
application log, analytics event, or error detail. After successful authentication,
the server emits `session.ready` and then the complete current recipient snapshot.
When a newer socket authenticates for the same session, it becomes the sole active
controller; the former socket receives `session.superseded` and must no longer be
authorized to issue commands.

## Room entry inspection

An authenticated, unseated guest may use `room.inspect` with a normalized room
code before joining. Its `room-entry` result is deliberately limited to room
status, pause and occupancy counts, available bot seat numbers, and a four-seat
roster with human display names and connection state. Bots expose only whether
takeover is available. This is the same safe entry boundary for public discovery
and code-only unlisted rooms; it does not publish a recipient snapshot before
admission.

## Privacy boundary

Room snapshots are recipient-specific. Only `privateState` contains the recipient's
concealed tiles and legal choices. Other seats expose a concealed count. Secret
melds use their owner form only in the owner's projection and the masked four-tile
form everywhere else. A pending discard phase publishes only which seats have
responded, never their response kinds or selected tiles.

The public contracts intentionally contain no wall order, opponents' concealed
tiles, credentials, private bot state, or authoritative engine state.
