// Entrypoint for the github-core-clone-01 forge.
//
// Contract (from the competition kit): the environment starts this file with
// `node main.ts`. We bind an ephemeral port, register it with the env via
// POST $MAKEFUN_ENV_URL/register, then poll GET $MAKEFUN_ENV_URL/done until
// the env says the run is over. First registration wins; a 409 means another
// process already registered and is fine.
import { createApp } from './app.ts';

const envUrl = process.env.MAKEFUN_ENV_URL;
if (!envUrl) {
  console.error('MAKEFUN_ENV_URL is not set');
  process.exit(1);
}

const base = envUrl.replace(/\/$/, '');
const server = createApp();

await new Promise<void>((resolve) => server.listen(0, resolve));
const address = server.address();
if (address === null || typeof address === 'string') {
  console.error('could not determine listening port');
  process.exit(1);
}
const port = address.port;
console.log(`forge listening on port ${port}`);

const registerResponse = await fetch(`${base}/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ port }),
});
if (registerResponse.status === 400 || registerResponse.status === 405) {
  console.error(`registration rejected with status ${registerResponse.status}`);
  process.exit(1);
}

for (;;) {
  try {
    const doneResponse = await fetch(`${base}/done`);
    if (doneResponse.ok) {
      const body = (await doneResponse.json()) as { done?: boolean };
      if (body.done) break;
    }
  } catch {
    // env not reachable yet; keep polling
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

await new Promise<void>((resolve) => server.close(() => resolve()));
process.exit(0);
