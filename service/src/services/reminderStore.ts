import fs from "fs";
import path from "path";

export class ReminderStore {
  private readonly generatedDataDir: string;
  private readonly remindersFile: string;
  private readonly processedRemindersFile: string;

  constructor() {
    this.generatedDataDir = path.join(__dirname, "..", "..", "generated_data");
    this.remindersFile = path.join(this.generatedDataDir, "reminders.json");
    this.processedRemindersFile = path.join(
      this.generatedDataDir,
      "processed_reminders.json"
    );

    this.ensureDataDir();
  }

  public readReminders(): unknown[] {
    return this.readArrayFile(this.remindersFile);
  }

  public writeReminders(reminders: unknown[]): void {
    this.writeArrayFile(this.remindersFile, reminders);
  }

  public readProcessedReminders(): string[] {
    const data = this.readArrayFile(this.processedRemindersFile);
    return data.filter((value): value is string => typeof value === "string");
  }

  public writeProcessedReminders(processedReminders: string[]): void {
    this.writeArrayFile(this.processedRemindersFile, processedReminders);
  }

  private ensureDataDir(): void {
    if (!fs.existsSync(this.generatedDataDir)) {
      fs.mkdirSync(this.generatedDataDir, { recursive: true });
    }
  }

  private readArrayFile(filePath: string): unknown[] {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const raw = fs.readFileSync(filePath, "utf8");

    if (!raw.trim()) {
      return [];
    }

    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  }

  private writeArrayFile(filePath: string, data: unknown[]): void {
    this.ensureDataDir();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }
}

export const reminderStore = new ReminderStore();
