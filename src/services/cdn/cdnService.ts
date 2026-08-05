import { Logger } from '../../utils/logger';

/**
 * CDN Service — Abstracts streaming URL generation through CDN domains.
 * 
 * When CDN_BASE_URL is configured, all public asset URLs (HLS manifests, segments,
 * poster images) are served via the CDN domain instead of directly from S3 or
 * the local mock storage.
 * 
 * For AWS deployments, this would typically be a CloudFront distribution URL
 * pointed at the S3 public bucket (e.g. https://d1234abcde.cloudfront.net).
 * 
 * For local development, leave CDN_BASE_URL unset to use direct local S3 URLs.
 */
export class CdnService {
  private baseUrl: string | null;

  constructor() {
    this.baseUrl = process.env.CDN_BASE_URL || null;
    if (this.baseUrl) {
      // Remove trailing slash for consistency
      this.baseUrl = this.baseUrl.replace(/\/+$/, '');
      Logger.info(`CDN Service initialized with base URL: ${this.baseUrl}`);
    }
  }

  /**
   * Check if CDN is enabled.
   */
  isEnabled(): boolean {
    return this.baseUrl !== null;
  }

  /**
   * Build a CDN-accelerated URL for a given object key.
   * Falls back to the raw URL if CDN is not configured.
   */
  buildUrl(objectKey: string, fallbackUrl: string): string {
    if (!this.baseUrl) {
      return fallbackUrl;
    }
    // Ensure objectKey doesn't start with slash
    const cleanKey = objectKey.replace(/^\/+/, '');
    return `${this.baseUrl}/${cleanKey}`;
  }

  /**
   * Build the HLS playlist URL for a video.
   */
  getPlaylistUrl(outputKeyPrefix: string, fallbackUrl: string): string {
    return this.buildUrl(`${outputKeyPrefix}/master.m3u8`, fallbackUrl);
  }

  /**
   * Build the poster/thumbnail URL for a video.
   */
  getPosterUrl(outputKeyPrefix: string, fallbackUrl: string): string {
    return this.buildUrl(`${outputKeyPrefix}/poster.jpg`, fallbackUrl);
  }

  /**
   * Build the subtitle VTT URL for a video.
   */
  getSubtitleUrl(outputKeyPrefix: string, fileName: string, fallbackUrl: string): string {
    return this.buildUrl(`${outputKeyPrefix}/${fileName}`, fallbackUrl);
  }
}

// Export singleton instance
export const cdnService = new CdnService();
