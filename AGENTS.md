# Working in this repository

## Start with the source of truth

- Read `architecture-and-rules.md` before changing gameplay or room behavior. It is normative for the first release; `filipino-mahjong-rules.md` is broader background.
- The server is authoritative. The browser renders recipient snapshots and submits opaque server-provided `choiceId` values; it must not recreate Mahjong legality.
- Preserve recipient privacy. Never project another seat's concealed tiles, secret identity, or unresolved claim choice. Public claim progress contains only which seats responded.

## Repository shape

- This is an npm workspace: `shared` contains Zod wire contracts, `backend` contains the engine/room orchestration/Socket.IO server, and `frontend` is React/Vite.
- The engine stays pure: no Express, Socket.IO, browser APIs, or wall-clock timers.
- Room operations are serialized by the orchestrator. Humans and bots use the same authoritative action path.
- `RealtimeProvider` owns the frontend socket and snapshot ordering. Screens should not create connections or mutate authoritative snapshots. Hand ordering/selection is intentionally local UI state.
- Tiles are physical objects with unique `tileId` values. Preserve those IDs as React keys and when selecting, arranging, or describing combinations.

## Contracts and TypeScript

- Change shared schemas and inferred types together. Parse untrusted values at transport boundaries and keep schemas strict.
- The shared package exports compiled files from `shared/dist`; rebuild it after contract changes. Root test/dev scripts do this automatically.
- Backend/shared source uses ESM `.js` import specifiers. Frontend source uses bundler-resolved `.ts`/`.tsx` specifiers.

## Verification

Use the root commands:

```sh
npm run build
npm run lint
npm run typecheck
npm test
npm run test:e2e
```

- Vitest tests live beside source as `*.test.ts(x)`. Playwright tests live in `e2e/`.
- `npm test` backend integration tests and Playwright both open localhost sockets. In a restricted sandbox, `EPERM` on `127.0.0.1`, Vite's port, or the `tsx` IPC socket means the command needs local socket/listen permission; a Playwright web-server timeout may only be the symptom.
- Playwright expects ports 3000 and 5173 to be free and starts the app itself.
- Development-only table fixtures are exposed through `?preview=...` routes. Keep preview/state injection out of production behavior.

## Gameplay invariants worth remembering

- Turns proceed counterclockwise. Every discard waits for one final response from all three opponents; there are no human move timers.
- Human wins and optional melds are always explicit. Dealing, gifts, flower exposure, and flower replacement are automatic.
- A response is private and final. After acknowledgement, wait for authoritative resolution rather than allowing another choice or replaying on reconnect.

## Local tickets

- Work items are in the ignored `local/` directory. Completed tickets are moved to `local/done/`; these moves will not appear in `git status`.
- Preserve unrelated working-tree changes and keep tests focused on observable contracts and recipient-safe fixtures.
