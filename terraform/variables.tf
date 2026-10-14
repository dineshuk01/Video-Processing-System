# ─────────────────────────────────────────────────────────────────
# Video Processing System — Terraform Variables
# ─────────────────────────────────────────────────────────────────

variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "ap-south-1"
}

variable "project_name" {
  description = "Project name used for resource naming"
  type        = string
  default     = "video-processing"
}

variable "environment" {
  description = "Environment tag (e.g. dev, staging, prod)"
  type        = string
  default     = "dev"
}

# ─── S3 ──────────────────────────────────────────────────────────

variable "raw_bucket_name" {
  description = "Name of the S3 bucket for raw video uploads"
  type        = string
  default     = "video-raw-uploads"
}

variable "public_bucket_name" {
  description = "Name of the S3 bucket for processed HLS output"
  type        = string
  default     = "video-hls-public"
}

variable "raw_expiration_days" {
  description = "Number of days before raw uploads are auto-deleted"
  type        = number
  default     = 7
}

# ─── SQS ─────────────────────────────────────────────────────────

variable "queue_name" {
  description = "Name of the SQS queue for transcode jobs"
  type        = string
  default     = "video-transcode-queue"
}

variable "dlq_name" {
  description = "Name of the SQS Dead Letter Queue"
  type        = string
  default     = "video-transcode-dlq"
}

variable "max_receive_count" {
  description = "Number of times a message can be received before moving to DLQ"
  type        = number
  default     = 3
}

# ─── ECS ─────────────────────────────────────────────────────────

variable "ecs_cluster_name" {
  description = "Name of the ECS cluster"
  type        = string
  default     = "video-processing-cluster"
}

variable "container_image" {
  description = "Docker image URI used by the server (API + worker) and by the encoding task"
  type        = string
}

variable "transcoder_cpu" {
  description = "CPU units for the encoding task (4096 = 4 vCPU). More CPU = faster encoding"
  type        = number
  default     = 4096
}

variable "transcoder_memory" {
  description = "Memory (MiB) for the encoding task (4 vCPU allows 8192-30720)"
  type        = number
  default     = 8192
}

variable "worker_concurrency" {
  description = "How many videos can encode at the same time (each gets its own encoding task). Keep concurrency x transcoder vCPUs within your Fargate vCPU quota (30 by default)"
  type        = number
  default     = 3
}

variable "transcoder_disk_gib" {
  description = "Temporary disk (GiB) for the encoding task: it must hold the source video plus every size (20-200)"
  type        = number
  default     = 100
}

variable "vpc_id" {
  description = "VPC ID for ECS tasks"
  type        = string
}

variable "subnet_ids" {
  description = "Subnet IDs for ECS Fargate tasks"
  type        = list(string)
}

# ─── CloudFront CDN ──────────────────────────────────────────────

variable "enable_cdn" {
  description = "Whether to create a CloudFront distribution for the public bucket"
  type        = bool
  default     = true
}

# ─── Server ──────────────────────────────────────────────────────

variable "admin_api_key" {
  description = "Password for the admin dashboard (ADMIN_API_KEY). Stored in the server's instance data"
  type        = string
  sensitive   = true
}

variable "user_domain" {
  description = "Domain for the public streaming site, e.g. watch.example.com (empty = plain HTTP on the server's address)"
  type        = string
  default     = ""
}

variable "admin_domain" {
  description = "Domain for the admin dashboard, e.g. admin.example.com (empty = port 8080 on the server's address)"
  type        = string
  default     = ""
}

variable "admin_allowed_cidrs" {
  description = "Addresses allowed to open the admin dashboard when it has no domain, e.g. [\"203.0.113.7/32\"] for your own IP"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone ID. If set, the two A records are created for you; otherwise add them at your DNS provider"
  type        = string
  default     = ""
}

variable "max_upload_size_mb" {
  description = "Largest upload the admin may send, in MB"
  type        = number
  default     = 10000
}

# ─── DynamoDB ────────────────────────────────────────────────────

variable "dynamodb_table_name" {
  description = "Name suffix of the DynamoDB table that stores video records"
  type        = string
  default     = "videos"
}

variable "user_session_secret" {
  description = "Signs viewers' login cookies (32+ random characters). Changing it signs everyone out"
  type        = string
  sensitive   = true
  default     = ""
}
