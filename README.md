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

The frontend runs at `http://localhost:5173` and proxies `/api` requests to the
backend on port 3000.

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
```

Playwright starts and stops the application servers for its suite. Ports 3000
and 5173 must be available when it begins.
