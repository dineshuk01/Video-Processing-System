# ─────────────────────────────────────────────────────────────────
# Video Processing System — AWS Infrastructure (Terraform)
# ─────────────────────────────────────────────────────────────────
# This module provisions the complete AWS backend:
#   • S3 buckets (raw uploads + HLS public)
#   • SQS queue + Dead Letter Queue
#   • ECS Fargate cluster, task definitions, and services
#   • IAM roles and policies
#   • CloudFront CDN distribution (optional)
# ─────────────────────────────────────────────────────────────────

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "Terraform"
    }
  }
}

# ═════════════════════════════════════════════════════════════════
# S3 BUCKETS
# ═════════════════════════════════════════════════════════════════

# ─── Raw Upload Bucket (Temporary) ──────────────────────────────
resource "aws_s3_bucket" "raw_uploads" {
  bucket = "${var.project_name}-${var.environment}-${var.raw_bucket_name}"
}

resource "aws_s3_bucket_lifecycle_configuration" "raw_lifecycle" {
  bucket = aws_s3_bucket.raw_uploads.id

  rule {
    id     = "auto-delete-raw-uploads"
    status = "Enabled"

    expiration {
      days = var.raw_expiration_days
    }

    filter {
      prefix = "raw/"
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "raw_cors" {
  bucket = aws_s3_bucket.raw_uploads.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["PUT", "POST"]
    allowed_origins = ["*"]
    max_age_seconds = 3600
  }
}

resource "aws_s3_bucket_public_access_block" "raw_block" {
  bucket                  = aws_s3_bucket.raw_uploads.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ─── Public HLS Bucket ──────────────────────────────────────────
resource "aws_s3_bucket" "hls_public" {
  bucket = "${var.project_name}-${var.environment}-${var.public_bucket_name}"
}

resource "aws_s3_bucket_cors_configuration" "hls_cors" {
  bucket = aws_s3_bucket.hls_public.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = ["*"]
    max_age_seconds = 86400
  }
}

resource "aws_s3_bucket_public_access_block" "hls_block" {
  bucket                  = aws_s3_bucket.hls_public.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ═════════════════════════════════════════════════════════════════
# SQS QUEUES
# ═════════════════════════════════════════════════════════════════

# ─── Dead Letter Queue ──────────────────────────────────────────
resource "aws_sqs_queue" "transcode_dlq" {
  name                      = "${var.project_name}-${var.environment}-${var.dlq_name}"
  message_retention_seconds = 1209600 # 14 days
}

# ─── Main Transcode Queue ──────────────────────────────────────
resource "aws_sqs_queue" "transcode_queue" {
  name                       = "${var.project_name}-${var.environment}-${var.queue_name}"
  visibility_timeout_seconds = 900  # 15 minutes (transcoding can take a while)
  message_retention_seconds  = 86400 # 1 day

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.transcode_dlq.arn
    maxReceiveCount     = var.max_receive_count
  })
}

# ═════════════════════════════════════════════════════════════════
# IAM ROLES & POLICIES
# ═════════════════════════════════════════════════════════════════

# ─── ECS Task Execution Role (pull images, write logs) ─────────
resource "aws_iam_role" "ecs_execution_role" {
  name = "${var.project_name}-${var.environment}-ecs-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution_policy" {
  role       = aws_iam_role.ecs_execution_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ─── ECS Task Role (app-level access to S3, SQS) ──────────────
resource "aws_iam_role" "ecs_task_role" {
  name = "${var.project_name}-${var.environment}-ecs-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_policy" "app_policy" {
  name        = "${var.project_name}-${var.environment}-app-policy"
  description = "S3 + SQS access for the video processing application"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "S3Access"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket",
          "s3:HeadObject"
        ]
        Resource = [
          aws_s3_bucket.raw_uploads.arn,
          "${aws_s3_bucket.raw_uploads.arn}/*",
          aws_s3_bucket.hls_public.arn,
          "${aws_s3_bucket.hls_public.arn}/*"
        ]
      },
      {
        Sid    = "S3PresignedUrls"
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject"]
        Resource = [
          "${aws_s3_bucket.raw_uploads.arn}/*"
        ]
      },
      {
        Sid    = "SQSAccess"
        Effect = "Allow"
        Action = [
          "sqs:SendMessage",
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
          "sqs:GetQueueUrl"
        ]
        Resource = [
          aws_sqs_queue.transcode_queue.arn,
          aws_sqs_queue.transcode_dlq.arn
        ]
      },
      {
        Sid    = "ECSRunTask"
        Effect = "Allow"
        Action = [
          "ecs:RunTask",
          "ecs:DescribeTasks",
          "iam:PassRole"
        ]
        Resource = ["*"]
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "task_app_policy" {
  role       = aws_iam_role.ecs_task_role.name
  policy_arn = aws_iam_policy.app_policy.arn
}

# ═════════════════════════════════════════════════════════════════
# ECS CLUSTER & TASK DEFINITIONS
# ═════════════════════════════════════════════════════════════════

resource "aws_ecs_cluster" "main" {
  name = "${var.project_name}-${var.environment}-${var.ecs_cluster_name}"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

# ─── CloudWatch Log Groups ─────────────────────────────────────
resource "aws_cloudwatch_log_group" "api_logs" {
  name              = "/ecs/${var.project_name}-${var.environment}/api"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "worker_logs" {
  name              = "/ecs/${var.project_name}-${var.environment}/worker"
  retention_in_days = 30
}

# ─── API Server Task Definition ────────────────────────────────
resource "aws_ecs_task_definition" "api" {
  family                   = "${var.project_name}-${var.environment}-api"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.ecs_execution_role.arn
  task_role_arn            = aws_iam_role.ecs_task_role.arn

  container_definitions = jsonencode([{
    name      = "api"
    image     = var.api_container_image
    essential = true

    portMappings = [{
      containerPort = 5000
      protocol      = "tcp"
    }]

    environment = [
      { name = "PORT",              value = "5000" },
      { name = "PROVIDER",          value = "aws" },
      { name = "AWS_REGION",        value = var.aws_region },
      { name = "AWS_S3_TEMP_BUCKET",   value = aws_s3_bucket.raw_uploads.id },
      { name = "AWS_S3_PUBLIC_BUCKET", value = aws_s3_bucket.hls_public.id },
      { name = "AWS_SQS_QUEUE_URL",    value = aws_sqs_queue.transcode_queue.url },
      { name = "ECS_CLUSTER_NAME",     value = aws_ecs_cluster.main.name },
      { name = "ECS_TASK_DEFINITION",  value = "${var.project_name}-${var.environment}-worker" },
      { name = "ECS_CONTAINER_NAME",   value = "worker" },
      { name = "ECS_SUBNETS",          value = join(",", var.subnet_ids) },
      { name = "MAX_UPLOAD_SIZE_MB",   value = "1000" },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.api_logs.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "api"
      }
    }
  }])
}

# ─── Worker / Transcoder Task Definition ───────────────────────
resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.project_name}-${var.environment}-worker"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.worker_cpu
  memory                   = var.worker_memory
  execution_role_arn       = aws_iam_role.ecs_execution_role.arn
  task_role_arn            = aws_iam_role.ecs_task_role.arn

  container_definitions = jsonencode([{
    name      = "worker"
    image     = var.worker_container_image
    essential = true

    entryPoint = ["node", "dist/worker.js"]

    environment = [
      { name = "PORT",              value = "5000" },
      { name = "PROVIDER",          value = "aws" },
      { name = "AWS_REGION",        value = var.aws_region },
      { name = "AWS_S3_TEMP_BUCKET",   value = aws_s3_bucket.raw_uploads.id },
      { name = "AWS_S3_PUBLIC_BUCKET", value = aws_s3_bucket.hls_public.id },
      { name = "AWS_SQS_QUEUE_URL",    value = aws_sqs_queue.transcode_queue.url },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.worker_logs.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "worker"
      }
    }
  }])
}

# ─── Security Group for ECS Tasks ──────────────────────────────
resource "aws_security_group" "ecs_tasks" {
  name        = "${var.project_name}-${var.environment}-ecs-sg"
  description = "Security group for ECS Fargate tasks"
  vpc_id      = var.vpc_id

  ingress {
    from_port   = 5000
    to_port     = 5000
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow inbound HTTP to API"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound traffic"
  }
}

# ─── API ECS Service ───────────────────────────────────────────
resource "aws_ecs_service" "api" {
  name            = "${var.project_name}-${var.environment}-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = true
  }
}

# ═════════════════════════════════════════════════════════════════
# CLOUDFRONT CDN (Optional)
# ═════════════════════════════════════════════════════════════════

# Origin Access Identity for CloudFront → S3
resource "aws_cloudfront_origin_access_identity" "oai" {
  count   = var.enable_cdn ? 1 : 0
  comment = "${var.project_name} HLS CDN OAI"
}

# S3 bucket policy allowing CloudFront OAI read access
resource "aws_s3_bucket_policy" "hls_cdn_policy" {
  count  = var.enable_cdn ? 1 : 0
  bucket = aws_s3_bucket.hls_public.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontRead"
      Effect    = "Allow"
      Principal = {
        AWS = aws_cloudfront_origin_access_identity.oai[0].iam_arn
      }
      Action   = "s3:GetObject"
      Resource = "${aws_s3_bucket.hls_public.arn}/*"
    }]
  })
}

resource "aws_cloudfront_distribution" "hls_cdn" {
  count   = var.enable_cdn ? 1 : 0
  enabled = true
  comment = "${var.project_name} HLS Streaming CDN"

  origin {
    domain_name = aws_s3_bucket.hls_public.bucket_regional_domain_name
    origin_id   = "S3-HLS-Origin"

    s3_origin_config {
      origin_access_identity = aws_cloudfront_origin_access_identity.oai[0].cloudfront_access_identity_path
    }
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "S3-HLS-Origin"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    forwarded_values {
      query_string = false
      headers      = ["Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers"]

      cookies {
        forward = "none"
      }
    }

    min_ttl     = 0
    default_ttl = 86400   # 1 day
    max_ttl     = 2592000 # 30 days
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
