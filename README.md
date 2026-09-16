# Filipino Mahjong

This repository is an npm workspace containing the Express backend, React/Vite
frontend, and public shared TypeScript contracts.

## Install

Use the Node and npm versions recorded in the root `package.json`, then install
exactly from the lockfile:

```sh
npm ci
```

Install Chromium once before running browser tests:

```sh
npx playwright install chromium
```

On CI or Linux hosts that also need browser system dependencies, use:

```sh
npx playwright install --with-deps chromium
```

## Development

Start the shared-contract compiler, backend, and frontend together:

```sh
npm run dev
```

The frontend runs at `http://localhost:5173` and proxies both `/api` and
`/socket.io` traffic to the backend on port 3000. The browser uses relative
same-origin URLs; no backend URL or deployment credential is compiled into the
frontend bundle.

## Production deployment

Build and run the application from the repository root:

```sh
npm ci
npm run build
NODE_ENV=production HOST=0.0.0.0 PORT=3000 npm start
```

The one Node process serves the built frontend, `/api/health`, and Socket.IO.
The supported environment variables are shown in `.env.example`:

- `PORT` is the HTTP/WebSocket port and defaults to `3000`.
- `HOST` is the listen address and defaults to `0.0.0.0`.
- `CORS_ORIGIN` is optional. Leave it unset for the normal same-origin
  deployment. A comma-separated allowlist is available for split-origin local
  development.
- `BOT_DECISION_DELAY_MS` optionally changes the bot delay.

Environment values are read only by the Node process. Do not expose secrets as
Vite variables; this application does not require any production value in the
browser bundle.

### Container image

The repository includes a multi-stage Docker build using the pinned Node 24
release. It compiles all three workspaces, installs production-only dependencies
in the runtime stage, runs as the unprivileged `node`
user, and checks `/api/health` from inside the container.

```sh
docker build -t cg-filipino-mahjong .
docker run --rm --name cg-filipino-mahjong -p 3000:3000 cg-filipino-mahjong
```

Set runtime configuration with `docker run -e NAME=value`; do not pass secrets
as build arguments. If `PORT` is changed, publish the same container port, for
example `-e PORT=8080 -p 8080:8080`. Stop the container normally so Docker sends
`SIGTERM` and the service can close sockets and timers cleanly. Run exactly one
container replica and do not attach a volume expecting game persistence—the
service remains intentionally memory-only.

For a Docker Compose example with the same single-replica constraints:

```sh
docker compose up --build -d
docker compose ps
docker compose logs -f app
docker compose down
```

The Compose example publishes port 3000 by default. Set `APP_PORT` to change
only the host-side port:

```sh
APP_PORT=8080 docker compose up --build -d
```

It also enables log rotation, a read-only filesystem, dropped Linux
capabilities, an init process, and a 15-second graceful-stop window. Do not use
`docker compose up --scale app=...`; all rooms and sessions remain local to one
process.

### Runtime constraints

This release supports exactly one long-running process and one replica. Rooms,
guest sessions, command history, and timers live only in that process. Do not
enable horizontal replicas or round-robin traffic: there is no shared storage
or cross-process Socket.IO adapter. A restart, deploy, crash, or replacement
loses every active game and guest session.

An old room link normally returns `room-not-found` after a full process restart,
because expired-room tombstones are also in memory. A room that expires after
15 minutes with no connected human while the process remains running returns
`room-expired`.

Use a service class that remains awake for the duration of a game. Idle
suspension or scale-to-zero can terminate active rooms even when connected
players expect to continue.

### TLS and reverse proxies

Terminate TLS at the platform or reverse proxy and forward both ordinary HTTP
and WebSocket upgrade requests to the same process. In particular, preserve the
`Upgrade` and `Connection` headers for `/socket.io`; routing only `/api` is not
sufficient. Keep frontend navigation, `/api`, and `/socket.io` on the same
public origin unless `CORS_ORIGIN` is deliberately configured.

The process handles `SIGTERM` and `SIGINT` by clearing game/lifecycle timers,
disconnecting realtime clients, and closing the HTTP listener. Deployment
systems should send `SIGTERM` and allow at least 10 seconds before forcibly
killing the process.

Operational events are emitted as one JSON object per line on stdout. They use
allowlisted event fields and omit reconnect credentials, names, command
payloads, snapshots, hands, tile identities, unresolved choices, and wall
state. Provider log drains should retain these lines without adding request
bodies or Socket.IO payload capture.

### Production smoke check

With the built service running, verify health and frontend history fallback:

```sh
curl --fail http://127.0.0.1:3000/api/health
curl --fail -H 'Accept: text/html' http://127.0.0.1:3000/room/234567
```

Then open two independent browser profiles, create a room in one, follow its
room URL in the other, and join the open seat. Confirm both browsers update over
Socket.IO. Send `SIGTERM`, confirm `server.shutdown_completed` is logged, start
a fresh process, and confirm the previous room URL is reported as unavailable
with a not-found outcome. Review the captured JSON logs and ensure no guest
credential, concealed hand, choice payload, or wall data appears.

The same single-process browser check is automated with:

```sh
npm run test:smoke
```

## Verification

The quick checks do not launch a browser:

```sh
npm run build
npm run lint
npm run typecheck
npm test
```

Run Vitest interactively while developing with `npm run test:watch`.

The complete verification also includes the Chromium startup and health smoke
test:

```sh
npm run build
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run test:smoke
```

Playwright starts and stops the application servers for its suite. The regular
suite needs ports 3000 and 5173; the production smoke uses port 3000 only.

If Playwright times out waiting for its web server, inspect the startup output
for local binding errors. Sandboxed environments may deny Vite's port binding
or the `tsx` IPC socket with `EPERM`; allow local server/socket binding and rerun
the test rather than treating the timeout as an application failure.
