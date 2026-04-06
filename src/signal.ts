// src/signal.ts — Signal client wrapper using signal-cli daemon mode

import { spawn, execFileSync } from "child_process";
import { EventEmitter } from "events";
import readline from "readline";

export interface SignalMessage {
  sender: string;         // Phone number e.g. "+819012345678"
  text: string;
  timestamp: number;
  groupId?: string;       // If sent in a group
  attachments?: string[]; // File paths of received attachments
}

export class SignalClient extends EventEmitter {
  private number: string;
  private process: ReturnType<typeof spawn> | null = null;

  constructor(number: string) {
    super();
    this.number = number;
  }

  async start(): Promise<void> {
    // Start signal-cli in daemon mode with JSON output
    this.process = spawn("signal-cli", [
      "-u", this.number,
      "daemon", "--json",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (!this.process.stdout) {
      throw new Error("Failed to start signal-cli daemon");
    }

    // Parse JSON lines from stdout
    const rl = readline.createInterface({ input: this.process.stdout });

    rl.on("line", (line) => {
      try {
        const data = JSON.parse(line);
        this.handleEnvelope(data);
      } catch {
        // Not all lines are JSON (startup messages, etc.)
      }
    });

    this.process.stderr?.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) console.error(`[signal] ${msg}`);
    });

    this.process.on("exit", (code) => {
      console.error(`[signal] Daemon exited with code ${code}`);
      // Auto-restart after 5 seconds
      setTimeout(() => this.start(), 5000);
    });

    console.log(`[signal] Daemon started for ${this.number}`);
  }

  private handleEnvelope(data: any): void {
    // signal-cli JSON output format
    const envelope = data.envelope;
    if (!envelope) return;

    const dataMessage = envelope.dataMessage;
    if (!dataMessage) return;

    // Skip empty messages
    if (!dataMessage.message && (!dataMessage.attachments || dataMessage.attachments.length === 0)) return;

    const message: SignalMessage = {
      sender: envelope.source,
      text: dataMessage.message || "",
      timestamp: dataMessage.timestamp,
      groupId: dataMessage.groupInfo?.groupId,
      attachments: dataMessage.attachments?.map((a: any) => a.filename).filter(Boolean),
    };

    this.emit("message", message);
  }

  async send(recipient: string, text: string): Promise<void> {
    try {
      execFileSync("signal-cli", [
        "-u", this.number,
        "send",
        "-m", text,
        recipient,
      ], { timeout: 15000 });
    } catch (error) {
      console.error(`[signal] Send failed: ${error}`);
      throw error;
    }
  }

  async sendImage(recipient: string, text: string, imagePath: string): Promise<void> {
    try {
      execFileSync("signal-cli", [
        "-u", this.number,
        "send",
        "-m", text,
        "-a", imagePath,
        recipient,
      ], { timeout: 15000 });
    } catch (error) {
      console.error(`[signal] Send image failed: ${error}`);
      throw error;
    }
  }

  stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }
}
