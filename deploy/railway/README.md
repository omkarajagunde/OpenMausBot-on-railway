# Deploy OpenMausBot on Railway

One Railway service runs everything: the web app, the harness server, Claude
Code and a Caddy edge in a single container. You open the service's URL in a
browser, sign in with your administrator password, connect Claude Code once,
and talk to your bots.

## Set it up

1. **Create the service.** In Railway, choose *New project → Deploy from GitHub
   repo* and pick this repository. `railway.json` at the root makes Railway
   build `deploy/railway/Dockerfile`.
2. **Set the password.** Under the service's *Variables*, add
   `OMB_ADMIN_PASSWORD` with at least 12 characters. The container refuses to
   start without it.
3. **Attach a volume at `/data`.** Under *Settings → Volumes* (or
   `railway volume add --mount-path /data`). Claude Code's login, your bots,
   chats and settings live there. Without a volume every deploy starts empty,
   and the logs say so.
4. **Give it a public address.** Under *Settings → Networking*, choose
   *Generate Domain* (the container listens on Railway's `$PORT`). The server
   picks the address up from `RAILWAY_PUBLIC_DOMAIN`; set `OMB_PUBLIC_URL`
   only for a custom domain.
5. **Deploy**, then open the address.

## Sign in and connect Claude Code

1. Open the service's address and enter the administrator password. The
   browser gets a session cookie for 30 days, renewed while you use it.
2. Open **Settings → Engines → Claude Code** and choose **Sign in**. The
   server runs the real `claude auth login` inside the container and shows its
   sign-in link. Open it, approve, and paste the code it gives you back into
   the page. The login is saved in `/data/.claude` on the volume.
   To use an Anthropic API key instead, save it in **Settings → Connections**
   and pick the *Claude (API key)* engine.
3. Create a bot and give it work, the way you would talk to Claude Code.

## Variables

| Variable | Required | What it does |
|---|---|---|
| `OMB_ADMIN_PASSWORD` | yes | The password you sign in with. At least 12 characters. |
| `OMB_ADMIN_PASSWORD_HASH` | no | Use instead of the password itself: the output of `echo -n 'your password' \| docker run -i --rm --entrypoint node <image> /app/dist-server/railway-start.js hash`. |
| `OMB_EDGE_SCHEME` | no | `http` only for a local `docker run` without TLS. Leave unset on Railway. |
| `OMB_PUBLIC_URL` | no | Your own domain, such as `https://bots.example.com`. Defaults to `https://$RAILWAY_PUBLIC_DOMAIN`. |
| `OMB_ENVIRONMENT_LABEL` | no | The name the sign-in page shows. Defaults to `OpenMausBot`. |
| `CLAUDE_CODE_VERSION` | no | Build argument: the Claude Code version baked in (default `latest`). Redeploy to update Claude Code. |

## Security model

- Only the Caddy edge listens on the network. It forwards every request with
  `X-Forwarded-*` headers, so a request from the internet never counts as the
  machine's owner; it needs a session.
- Inside the container, loopback is `service` trust: a bot's shell is a local
  caller too, and without a session it can reach only the service routes. It
  cannot change settings, approve its own cards or open a pairing code.
- The server never sees the plaintext password. The entrypoint hashes it with
  scrypt and hands the server only the hash, over a pipe rather than the
  environment, so no bot or tool can read it.
- Wrong passwords are limited per address (10 a minute) and overall (30 per
  10 minutes), so a forged client address does not buy more guesses.
- The session cookie is `HttpOnly`, `Secure`, `SameSite=Lax`, and works only
  from the app's own page.

## Run the image locally

```sh
docker build -f deploy/railway/Dockerfile -t openmausbot-railway .
docker run --rm -p 8080:8080 -e OMB_EDGE_SCHEME=http -e OMB_ADMIN_PASSWORD='a long password here' \
  -v omb-railway-data:/data openmausbot-railway
```

Then open <http://localhost:8080>. `OMB_EDGE_SCHEME=http` tells the server the
browser is on plain HTTP, so its cookie is not marked `Secure`; never set it on
Railway, which always serves HTTPS.
