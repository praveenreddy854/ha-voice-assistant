import type { Response } from "express";

const clients = new Set<Response>();

export function addAnnouncementClient(res: Response): void {
  clients.add(res);
  res.on("close", () => {
    clients.delete(res);
  });
}

export function emitAnnouncement(message: string): void {
  const payload = JSON.stringify({ message });
  for (const client of clients) {
    client.write(`event: announcement\ndata: ${payload}\n\n`);
  }
}
