# ─────────────────────────────────────────────────────────────────
# Video Processing System — Terraform Outputs
# ─────────────────────────────────────────────────────────────────

output "raw_bucket_name" {
  description = "Name of the S3 bucket for raw video uploads"
  value       = aws_s3_bucket.raw_uploads.id
}

output "raw_bucket_arn" {
  description = "ARN of the raw uploads S3 bucket"
  value       = aws_s3_bucket.raw_uploads.arn
}

output "hls_bucket_name" {
  description = "Name of the S3 bucket for processed HLS output"
  value       = aws_s3_bucket.hls_public.id
}

output "hls_bucket_arn" {
  description = "ARN of the HLS public S3 bucket"
  value       = aws_s3_bucket.hls_public.arn
}

output "sqs_queue_url" {
  description = "URL of the main transcode SQS queue"
  value       = aws_sqs_queue.transcode_queue.url
}

output "sqs_queue_arn" {
  description = "ARN of the main transcode SQS queue"
  value       = aws_sqs_queue.transcode_queue.arn
}

output "sqs_dlq_url" {
  description = "URL of the Dead Letter Queue"
  value       = aws_sqs_queue.transcode_dlq.url
}

output "ecs_cluster_name" {
  description = "Name of the ECS cluster"
  value       = aws_ecs_cluster.main.name
}

output "ecs_cluster_arn" {
  description = "ARN of the ECS cluster"
  value       = aws_ecs_cluster.main.arn
}

output "api_task_definition_arn" {
  description = "ARN of the API server ECS task definition"
  value       = aws_ecs_task_definition.api.arn
}

output "worker_task_definition_arn" {
  description = "ARN of the worker ECS task definition"
  value       = aws_ecs_task_definition.worker.arn
}

output "cdn_domain_name" {
  description = "CloudFront distribution domain name (if CDN is enabled)"
  value       = var.enable_cdn ? aws_cloudfront_distribution.hls_cdn[0].domain_name : "CDN not enabled"
}

output "cdn_base_url" {
  description = "Full CDN base URL to set as CDN_BASE_URL env var"
  value       = var.enable_cdn ? "https://${aws_cloudfront_distribution.hls_cdn[0].domain_name}" : ""
}
