# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Video Processing System â€” AWS Infrastructure (Terraform)
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# This module provisions the complete AWS backend:
#   â€¢ S3 buckets (raw uploads + HLS public)
#   â€¢ SQS queue + Dead Letter Queue
#   â€¢ One small EC2 server (website, admin, queue worker)
#   â€¢ ECS Fargate cluster + one-shot transcoder task (runs only while a video encodes)
#   â€¢ DynamoDB table for video records
#   â€¢ IAM roles and policies
#   â€¢ CloudFront CDN distribution (optional)
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
# S3 BUCKETS
# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

# â”€â”€â”€ Raw Upload Bucket (Temporary) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

# â”€â”€â”€ Public HLS Bucket â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
# SQS QUEUES
# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

# â”€â”€â”€ Dead Letter Queue â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
resource "aws_sqs_queue" "transcode_dlq" {
  name                      = "${var.project_name}-${var.environment}-${var.dlq_name}"
  message_retention_seconds = 1209600 # 14 days
}

# â”€â”€â”€ Main Transcode Queue â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
resource "aws_sqs_queue" "transcode_queue" {
  name                       = "${var.project_name}-${var.environment}-${var.queue_name}"
  visibility_timeout_seconds = 3600 # 1 hour: the worker holds the message while the transcoder task runs
  message_retention_seconds  = 86400 # 1 day

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.transcode_dlq.arn
    maxReceiveCount     = var.max_receive_count
  })
}

# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
# DYNAMODB (video records)
# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

resource "aws_dynamodb_table" "videos" {
  name         = "${var.project_name}-${var.environment}-${var.dynamodb_table_name}"
  billing_mode = "PAY_PER_REQUEST" # on-demand: near-zero cost when idle
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }

  # Every item stores entity = "VIDEO" so this index can list all videos newest-first
  attribute {
    name = "entity"
    type = "S"
  }

  attribute {
    name = "createdAt"
    type = "S"
  }

  global_secondary_index {
    name            = "createdAt-index"
    hash_key        = "entity"
    range_key       = "createdAt"
    projection_type = "ALL"
  }
}

# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
# IAM ROLES & POLICIES
# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

# â”€â”€â”€ ECS Task Execution Role (pull images, write logs) â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

# â”€â”€â”€ ECS Task Role (app-level access to S3, SQS) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        Sid    = "DynamoDBAccess"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query"
        ]
        Resource = [
          aws_dynamodb_table.videos.arn,
          "${aws_dynamodb_table.videos.arn}/index/*"
        ]
      },
      {
        Sid    = "ECSRunTask"
        Effect = "Allow"
        Action = [
          "ecs:RunTask",
          "ecs:DescribeTasks",
          "ecs:StopTask",
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

# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
# ECS (encoding only)
# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
# Nothing runs on ECS between videos: the server's worker starts one Fargate task per video
# (RunTask), waits for it to finish and the task then stops. You pay per second while it encodes.

resource "aws_ecs_cluster" "main" {
  name = "${var.project_name}-${var.environment}-${var.ecs_cluster_name}"
}

resource "aws_cloudwatch_log_group" "transcoder_logs" {
  name              = "/ecs/${var.project_name}-${var.environment}/transcoder"
  retention_in_days = 14
}

resource "aws_ecs_task_definition" "transcoder" {
  family                   = "${var.project_name}-${var.environment}-transcoder"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.transcoder_cpu
  memory                   = var.transcoder_memory
  execution_role_arn       = aws_iam_role.ecs_execution_role.arn
  task_role_arn            = aws_iam_role.ecs_task_role.arn

  # The source video and every rendition are held on local disk while encoding
  ephemeral_storage {
    size_in_gib = var.transcoder_disk_gib
  }

  container_definitions = jsonencode([{
    name      = "transcoder"
    image     = var.container_image
    essential = true

    # The shared image defaults to the transcoder; stated here so it is explicit
    entryPoint = ["node", "dist/transcoderTask.js"]

    # VIDEO_ID, INPUT_*, OUTPUT_* are injected per job by the worker (RunTask overrides)
    environment = [
      { name = "PROVIDER",             value = "aws" },
      { name = "AWS_REGION",           value = var.aws_region },
      { name = "AWS_S3_TEMP_BUCKET",   value = aws_s3_bucket.raw_uploads.id },
      { name = "AWS_S3_PUBLIC_BUCKET", value = aws_s3_bucket.hls_public.id },
      { name = "DYNAMODB_TABLE_NAME",  value = aws_dynamodb_table.videos.name },
      { name = "CDN_BASE_URL",         value = var.enable_cdn ? "https://${aws_cloudfront_distribution.hls_cdn[0].domain_name}" : "" },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.transcoder_logs.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "transcoder"
      }
    }
  }])
}

# Encoding tasks only reach out (S3, DynamoDB, image registry); nothing connects in
resource "aws_security_group" "ecs_tasks" {
  name        = "${var.project_name}-${var.environment}-ecs-sg"
  description = "Security group for the one-shot transcoder tasks"
  vpc_id      = var.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound traffic"
  }
}

# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
# SERVER (EC2): website + admin + queue worker
# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

data "aws_ssm_parameter" "al2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_iam_role" "server" {
  name = "${var.project_name}-${var.environment}-server"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

# Same S3 / SQS / DynamoDB / RunTask access as the tasks
resource "aws_iam_role_policy_attachment" "server_app_policy" {
  role       = aws_iam_role.server.name
  policy_arn = aws_iam_policy.app_policy.arn
}

# Lets you open a shell from the AWS console (Session Manager), so no SSH port is needed
resource "aws_iam_role_policy_attachment" "server_ssm" {
  role       = aws_iam_role.server.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Pulling the image from a private ECR repository
resource "aws_iam_role_policy_attachment" "server_ecr" {
  role       = aws_iam_role.server.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

resource "aws_iam_instance_profile" "server" {
  name = "${var.project_name}-${var.environment}-server"
  role = aws_iam_role.server.name
}

resource "aws_security_group" "server" {
  name        = "${var.project_name}-${var.environment}-server-sg"
  description = "Web access to the server"
  vpc_id      = var.vpc_id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTP (also used for the HTTPS certificate check)"
  }

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTPS"
  }

  # Without an admin domain the dashboard is served on its own port, only to the addresses you allow
  dynamic "ingress" {
    for_each = var.admin_domain == "" ? [1] : []
    content {
      from_port   = 8080
      to_port     = 8080
      protocol    = "tcp"
      cidr_blocks = var.admin_allowed_cidrs
      description = "Admin dashboard (no domain)"
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound traffic"
  }
}

locals {
  registry_host = split("/", var.container_image)[0]

  app_env = join("\n", [
    "PROVIDER=aws",
    "AWS_REGION=${var.aws_region}",
    "AWS_S3_TEMP_BUCKET=${aws_s3_bucket.raw_uploads.id}",
    "AWS_S3_PUBLIC_BUCKET=${aws_s3_bucket.hls_public.id}",
    "AWS_SQS_QUEUE_URL=${aws_sqs_queue.transcode_queue.url}",
    "DYNAMODB_TABLE_NAME=${aws_dynamodb_table.videos.name}",
    "ECS_CLUSTER_NAME=${aws_ecs_cluster.main.name}",
    "ECS_TASK_DEFINITION=${var.project_name}-${var.environment}-transcoder",
    "ECS_CONTAINER_NAME=transcoder",
    "ECS_SUBNETS=${join(",", var.subnet_ids)}",
    "ECS_SECURITY_GROUPS=${aws_security_group.ecs_tasks.id}",
    "MAX_UPLOAD_SIZE_MB=${var.max_upload_size_mb}",
    "WORKER_CONCURRENCY=${var.worker_concurrency}",
    "ADMIN_API_KEY='${var.admin_api_key}'",
    "USER_APP_URL=${local.user_url}",
    "CDN_BASE_URL=${var.enable_cdn ? "https://${aws_cloudfront_distribution.hls_cdn[0].domain_name}" : ""}",
    "PORT=5000",
  ])

  # Where each app is reached. Domains get automatic HTTPS from Caddy; without them: user on :80, admin on :8080
  user_url  = var.user_domain != "" ? "https://${var.user_domain}/" : "http://${aws_eip.server.public_ip}/"
  admin_url = var.admin_domain != "" ? "https://${var.admin_domain}/admin/" : "http://${aws_eip.server.public_ip}:8080/admin/"

  caddyfile = join("\n", [
    var.user_domain != "" ? "${var.user_domain} {\n  reverse_proxy user:5000\n}" : ":80 {\n  reverse_proxy user:5000\n}",
    var.admin_domain != "" ? "${var.admin_domain} {\n  reverse_proxy admin:5000\n}" : ":8080 {\n  reverse_proxy admin:5000\n}",
    "",
  ])

  compose = <<-YAML
    services:
      user:
        image: ${var.container_image}
        entrypoint: ["node", "dist/index.js"]
        env_file: /opt/video/app.env
        environment:
          APP_MODE: user
          PORT: "5000"
        restart: always
      admin:
        image: ${var.container_image}
        entrypoint: ["node", "dist/index.js"]
        env_file: /opt/video/app.env
        environment:
          APP_MODE: admin
          PORT: "5000"
        restart: always
      worker:
        image: ${var.container_image}
        entrypoint: ["node", "dist/worker.js"]
        env_file: /opt/video/app.env
        restart: always
      caddy:
        image: caddy:2
        ports: ["80:80", "443:443", "8080:8080"]
        volumes: ["/opt/video/Caddyfile:/etc/caddy/Caddyfile", "caddy_data:/data"]
        restart: always
    volumes:
      caddy_data:
  YAML
}

resource "aws_instance" "server" {
  ami                         = data.aws_ssm_parameter.al2023_ami.value
  instance_type               = "t3.micro"
  subnet_id                   = var.subnet_ids[0]
  vpc_security_group_ids      = [aws_security_group.server.id]
  iam_instance_profile        = aws_iam_instance_profile.server.name
  associate_public_ip_address = true

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
  }

  metadata_options {
    http_tokens = "required"
  }

  user_data = <<-BASH
    #!/bin/bash
    set -euxo pipefail
    dnf install -y docker
    systemctl enable --now docker
    mkdir -p /usr/local/lib/docker/cli-plugins /opt/video
    curl -fsSL "https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-x86_64" -o /usr/local/lib/docker/cli-plugins/docker-compose
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

    # 1 GB of RAM is tight for the API, the worker and thumbnail extraction: add swap
    fallocate -l 1G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab

    cat > /opt/video/app.env <<'ENVEOF'
    ${local.app_env}
    ENVEOF
    chmod 600 /opt/video/app.env
    cat > /opt/video/Caddyfile <<'CADDYEOF'
    ${local.caddyfile}
    CADDYEOF
    cat > /opt/video/docker-compose.yml <<'COMPOSEEOF'
    ${local.compose}
    COMPOSEEOF

    aws ecr get-login-password --region ${var.aws_region} | docker login --username AWS --password-stdin ${local.registry_host}
    cd /opt/video && docker compose up -d
  BASH

  # Changing the startup script must not replace a server that may be encoding. To change its settings
  # or update the app, run the update steps on the running server instead (see docs/DEPLOY_AWS.md).
  lifecycle {
    ignore_changes = [user_data]
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-server"
  }
}

# A fixed address, so the link (and DNS) survives restarts. Created before the server so its address
# can go into the server's settings (USER_APP_URL), then attached to it.
resource "aws_eip" "server" {
  domain = "vpc"
}

resource "aws_eip_association" "server" {
  instance_id   = aws_instance.server.id
  allocation_id = aws_eip.server.id
}

# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
# CLOUDFRONT CDN (Optional)
# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

# Origin Access Identity for CloudFront â†’ S3
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

# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
# DNS (optional): records for the two domains, when the domain is hosted in Route 53
# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

resource "aws_route53_record" "user" {
  count   = var.route53_zone_id != "" && var.user_domain != "" ? 1 : 0
  zone_id = var.route53_zone_id
  name    = var.user_domain
  type    = "A"
  ttl     = 300
  records = [aws_eip.server.public_ip]
}

resource "aws_route53_record" "admin" {
  count   = var.route53_zone_id != "" && var.admin_domain != "" ? 1 : 0
  zone_id = var.route53_zone_id
  name    = var.admin_domain
  type    = "A"
  ttl     = 300
  records = [aws_eip.server.public_ip]
}
