// Keep provider errors and ffmpeg diagnostics useful without retaining credentials.
export function redactLogText(text: string): string {
  const safe = text.replace(/\b([a-z][a-z\d+.-]*:\/\/)[^\s]*@/gi, '$1[REDACTED]@')
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]');
  const variants = new Set<string>();
  for (const name of ['RTSP_PASSWORD', 'RTSP_USERNAME', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY_EUS',
    'AZURE_OPENAI_API_KEY_EUS2', 'AZURE_OPENAI_RESOURCE_NAME_EUS', 'AZURE_OPENAI_RESOURCE_NAME_EUS2', 'HOME_ASSISTANT_TOKEN']) {
    const secret = process.env[name];
    if (!secret) continue;
    const values = [secret];
    if (name.startsWith('AZURE_OPENAI_')) values.push(secret.trim());
    if (name.startsWith('AZURE_OPENAI_RESOURCE_NAME_')) values.push(secret.trim().toLowerCase());
    for (const value of values) {
      if (!value) continue;
      variants.add(value);
      variants.add(encodeURIComponent(value));
    }
  }
  if (!variants.size) return safe;
  const pattern = [...variants]
    .sort((a, b) => b.length - a.length)
    .map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return safe.replace(new RegExp(pattern, 'g'), '[REDACTED]');
}

export function safeErrorDetails(error: unknown): { message: string; statusCode?: number } {
  const value = error as { message?: unknown; statusCode?: unknown; response?: { status?: unknown } } | null;
  const status = value?.statusCode ?? value?.response?.status;
  return {
    message: redactLogText(typeof value?.message === 'string' ? value.message : String(error)),
    ...(typeof status === 'number' ? { statusCode: status } : {}),
  };
}
