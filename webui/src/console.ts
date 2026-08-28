/**
 * Terminal console UI component — xterm.js style without xterm.
 * Renders a canvas grid; handles keyboard input.
 *
 * The kernel drives the prompt and echo: Enter hands the line to onInput
 * and the kernel prints its own newline + prompt.  ANSI escapes are
 * handled minimally (\x1b[2J clear screen, \x1b[H cursor home) for the
 * shell's "clear" command.
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
  private cursorOn = true;
  /** Forwarded to the kernel: "\n" on Enter, "\x7f" on Backspace,
   *  otherwise the printable character.  The kernel owns the echo. */
  private onKey: (key: string) => void;

  constructor(parent: HTMLElement, onKey: (key: string) => void) {
    this.onKey = onKey;
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = "background:#101113;color:#ffb454;font-family:'IBM Plex Mono',ui-monospace,monospace;display:block;";
    this.ctx = this.canvas.getContext("2d")!;
    parent.appendChild(this.canvas);
    this.resize();
    this.bindKeys();
    this.buffer = Array(this.rows).fill("");
    // blink the shell cursor once the terminal is up
    setInterval(() => {
      this.cursorOn = !this.cursorOn;
      this.redraw();
    }, 530);
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
        e.preventDefault();
        this.onKey("\n");
        return;
      }
      if (e.key === "Backspace") {
        e.preventDefault();
        this.onKey("\x7f");
        return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        this.onKey(e.key);
      }
    });
  }

  print(text: string) {
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === undefined) {
        i++;
        continue;
      }
      if (ch === "\x1b") {
        // minimal ANSI: consume ESC [ ... final byte
        if (text[i + 1] === "[") {
          let j = i + 2;
          while (j < text.length && !/[A-Za-z]/.test(text[j] ?? "")) j++;
          const final = text[j];
          const params = text.slice(i + 2, j);
          if (final === "J" && params === "2") this.clearScreen();
          if (final === "H") this.cursor = { r: 0, c: 0 };
          i = j + 1;
          continue;
        }
        i++;
        continue;
      }
      if (ch === "\n") this.newLine();
      else if (ch === "\r") this.cursor.c = 0;
      else if (ch === "\b") this.backspace();
      else this.putChar(ch);
      i++;
    }
    this.redraw();
  }

  /** Erase the character left of the cursor (kernel backspace echo). */
  private backspace() {
    if (this.cursor.c > 0) {
      this.cursor.c--;
      const line = this.buffer[this.cursor.r] ?? "";
      this.buffer[this.cursor.r] = line.slice(0, this.cursor.c) + " " + line.slice(this.cursor.c + 1);
    }
  }

  private clearScreen() {
    this.buffer = Array(this.rows).fill("");
    this.cursor = { r: 0, c: 0 };
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
    this.ctx.fillStyle = "#101113";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.font = `${this.fontH}px 'IBM Plex Mono', monospace`;
    this.ctx.fillStyle = "#ffb454";
    const start = Math.max(0, this.buffer.length - this.rows);
    for (let i = 0; i < this.rows; i++) {
      const line = this.buffer[start + i] || "";
      this.ctx.fillText(line, 2, (i + 1) * this.fontH - 2);
    }
    // cursor (blinks)
    if (this.cursorOn) {
      const cr = this.cursor.r - start;
      if (cr >= 0 && cr < this.rows) {
        const cx = 2 + this.cursor.c * this.fontW;
        const cy = (cr + 1) * this.fontH - 2;
        this.ctx.fillStyle = "#ffb454";
        this.ctx.fillRect(cx, cy - this.fontH + 2, this.fontW, this.fontH - 2);
      }
    }
  }
}
