// The public URL of a file in the public bucket (HLS output, thumbnails). It mirrors how the
// transcoder builds the URLs it stores: CDN first, then S3, then this app's own media route.
export function publicUrlFor(key: string): string {
  const cdn = process.env.CDN_BASE_URL;
  if (cdn) return `${cdn.replace(/\/+$/, '')}/${key}`;
  if (process.env.PROVIDER === 'aws') {
    return `https://${process.env.AWS_S3_PUBLIC_BUCKET}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${key}`;
  }
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  return `${base}/api/local-s3/${process.env.LOCAL_S3_PUBLIC_BUCKET}/${key}`;
}

export const publicBucketName = () =>
  process.env.PROVIDER === 'aws' ? process.env.AWS_S3_PUBLIC_BUCKET! : process.env.LOCAL_S3_PUBLIC_BUCKET!;
