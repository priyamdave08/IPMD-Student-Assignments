# Deployment status

Recorded September 24 to 25, 2026. This describes the demo server that was set up from `docs/DEPLOY_ORACLE.md`. The public hostname and IP address are deliberately **not** written here: this repository is public, and the server is protected only by one shared access key.

## Where it runs

| Item | What was checked | How |
|---|---|---|
| Host | A virtual machine in **Oracle Cloud**, region `us-chicago-1`, availability domain AD-1 | Instance details page in the Oracle console. The server's public IP resolves to an address owned by **Oracle Corporation (AS31898)** according to an ownership lookup. |
| Operating system | Canonical Ubuntu 24.04, 64-bit Arm (`aarch64`) | Instance details page |
| Shape | `VM.Standard.A2.Flex` | Reported by the owner from the console. It is **not** the Always Free-eligible shape (that is `VM.Standard.A1.Flex`). The OCPU count and memory were not recorded. |
| Software | Docker Compose: the EchoSphere API and worker in one container, and Caddy in front for HTTPS | Built on the VM from the code in this repository |
| Code version | `main` at commit `55f3383` (the merged automatic pipeline), pulled onto the VM and rebuilt on September 25, 2026. The server was first set up from commit `ac1b816`. | `git pull` and `docker compose up -d --build` on the VM. The server's API page lists `POST /v1/soundtracks/auto`, which the earlier version did not have. A timed full run on the VM has not been recorded. |
| Public access | HTTPS on the hostname, port 80 redirecting to 443. Data routes returned 401 without the key; `/health` returned only its status. | Requests made from outside the VM |
| Storage | A Docker volume on the VM's boot disk. Videos and results are deleted after 24 hours of inactivity and uploads stop at a 20 GB total. | Defaults in `deploy/docker-compose.yml`. Not changed on the VM as far as is known. |

## Does it run with the developer's laptop off?

**Expected yes, but not tested.** The server is a separate machine in Oracle's data center. The laptop was only used to log in over SSH and to open the website. The containers use `restart: unless-stopped` and Docker is enabled at boot, so they should come back after a reboot of the VM. Nobody has yet switched the laptop off and checked from another network, and nobody has rebooted the VM to confirm the restart behaviour. Do that before relying on it.

## Billing configuration

What the Oracle billing page showed on September 24, 2026 (screenshot from the account owner):

- Plan type: **Free Tier**. Account type: **Promo**.
- Payment method: **none**. The page said a payment method must be added to upgrade.

What that supports, and what it does not:

- **Supported:** with no payment method on file and no upgrade, Oracle has nothing to charge. Nothing on the account had been upgraded to Pay As You Go at that time.
- **Not verified:** the amount of promotional credit, its expiry date, and what Oracle does with a non-Always-Free shape when the credit ends. It is likely to be stopped or removed, but that has not been confirmed. Treat this server as **temporary**.
- **Not a guarantee of $0.** This setup is free only while no payment method is added and the account is not upgraded. Oracle can change its terms; it cut the Always Free Arm allowance in half in June 2026 without announcement.
- **Permanent alternative:** an Always Free `VM.Standard.A1.Flex` shape, if capacity becomes available. Capacity was unavailable in all three availability domains on September 24.

## What could cause a charge

1. Adding a payment method or clicking Upgrade / Pay As You Go on the Oracle account.
2. Creating resources outside the free or promotional allowance after a payment method exists.

## Known gaps

- One shared access key for everyone. Rotate it by editing `deploy/.env` on the VM and running `docker compose up -d`.
- No backups. A lost VM loses stored videos.
- Processing speed on the VM has not been measured.
- The Oracle SSH key that was used is stored only on the owner's computer.

## To update the server later

On the VM: `git pull`, then `cd deploy && docker compose up -d --build`.
