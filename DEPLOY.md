# Deploying ScaleLink to Azure (your part)

This is the part I can't do from my sandbox — no card needed anywhere here.
Total time: ~20-30 minutes, most of it waiting for Azure to provision things.

## 0. One-time setup

### 0.1 Get Azure credit (no card)
1. Go to https://azure.microsoft.com/free/students/
2. Sign up with your **college email address** — no credit card is asked for
   anywhere in this flow. You get $100 in credit, valid ~12 months.
3. If your college email isn't recognized, apply to the
   [GitHub Student Developer Pack](https://education.github.com/pack) instead
   (needs your GitHub account + some proof of enrollment) and use the Azure
   offer inside it.

### 0.2 Install the Azure CLI and Terraform on your machine
- Azure CLI: https://learn.microsoft.com/cli/azure/install-azure-cli
- Terraform: https://developer.hashicorp.com/terraform/install

### 0.3 Log in
```bash
az login
```
This opens a browser for you to sign in with the same Microsoft account you
used for Azure for Students. No card prompt.

## 1. Get the code

```bash
git clone https://github.com/Riderneal/ScaleLink.git
cd ScaleLink/terraform
```

## 2. Set your variables

Create a file called `terraform.tfvars` in the `terraform/` folder:

```hcl
github_repo_url = "https://github.com/Riderneal/ScaleLink.git"
```

(Leave `location`, `vm_size`, `admin_username` as their defaults unless you
have a reason to change them — `centralindia` and `Standard_B1s` keep this
comfortably inside your free credit for a short-lived demo.)

## 3. Deploy

```bash
terraform init
terraform validate    # sanity check before touching real infrastructure
terraform plan         # review what it's about to create
terraform apply        # type "yes" when prompted
```

This takes 3-5 minutes. When it finishes, note the `load_balancer_public_ip`
output — that's your live URL.

**Then wait an extra 2-3 minutes** after `apply` finishes: the app VMs are
still running their cloud-init script in the background (installing Docker,
cloning the repo, building the image). Check readiness with:

```bash
curl http://<load_balancer_public_ip>/health
```

Keep retrying every 30s until you get `{"status":"ok",...}` instead of a
connection error.

## 4. Prove the rate limiter is genuinely distributed

```bash
cd ../scripts
node verify-distributed-rate-limit.js http://<load_balancer_public_ip>
```

This fires 25 requests from one simulated client at the live load balancer
and prints which backend instance answered each one, plus the running
remaining-count. You should see requests answered by both `app-0` and
`app-1` while the shared limit still holds exactly — that's the actual
proof this isn't just two independent servers each doing their own
in-memory counting.

## 5. Run the load test

Install k6 if you don't have it: https://grafana.com/docs/k6/latest/set-up/install-k6/

```bash
cd ../loadtest
k6 run -e BASE_URL=http://<load_balancer_public_ip> k6-script.js
```

This ramps up to 1,000 requests/second over about 2 minutes, simulating a
distinct client IP per virtual user so the per-client rate limiter doesn't
cap the aggregate measurement. At the end it prints a summary with the
exact resume-quotable line, e.g.:

```
"handled 1850 req/sec at p99 210ms across 2 load-balanced instances"
```

Save that output — screenshot it or copy the terminal log. That's your proof.

## 6. Tear it down (don't skip this)

**Do this as soon as you have your numbers.** Every hour these VMs run costs
a small amount of your credit even when idle.

```bash
cd ../terraform
terraform destroy    # type "yes" when prompted
```

Confirm everything's gone by checking the Azure Portal
(https://portal.azure.com → Resource groups → `scalelink-rg` should not
exist anymore, or should be empty).

## If something goes wrong

- **`terraform apply` fails with a quota/SKU error**: some Azure regions
  restrict `Standard_B1s` availability for free-tier accounts. Try setting
  `location = "eastus"` or `location = "southeastasia"` in your
  `terraform.tfvars` and re-run `terraform apply`.
- **`/health` never responds after 5+ minutes**: SSH into an app VM and check
  the cloud-init log:
  ```bash
  ssh -i scalelink_ssh_key.pem azureuser@<app_vm_public_ip_if_you_add_one>
  sudo cat /var/log/cloud-init-output.log
  ```
  (The app VMs don't have public IPs by default in this setup — for
  debugging, you can temporarily add one via the Azure Portal, or check logs
  through Azure's "Boot diagnostics" / "Run command" feature instead.)
- **k6 reports lots of 429s and low measured throughput**: the load test
  script (`loadtest/k6-script.js`) already simulates a distinct client IP
  per virtual user via `X-Forwarded-For`, and the service trusts that header
  (correct behavior behind any load balancer). So 429s in a normal run mean
  the rate limiter is doing its job on individual simulated clients, not
  that the whole benchmark is capped — check the summary's total
  requests/sec, which reflects aggregate backend capacity, not one client's
  limit. If you want to see raw capacity with rate limiting further out of
  the way, bump `rate_limit_max_requests` in `terraform.tfvars` before
  `terraform apply` (e.g. to `1000`), then run the load test.
- **Anything else**: paste the exact error back to me and I'll debug it with
  you.
