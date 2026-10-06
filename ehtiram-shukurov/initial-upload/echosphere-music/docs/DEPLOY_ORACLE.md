# Deploy on Oracle Cloud Always Free

Status: **used once, on September 24 to 25, 2026, and it worked.** Differences from what is written below: the free `VM.Standard.A1.Flex` shape was out of capacity in all three Chicago availability domains, so the server uses `VM.Standard.A2.Flex` on the account's promotional credit (see `docs/DEPLOYMENT_STATUS.md`). The Playwright base image built on 64-bit Arm without needing the fallback. Oracle's screens and free limits change (it halved its free Arm allowance in June 2026 without announcement), so treat each step as a checkpoint.

Goal: a private, always-on HTTPS address for the EchoSphere API, at **$0**.

## The rule that keeps it free

Oracle's own FAQ says the card is not charged unless you upgrade. So:

- Keep the account on the **Always Free** type. **Never click "Upgrade" or "Pay As You Go".**
- Only create resources the console labels **Always Free-eligible**.
- Do not add paid extras (load balancers, extra block volumes beyond the free total, reserved IPs you are not using).
- Set a reminder to look at Billing > Cost analysis monthly. It should read $0.

## What you do yourself (I cannot do these)

1. **Create the account** at oracle.com/cloud/free. It asks for a card and a phone number for identity checks. Choose your **home region** carefully: it cannot be changed later, and free Arm capacity differs by region. Pick one near your team with availability.
2. **Create the VM** (Compute > Instances > Create instance):
   - Image: **Canonical Ubuntu 24.04** (Arm/aarch64 if using the Ampere shape).
   - Shape: **VM.Standard.A1.Flex**, **2 OCPU and 12 GB memory** (the current free limit, verify in the console). Look for the *Always Free-eligible* badge.
   - Boot volume: 50 GB is plenty.
   - Add your **SSH public key** (or let Oracle generate one and download the private key; keep it safe).
   - If you see **"Out of capacity"**, this is common. Retry later, try another availability domain, or try a smaller shape (1 OCPU, 6 GB will be tight for Chromium).
3. **Open the web ports** in Oracle's network: Networking > your VCN > Security Lists > Default > *Add ingress rules*:
   - Source `0.0.0.0/0`, TCP, destination port **80**
   - Source `0.0.0.0/0`, TCP, destination port **443**
   - Leave port 22 (SSH) as it is, or narrow its source to your own IP.
4. **Get a hostname.** HTTPS needs a name, not a bare IP address. Any domain you own works. A free option is a subdomain from [DuckDNS](https://www.duckdns.org): create one and point it at the VM's **public IP** shown in the console. (DuckDNS was reported active in 2026; I did not test it.)

## What runs on the VM

SSH in (`ssh ubuntu@<public-ip>`), then (the branch must already be pushed to GitHub with the hosting commits, or the clone will not contain `deploy/`):

```
git clone --branch codex/video-soundtrack-local https://github.com/Ehtiram-Shukurov/echosphere-music.git
cd echosphere-music
bash deploy/setup-vm.sh your-name.duckdns.org
```

The script installs Docker, opens ports 80 and 443 in the VM's own firewall, and creates `deploy/.env` with a **random 48-character access key** printed once. Save it in a password manager. Then:

```
cd deploy
sg docker -c 'docker compose up -d --build'
```

The first build downloads the Playwright base image and takes several minutes. Caddy obtains an HTTPS certificate automatically once your hostname points at the VM.

## Checkpoints

Run these from your own computer, replacing the hostname. `KEY` is the access key from the VM.

1. `https://your-name.duckdns.org/health` in a browser should show `{"status":"ok"}` only. If it shows more, authentication is not active. Stop and tell me.
2. `https://your-name.duckdns.org/v1/videos` should say **Authentication required**.
3. The page at `https://your-name.duckdns.org/` should ask for the access key. After entering it, upload a 10 to 60 second MP4, mark the sphere, read it, and create a soundtrack.
4. For scripts, set the key in your shell and use the example client. The key is read from the environment and is not typed into a command:
   ```
   $env:ECHOSPHERE_API_KEY = "<key>"      # PowerShell
   python scripts/api_example.py video.mp4 --focus docs/demo-focus.example.json --url https://your-name.duckdns.org
   ```
5. On the VM, `docker compose ps` should show both services up, and `docker compose logs echosphere` should have no repeated errors.

## If the container does not build or run on Arm

The base image is Playwright's official Python image. Its 64-bit Arm availability for the pinned version was not verified. If `docker compose build` fails to pull it, replace the first two lines of the `Dockerfile` with a plain Python image and install Chromium yourself:

```
FROM python:3.12-slim-bookworm
RUN pip install --no-cache-dir playwright==1.51.0 && playwright install --with-deps chromium
```

Then keep the `apt-get install ffmpeg` step and the `pwuser` lines working by adding `RUN useradd -m -u 1000 pwuser`. Tell me the error and I will adjust it.

## Sharing it safely

- One shared key gives full access to every stored video. Share it privately, and tell teammates not to upload anything they would not want the group to see.
- The default settings delete videos after 24 hours of inactivity and stop uploads at 20 GB total. Change them in `deploy/.env`.
- Update: `git pull` then `docker compose up -d --build` in `deploy/`.
- Rotate the key: edit `deploy/.env`, run `docker compose up -d`. Everyone is signed out.
- Stop and remove everything: `docker compose down -v` deletes the stored videos as well.

## Known risks

- Oracle can reclaim idle Always Free instances, change limits, or be out of capacity. This is a demo host, not a service you can promise uptime on.
- No backups. If the VM is lost, so are stored videos.
- Processing speed on a shared 2 CPU Arm machine has not been measured.
- Automatic HTTPS needs ports 80 and 443 reachable and the hostname resolving to the VM; a wrong DNS entry is the usual cause of certificate errors.
