/**
 * Terminal console UI component: xterm.js style without xterm.
 * Renders a canvas grid; handles keyboard input.
 */
export class Console {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private rows = 30;
  private cols = 100;
  private fontW = 9;
  private fontH = 18;
  private buffer: string[] = [];
  private cursor = { r: 0, c: 0 };
  private scrollback = 0;
  private inputBuffer = "";
  private onInput: (line: string) => void;

  constructor(parent: HTMLElement, onInput: (line: string) => void) {
    this.onInput = onInput;
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = "background:#1a1a2e;color:#e0e0e0;font-family:monospace;display:block;";
    this.ctx = this.canvas.getContext("2d")!;
    parent.appendChild(this.canvas);
    this.resize();
    this.bindKeys();
    this.buffer = Array(this.rows).fill("");
    this.print("\nwasmux console ready, type commands\n> ");
  }

  private resize() {
    const rect = this.canvas.parentElement!.getBoundingClientRect();
    this.canvas.width = rect.width;
    this.canvas.height = rect.height;
    this.cols = Math.max(1, Math.floor(this.canvas.width / this.fontW));
    this.rows = Math.max(1, Math.floor(this.canvas.height / this.fontH));
    while (this.buffer.length < this.rows) this.buffer.push("");
    while (this.buffer.length > this.rows) this.buffer.shift();
  }

  private bindKeys() {
    window.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        this.print("\n");
        this.onInput(this.inputBuffer);
        this.inputBuffer = "";
        this.print("> ");
        return;
      }
      if (e.key === "Backspace") {
        if (this.inputBuffer.length) {
          this.inputBuffer = this.inputBuffer.slice(0, -1);
          this.redraw();
        }
        e.preventDefault();
        return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        this.inputBuffer += e.key;
        this.print(e.key);
        e.preventDefault();
      }
    });
  }

  print(text: string) {
    for (const ch of text) {
      if (ch === "\n") this.newLine();
      else if (ch === "\r") this.cursor.c = 0;
      else this.putChar(ch);
    }
    this.redraw();
  }

  private putChar(ch: string) {
    if (this.cursor.c >= this.cols) this.newLine();
    const line = this.buffer[this.cursor.r] ?? "";
    this.buffer[this.cursor.r] = line.slice(0, this.cursor.c) + ch + line.slice(this.cursor.c + 1);
    this.cursor.c++;
  }

  private newLine() {
    this.cursor.r++;
    this.cursor.c = 0;
    if (this.cursor.r >= this.rows) {
      this.buffer.shift();
      this.buffer.push("");
      this.cursor.r = this.rows - 1;
    }
  }

  redraw() {
    this.ctx.fillStyle = "#1a1a2e";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.font = `${this.fontH}px monospace`;
    this.ctx.fillStyle = "#e0e0e0";
    const start = Math.max(0, this.buffer.length - this.rows);
    for (let i = 0; i < this.rows; i++) {
      const line = this.buffer[start + i] || "";
      this.ctx.fillText(line, 2, (i + 1) * this.fontH - 2);
    }
    // cursor
    const cr = this.cursor.r - start;
    if (cr >= 0 && cr < this.rows) {
      const cx = 2 + this.cursor.c * this.fontW;
      const cy = (cr + 1) * this.fontH - 2;
      this.ctx.fillStyle = "#fff";
      this.ctx.fillRect(cx, cy - this.fontH + 2, this.fontW, this.fontH - 2);
    }
  }
}