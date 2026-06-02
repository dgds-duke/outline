# Deploying the ELPC Outline fork on a Duke RAPID VM

**What runs where:** `docker compose` runs three containers on the VM — the Outline app
(bound to `127.0.0.1:3000`), a **pgvector** Postgres, and Redis. A **host nginx** terminates
HTTPS on `443` with Duke's certbot/Let's Encrypt cert and reverse-proxies to the app. OIDC
sign-in requires HTTPS, so the proxy is **not optional**.

Files referenced below live in this `deploy/` folder; the compose file is at the repo root
(`docker-compose.prod.yml`).

> This is a **fork**, so the official prebuilt image can't be used — you build your own. The
> frontend build is the only memory-heavy step (~3–4 GB). On a 4 GB VM, add swap, or build the
> image elsewhere and copy it over (see §6).

---

## 1. Prerequisites on the VM

- Docker Engine + the Compose plugin:
  ```bash
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$(whoami)"   # log out/in so `docker` works without sudo
  docker compose version                # should print v2.x
  ```
- A DNS hostname pointing at the VM (e.g. `outline.elpc.duke.edu`) and a **certbot cert** for it
  (`sudo certbot certificates` should list it). On Duke RAPID VMs this is typically already set up.
- Outbound network reach from the VM to **Duke's LiteLLM proxy** (`LITELLM_BASE_URL`) and **Duke
  OIDC** (`oauth.oit.duke.edu`) — both are required for the AI features and sign-in.

## 2. Get the code on the VM

A read-only **deploy key** is least-privilege (it can't push):

```bash
ssh-keygen -t ed25519 -f ~/.ssh/outline_deploy -N "" -C "outline-deploy@vm"
cat ~/.ssh/outline_deploy.pub        # register at: repo → Settings → Deploy keys (no write access)
```
Add an SSH host alias in `~/.ssh/config`:
```
Host github-outline
    HostName github.com
    User git
    IdentityFile ~/.ssh/outline_deploy
    IdentitiesOnly yes
```
Then clone:
```bash
git clone github-outline:dgds-duke/outline.git
cd outline
```
(Alternatives: `gh auth login`, or a fine-grained read-only PAT over HTTPS.)

## 3. Create `.env` (secrets — not committed)

```bash
cp .env.production.sample .env
```
`.env.production.sample` is a trimmed, fill-in-the-blanks template for this compose deploy (see
`.env.sample` for the full variable reference). The essentials:

```bash
NODE_ENV=production
URL=https://outline.elpc.duke.edu          # the VM's real https hostname, no trailing slash
PORT=3000
FORCE_HTTPS=true                            # app is behind the TLS proxy
ENABLE_UPDATES=false                        # no phone-home

SECRET_KEY=<openssl rand -hex 32>           # do NOT change once set, or all logins break
UTILS_SECRET=<openssl rand -hex 32>
DATABASE_PASSWORD=<openssl rand -hex 24>    # compose uses this for Postgres AND the app

FILE_STORAGE=local                          # uploads on the VM disk (a docker volume)

# AI features (Duke LiteLLM proxy)
SEARCH_PROVIDER=vector
LITELLM_BASE_URL=<duke proxy base, e.g. https://.../v1>
LITELLM_API_KEY=<key>
LITELLM_SUMMARY_MODEL=gpt-5.5               # Duke model ids use DASHES, not dots
LITELLM_ANSWER_MODEL=gpt-5.5
LITELLM_EMBEDDING_MODEL=text-embedding-3-large   # truncated to 1536 dims automatically

# Sign-in via Duke NetID (see §4)
OIDC_ISSUER_URL=https://oauth.oit.duke.edu/oidc/
OIDC_CLIENT_ID=<from the Duke Authentication Manager>
OIDC_CLIENT_SECRET=<from the Duke Authentication Manager>
OIDC_DISPLAY_NAME=Duke NetID
OIDC_USERNAME_CLAIM=preferred_username      # verify against Duke's userinfo claims
```

> **Do NOT set `DATABASE_URL` or `REDIS_URL`** — `docker-compose.prod.yml` points those at the
> compose services for you. `SMTP_*` is also not needed: OIDC replaces the email magic-link.

## 4. Register the OIDC client at Duke

At the [Duke Authentication Manager](https://authentication.oit.duke.edu/manager) (self-register
as a locally-developed app), create an OIDC client with redirect URI:

```
https://outline.elpc.duke.edu/auth/oidc.callback
```

It must match `URL` **exactly** — scheme, host, and path, no trailing slash. A mismatch is the
#1 cause of sign-in failures. Copy the issued client id/secret into `.env` (§3).

## 5. Build, migrate, run

```bash
# (optional) temporary swap so the build doesn't OOM on a small VM
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile

# 1. Build the base image (compiles the app — this is the heavy step)
docker build -f Dockerfile.base -t outline-elpc-base .

# 2. Build the slim runtime image
docker compose -f docker-compose.prod.yml build

# 3. Run database migrations (creates the schema incl. the pgvector table)
docker compose -f docker-compose.prod.yml run --rm migrate

# 4. Start the stack
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps        # all healthy
docker compose -f docker-compose.prod.yml logs -f outline
```

Confirm the app is up locally (before nginx):
```bash
curl -s http://127.0.0.1:3000/_health     # -> OK
```

## 6. (Alternative) build elsewhere, copy the image

If the VM is too small to build, build on your laptop/CI and transfer the image:
```bash
# on a build machine:
docker build -f Dockerfile.base -t outline-elpc-base .
docker compose -f docker-compose.prod.yml build
docker save outline-elpc:latest | gzip | ssh github-outline-vm 'gunzip | docker load'
# on the VM: skip step 5.1–5.2, run migrate + up
```

## 7. TLS + reverse proxy (nginx with the certbot cert)

Use **nginx, not Caddy**: certbot stays the cert manager, and nginx's root master reads the
root-owned `/etc/letsencrypt` keys natively (Caddy's unprivileged user can't). See
[`nginx-outline.conf`](nginx-outline.conf) — it already forwards the **WebSocket Upgrade** header
(Outline's realtime + collaborative editing break silently without it), sets
`X-Forwarded-Proto` (so OIDC redirects are https), a large `client_max_body_size` (PDF uploads),
and a long `proxy_read_timeout` (20–40 s LLM calls).

```bash
sudo cp deploy/nginx-outline.conf /etc/nginx/sites-available/outline
# edit server_name + the two ssl_certificate paths to your domain (match `certbot certificates`)
sudo ln -s /etc/nginx/sites-available/outline /etc/nginx/sites-enabled/outline
sudo nginx -t && sudo systemctl reload nginx

# make nginx pick up renewed certs (certbot swaps the live/ symlinks in place):
echo -e '#!/bin/sh\nsystemctl reload nginx' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
sudo certbot renew --dry-run       # confirms renewal + the reload hook fire
```

## 8. Firewall

Open **80** (http→https redirect) and **443** only. The app stays on `127.0.0.1`, so it's
unreachable except through nginx — defense in depth even if the firewall is misconfigured.
```bash
sudo ufw allow 80,443/tcp 2>/dev/null || true
```

## 9. First run + lock down who can join

1. Open `https://outline.elpc.duke.edu` and sign in with **Continue with Duke NetID**. The first
   user to sign in becomes the workspace **admin**.
2. **Settings → Security → enable "Require invites"** so that not every valid NetID can
   self-provision — only people you invite are admitted on OIDC sign-in.
3. Invite the clinic members (Settings → Members).
4. Sanity-check the AI features: upload a PDF (sidebar → **Summarize a paper**), publish a couple
   of docs, then search by concept — you should get hybrid results + the "AI answers" panel.

## 10. Upgrading

```bash
cd outline && git pull
docker build -f Dockerfile.base -t outline-elpc-base .
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml run --rm migrate     # apply any new migrations
docker compose -f docker-compose.prod.yml up -d                # recreate with the new image
```

§11 automates exactly these steps. Use the manual flow above until the runners are
registered, then let CI do it.

## 11. CI/CD — automated push → test → deploy (`.gitlab-ci.yml`)

The repo ships a [`.gitlab-ci.yml`](../.gitlab-ci.yml). On a push to the default
branch it runs lint + types + tests, builds the two-stage image, and (with a
manual click) migrates and redeploys — replacing the §10 manual upgrade.

**Topology:** there are **no Duke shared runners**, so you register your own. One
`gitlab-runner` install on **this VM**, registered **twice**:

- `elpc-ci` — **docker** executor. Runs lint/types/tests (they use `image:` +
  `services:` so they need a docker executor).
- `elpc-vm` — **shell** executor, **protected**. Runs `build`/`deploy` directly
  against the host Docker daemon, so the image it builds is already local for
  `docker compose up -d` — no registry pull, no SSH.

> **Security:** the shell executor and the `docker` group both grant effective
> **root on this host**. Keep `elpc-vm` restricted to the protected default branch
> with "run untagged = off", so untrusted branch/MR code can never run on prod or
> read protected secrets.

### Register the runners

```bash
# Install once:
curl -L https://packages.gitlab.com/install/repositories/runner/gitlab-runner/script.deb.sh | sudo bash
sudo apt install -y gitlab-runner
sudo usermod -aG docker gitlab-runner       # let shell jobs drive host Docker

# In GitLab UI: Project → Settings → CI/CD → Runners → "New project runner".
# Create TWO. For each, set its tag and turn OFF "Run untagged jobs"; for the
# elpc-vm one also tick "protected". Copy each runner's glrt- token, then:
sudo gitlab-runner register --non-interactive --url https://gitlab.oit.duke.edu \
  --token glrt-AAA --executor shell  --description elpc-vm
sudo gitlab-runner register --non-interactive --url https://gitlab.oit.duke.edu \
  --token glrt-BBB --executor docker --docker-image node:24.16.0 --description elpc-ci

sudo gitlab-runner verify                    # both runners show as alive
```

> Tags, "protected", and "run untagged" are set in the **UI** when you create the
> runner (GitLab 16+ authentication-token flow), not on the `register` command.

### Protect the secret path (or deploy silently fails)

1. **Settings → Repository → Protected branches:** mark the default branch
   **Protected** (Protected CI/CD variables are only injected on protected refs).
2. **Settings → CI/CD → Variables:** keep secrets out of CI entirely by leaving the
   VM's hand-placed `/srv/outline/.env` as the source of truth (recommended) — the
   `deploy` job reads it from the compose working dir. Run the `elpc-vm` runner from
   that directory, or `cp` the CI checkout alongside the existing `.env`.

### First run

Push to the default branch. `lint`/`test`/`build` run automatically; `deploy` is
`when: manual` — click **Deploy** on the `production` environment in
*Build → Pipelines* (or *Deployments → Environments*). To make deploys fully
automatic, delete the `when: manual` line in `.gitlab-ci.yml`. Set the
`environment.url` there to the VM's real hostname.

> The optional registry push (an off-VM rollback image tagged by commit SHA) needs
> the Container Registry enabled. Delete the three `docker login`/`tag`/`push` lines
> in the `build` job if you are not using it.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| OIDC sign-in fails / redirect error | The redirect URI at Duke must equal `<URL>/auth/oidc.callback` **exactly** (scheme, host, path, no trailing slash). Also confirm `URL` is https and `FORCE_HTTPS=true`. |
| Build is killed / OOM | The Vite build needs ~3–4 GB. Add swap (§5) or build elsewhere (§6). |
| Pages load but realtime/collab editing doesn't sync | nginx is missing the WebSocket `Upgrade`/`Connection` headers — use the provided `nginx-outline.conf`. |
| Endless https redirect, or OIDC redirects to `http://` | nginx isn't sending `X-Forwarded-Proto $scheme`; Outline thinks it's on http. Use the provided conf. |
| `502 Bad Gateway` | App container isn't up/healthy, or not on `127.0.0.1:3000`. `docker compose ... ps` / `logs outline`. |
| Search returns nothing semantic (keyword only) | Embeddings aren't being stored. Check `logs outline` for an embedding-dimension error; the proxy must honor the `dimensions` param (Duke's does) — if not, set `LITELLM_EMBEDDING_MODEL=text-embedding-3-small`. Remember only **published** docs are embedded. |
| AI answer panel never appears | `LITELLM_ANSWER_MODEL` wrong (Duke ids use dashes: `gpt-5.5`, not `gpt.5.5`) or the team lacks access to that model — see `logs outline` for a 401 `team_model_access_denied`. |
| Migrations fail / `vector` type unknown | Postgres must have pgvector. The bundled `pgvector/pgvector:pg16` has it; if you point at an external Postgres, install the extension there first. |
| Container can't reach Duke proxy/OIDC | VM egress/VPN issue. `docker compose ... exec outline wget -qO- $LITELLM_BASE_URL` to test reachability from inside the container. |
| CI job stuck "pending", no runner | Job's tag has no matching runner. Check `sudo gitlab-runner verify`; confirm the `elpc-ci`/`elpc-vm` tags match the job and that "run untagged" is off (so tagged jobs land on the right runner). |
| `build`/`deploy` runs but `docker: permission denied` | The `gitlab-runner` user isn't in the `docker` group. `sudo usermod -aG docker gitlab-runner && sudo systemctl restart gitlab-runner`. |
| `deploy` can't find `.env` / `DATABASE_PASSWORD` unset | The `elpc-vm` job's working dir isn't next to the VM's `.env`. Run the runner from `/srv/outline`, or `cp` the checkout over it. |
| `deploy` skipped / secrets empty | Default branch isn't a **Protected** branch, so Protected CI/CD variables aren't injected. Protect the branch (§11). |
