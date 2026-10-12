# Deploying on AWS (two sites, two domains)

Layout (about $20 a month for 1-2 viewers, see the cost notes in the project discussion):

| Part | Where | Address |
|---|---|---|
| User site (streaming) | EC2 `t3.micro`, container `user` | `https://watch.example.com` |
| Admin dashboard | same server, container `admin` | `https://admin.example.com/admin/` |
| Queue worker | same server, container `worker` | none |
| Encoding | ECS Fargate, one task per video, stops when done | none |
| Videos / posters | S3 + CloudFront | `https://dxxxx.cloudfront.net` |

The two sites are separate servers (`APP_MODE=user` and `APP_MODE=admin`) behind Caddy, which also gets and renews the HTTPS certificates.

> **Not ready to deploy yet:** the application still stores video records and series in a local JSON file. On AWS the encoding task (Fargate) and the website (EC2) cannot share that file, so progress and "completed" would never reach the sites. The DynamoDB storage must be ported onto the current code first (it exists only on the `dinesh/dynamodb-ecs-transcoder` branch, built before series, pause/delete, thumbnails and the two-app split).

## Steps

1. **Domain.** Register one (Route 53, or any registrar). You need two names: for example `watch.example.com` (public) and `admin.example.com` (private).
2. **Image.** Build and push one Docker image to ECR (the same image runs all three roles):
   ```bash
   aws ecr create-repository --repository-name video-stream --region ap-south-1
   docker build -t <account>.dkr.ecr.ap-south-1.amazonaws.com/video-stream:latest .
   aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin <account>.dkr.ecr.ap-south-1.amazonaws.com
   docker push <account>.dkr.ecr.ap-south-1.amazonaws.com/video-stream:latest
   ```
3. **Variables** (`terraform/terraform.tfvars`):
   ```hcl
   container_image  = "<account>.dkr.ecr.ap-south-1.amazonaws.com/video-stream:latest"
   vpc_id           = "vpc-..."
   subnet_ids       = ["subnet-...", "subnet-..."]
   admin_api_key    = "a long random password"
   user_domain      = "watch.example.com"
   admin_domain     = "admin.example.com"
   route53_zone_id  = "Z..."   # only if the domain is in Route 53
   ```
   Leave both domains empty to try it first: the user site is then `http://<server address>/` and the admin is `http://<server address>:8080/admin/` (restrict it with `admin_allowed_cidrs = ["<your ip>/32"]`).
4. **Apply:** `cd terraform && terraform init && terraform plan && terraform apply`.
5. **DNS.** If the domain is not in Route 53, create two `A` records pointing at the `dns_records_to_create` output. Caddy gets the certificates automatically once they resolve (give it a few minutes).
6. Open `user_site_url` and `admin_site_url` (both are printed as outputs) and sign in to the admin with `admin_api_key`.

## Keeping the admin private

The admin sits behind a password (`ADMIN_API_KEY`) and over HTTPS. For more protection, put it on a name nobody guesses and, when you know your own address, limit port 8080 (no-domain mode) with `admin_allowed_cidrs`. With a domain the admin is open to the internet and protected by the password only.

## Updating a running deployment

The server's startup script only runs when the server is first created (changes to it are ignored on purpose, so a server that is encoding is never replaced). To update:

1. **New app version:** build and push the image again (same steps as above, tag `latest`).
2. **New settings** (for example `WORKER_CONCURRENCY`): edit `/opt/video/app.env` on the server (open a shell from the AWS console: EC2, Connect, Session Manager).
3. **Restart with the new image**, when no video is encoding (restarting the worker during a job would make it start again later):
   ```bash
   cd /opt/video && docker compose pull && docker compose up -d
   ```

## Encoding several videos at once

`worker_concurrency` (default 3) sets how many videos encode at the same time, each in its own Fargate task. Keep `worker_concurrency x transcoder_cpu / 1024` within your Fargate vCPU quota (30 by default): for example 3 tasks of 8 vCPU = 24.
