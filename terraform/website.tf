# ─────────────────────────────────────────────────────────────────
# Viewer website (its code lives in its own repository: videostream-web)
# ─────────────────────────────────────────────────────────────────
# One CloudFront address serves both:
#   /*      the static website files, from a private S3 bucket
#   /api/*  the user API on the server (sign-in, catalogue, My List, progress)
# Because both share one address, the login cookie works without any cross-site setup, and viewers
# get HTTPS on the cloudfront.net address before any domain is bought.

resource "aws_s3_bucket" "website" {
  bucket = "${var.project_name}-${var.environment}-website"
}

resource "aws_s3_bucket_public_access_block" "website" {
  bucket                  = aws_s3_bucket.website.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_cloudfront_origin_access_control" "website" {
  name                              = "${var.project_name}-${var.environment}-website"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Only this distribution may read the bucket
resource "aws_s3_bucket_policy" "website" {
  bucket = aws_s3_bucket.website.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.website.arn}/*"
      Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.website.arn } }
    }]
  })
}

# The API needs every cookie, header and query string, and tells the server the visitor used HTTPS
resource "aws_cloudfront_origin_request_policy" "api" {
  name = "${var.project_name}-${var.environment}-api"

  cookies_config {
    cookie_behavior = "all"
  }
  headers_config {
    header_behavior = "allViewerAndWhitelistCloudFront"
    headers {
      items = ["CloudFront-Forwarded-Proto"]
    }
  }
  query_strings_config {
    query_string_behavior = "all"
  }
}

locals {
  # AWS managed cache policies
  cache_optimized = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  cache_disabled  = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
}

resource "aws_cloudfront_distribution" "website" {
  enabled             = true
  comment             = "${var.project_name} viewer website"
  default_root_object = "index.html"
  price_class         = "PriceClass_200" # includes India

  origin {
    origin_id                = "website"
    domain_name              = aws_s3_bucket.website.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.website.id
  }

  origin {
    origin_id   = "api"
    domain_name = aws_eip.server.public_dns
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "website"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = local.cache_optimized
    compress               = true
  }

  ordered_cache_behavior {
    path_pattern             = "/api/*"
    target_origin_id         = "api"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = local.cache_disabled
    origin_request_policy_id = aws_cloudfront_origin_request_policy.api.id
    compress                 = true
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

output "website_url" {
  description = "The viewer website (HTTPS)"
  value       = "https://${aws_cloudfront_distribution.website.domain_name}/"
}

output "website_bucket" {
  description = "Where the website files are uploaded (used by the website repo's deploy script)"
  value       = aws_s3_bucket.website.id
}

output "website_distribution_id" {
  description = "CloudFront distribution to refresh after a deploy"
  value       = aws_cloudfront_distribution.website.id
}
