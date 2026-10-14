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

output "transcoder_task_definition_arn" {
  description = "ARN of the one-shot transcoder ECS task definition"
  value       = aws_ecs_task_definition.transcoder.arn
}

output "server_public_ip" {
  description = "Address of the server. Open http://<this> (or point your domain at it)"
  value       = aws_eip.server.public_ip
}

output "user_site_url" {
  description = "Where the public streaming site is reached"
  value       = local.user_url
}

output "admin_site_url" {
  description = "Where the admin dashboard is reached"
  value       = local.admin_url
}

output "dns_records_to_create" {
  description = "If you manage DNS elsewhere: create A records pointing both domains at this address"
  value       = aws_eip.server.public_ip
}

output "server_instance_id" {
  description = "EC2 instance ID (open a shell with Session Manager in the AWS console)"
  value       = aws_instance.server.id
}

output "dynamodb_table_name" {
  description = "DynamoDB table holding video records"
  value       = aws_dynamodb_table.videos.name
}

output "cdn_domain_name" {
  description = "CloudFront distribution domain name (if CDN is enabled)"
  value       = var.enable_cdn ? aws_cloudfront_distribution.hls_cdn[0].domain_name : "CDN not enabled"
}

output "cdn_base_url" {
  description = "Full CDN base URL to set as CDN_BASE_URL env var"
  value       = var.enable_cdn ? "https://${aws_cloudfront_distribution.hls_cdn[0].domain_name}" : ""
}

output "users_table_name" {
  description = "DynamoDB table holding viewer accounts, My List and watch progress"
  value       = aws_dynamodb_table.users.name
}
