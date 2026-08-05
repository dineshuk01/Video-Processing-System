# ─────────────────────────────────────────────────────────────────
# Video Processing System — Terraform Variables
# ─────────────────────────────────────────────────────────────────

variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "us-east-1"
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

variable "api_container_image" {
  description = "Docker image URI for the API server container"
  type        = string
}

variable "worker_container_image" {
  description = "Docker image URI for the background worker container"
  type        = string
}

variable "api_cpu" {
  description = "CPU units for the API task (256 = 0.25 vCPU)"
  type        = number
  default     = 512
}

variable "api_memory" {
  description = "Memory (MiB) for the API task"
  type        = number
  default     = 1024
}

variable "worker_cpu" {
  description = "CPU units for the worker/transcoder task"
  type        = number
  default     = 1024
}

variable "worker_memory" {
  description = "Memory (MiB) for the worker/transcoder task"
  type        = number
  default     = 2048
}

variable "vpc_id" {
  description = "VPC ID for ECS tasks"
  type        = string
}

variable "subnet_ids" {
  description = "Subnet IDs for ECS Fargate tasks"
  type        = list(string)
}

variable "api_desired_count" {
  description = "Desired number of API task instances"
  type        = number
  default     = 1
}

# ─── CloudFront CDN ──────────────────────────────────────────────

variable "enable_cdn" {
  description = "Whether to create a CloudFront distribution for the public bucket"
  type        = bool
  default     = true
}
