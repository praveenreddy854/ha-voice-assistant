import fs from "fs";
import path from "path";

export class PromptTemplateService {
  private readonly promptRoot: string;
  private readonly cache: Map<string, string>;

  constructor(promptRoot: string, cache?: Map<string, string>) {
    this.promptRoot = promptRoot;
    this.cache = cache ?? new Map<string, string>();
  }

  public load(templateName: string): string {
    const cacheKey = `PROMPT:${templateName}`;

    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey) || "";
    }

    const filePath = path.join(this.promptRoot, templateName);

    if (!fs.existsSync(filePath)) {
      throw new Error(`Prompt file not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, "utf8");
    this.cache.set(cacheKey, content);
    return content;
  }

  public render(
    templateName: string,
    replacements: Record<string, string>
  ): string {
    let rendered = this.load(templateName);

    for (const [key, value] of Object.entries(replacements)) {
      rendered = rendered.split(key).join(value);
    }

    return rendered;
  }
}
