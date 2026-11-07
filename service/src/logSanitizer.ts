// Keep provider errors and ffmpeg diagnostics useful without retaining credentials.
export function redactLogText(text: string): string {
  let safe = text.replace(/\b([a-z][a-z\d+.-]*:\/\/)[^\s]*@/gi, '$1[REDACTED]@')
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]');
  for (const name of ['RTSP_PASSWORD', 'RTSP_USERNAME', 'AZURE_OPENAI_API_KEY', 'HOME_ASSISTANT_TOKEN']) {
    const secret = process.env[name];
    if (!secret) continue;
    for (const value of new Set([secret, encodeURIComponent(secret)])) {
      safe = safe.split(value).join('[REDACTED]');
    }
  }
  return safe;
}

export function safeErrorDetails(error: unknown): { message: string; statusCode?: number } {
  const value = error as { message?: unknown; statusCode?: unknown; response?: { status?: unknown } } | null;
  const status = value?.statusCode ?? value?.response?.status;
  return {
    message: redactLogText(typeof value?.message === 'string' ? value.message : String(error)),
    ...(typeof status === 'number' ? { statusCode: status } : {}),
  };
}
