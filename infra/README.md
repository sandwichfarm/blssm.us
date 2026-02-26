# blssm.us Mint Infrastructure

Ansible deployment for a self-hosted Cashu mint backed by LND (neutrino mode).

```
Internet → Caddy (:443) → nutshell (:3338) → LND (:10009, neutrino) → Bitcoin P2P
```

## Prerequisites

- A VPS running Debian 12+ or Ubuntu 22.04+ with root/sudo access
- DNS A record pointing your mint domain (e.g. `mint.blssm.us`) to the VPS IP
- Ansible 2.14+ on your local machine
- `ansible-galaxy collection install community.general community.postgresql`

## Setup

### 1. Configure inventory

```bash
cd infra
cp inventory/hosts.yml.example inventory/hosts.yml
# Edit hosts.yml with your server IP and SSH user
```

### 2. Create and encrypt vault secrets

```bash
cp inventory/group_vars/mint/vault.yml.example inventory/group_vars/mint/vault.yml

# Generate secrets
openssl rand -hex 32    # vault_mint_private_key
openssl rand -base64 24 # vault_mint_db_password
# Choose a strong passphrase for vault_lnd_wallet_password

# Edit vault.yml with your secrets, then encrypt:
ansible-vault encrypt inventory/group_vars/mint/vault.yml

# Save your vault password:
echo 'your-vault-password' > .vault_pass
chmod 600 .vault_pass
```

### 3. Review variables

Edit `inventory/group_vars/mint/vars.yml` — set `mint_domain` to your domain.

### 4. Deploy

```bash
# Dry run first
ansible-playbook --check playbooks/site.yml

# Deploy
ansible-playbook playbooks/site.yml
```

## Post-Deployment

### Create LND wallet (first time only)

```bash
ssh your-server
sudo -u lnd lncli --lnddir=/var/lib/lnd/.lnd create
```

**Write down the 24-word seed and store it securely.** This cannot be recovered.

### Bake restricted macaroon for nutshell

```bash
sudo -u lnd lncli --lnddir=/var/lib/lnd/.lnd \
  bakemacaroon invoices:read invoices:write address:read address:write \
  --save_to /var/lib/lnd/.lnd/data/chain/bitcoin/mainnet/mint.macaroon

sudo chgrp lnd /var/lib/lnd/.lnd/data/chain/bitcoin/mainnet/mint.macaroon
sudo chmod 640 /var/lib/lnd/.lnd/data/chain/bitcoin/mainnet/mint.macaroon

# Restart nutshell to pick up the macaroon
sudo systemctl restart nutshell
```

### Fund the node

```bash
sudo -u lnd lncli --lnddir=/var/lib/lnd/.lnd newaddress p2wkh
# Send sats to the returned address, then open channels
```

### Verify mint is running

```bash
curl https://mint.blssm.us/v1/info
```

### Update blssm.us config

Add your mint to `config/payment.toml`:

```toml
[[mints]]
url = "https://mint.blssm.us"
```

## Operations

### Unlock LND wallet (after server reboot)

LND auto-unlocks via `wallet-unlock-password-file` in the config. If that fails:

```bash
ansible-playbook playbooks/lnd-unlock.yml
```

### Backup

```bash
ansible-playbook playbooks/mint-backup.yml
```

Backups are saved to `/var/backups/mint/` on the server. Includes:
- PostgreSQL dump of the cashu database
- LND channel.backup (SCB)

### Check service status

```bash
ssh your-server
sudo systemctl status lnd nutshell caddy postgresql
sudo journalctl -u nutshell -f  # follow mint logs
sudo journalctl -u lnd -f       # follow LND logs
```

### LND useful commands

```bash
sudo -u lnd lncli --lnddir=/var/lib/lnd/.lnd getinfo
sudo -u lnd lncli --lnddir=/var/lib/lnd/.lnd walletbalance
sudo -u lnd lncli --lnddir=/var/lib/lnd/.lnd listchannels
```
