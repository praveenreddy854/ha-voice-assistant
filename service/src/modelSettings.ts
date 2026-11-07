// Match the installed OpenAI provider's reasoning-family defaults. Chat variants
// keep sampling support; Azure deployment aliases without a known family retain
// their caller-supplied settings.
export function samplingSettings(model: string, temperature?: number): { temperature?: number } {
  const gpt = /^gpt-(\d+)(?:\.\d+)?(?:-(.+))?$/.exec(model);
  const chat = /^gpt-\d+-chat(?:-|$)/.test(model);
  const reasoning = /^o\d+(?:-|$)/.test(model) || (!!gpt && Number(gpt[1]) >= 5 && !chat);
  return temperature != null && !reasoning ? { temperature } : {};
}
