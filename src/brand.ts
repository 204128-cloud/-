import { readFile } from "node:fs/promises";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

type LogoPixels = { width: number; height: number; pixels: number[][] };

export class BrandHeaderComponent implements Component {
  private readonly images: { width: number; lines: string[] }[];
  private readonly details: { model: string; taskId?: string };

  constructor(logo: LogoPixels, details: { model: string; taskId?: string }) {
    this.details = details;
    if (!logo || !Number.isInteger(logo.width) || logo.width < 1 || logo.width > 32
      || !Number.isInteger(logo.height) || logo.height < 2 || logo.height > 32 || logo.height % 2
      || !Array.isArray(logo.pixels) || logo.pixels.length !== logo.height
      || !logo.pixels.every(row => Array.isArray(row) && row.length === logo.width * 3
        && row.every(value => Number.isInteger(value) && value >= 0 && value <= 255))) {
      throw new Error("Invalid brand logo");
    }
    this.images = [32, 24, 16].map(size => {
      const width = Math.min(size, logo.width);
      const height = 2 * Math.ceil(logo.height * width / logo.width / 2);
      const pixel = (x: number, y: number) => {
        const row = logo.pixels[Math.floor(y * logo.height / height)];
        const offset = Math.floor(x * logo.width / width) * 3;
        return row.slice(offset, offset + 3).join(";");
      };
      const lines: string[] = [];
      for (let y = 0; y < height; y += 2) {
        let line = "";
        for (let x = 0; x < width; x++) {
          line += `\x1b[38;2;${pixel(x, y)}m\x1b[48;2;${pixel(x, y + 1)}m▀`;
        }
        lines.push(`${line}\x1b[0m`);
      }
      return { width, lines };
    });
  }

  render(width: number, height = 24): string[] {
    if (width <= 0 || height <= 0) return [];
    const title = "\x1b[1;38;2;112;224;214m欢迎使用 RepoPilot\x1b[0m";
    const metadata = this.details.model + (this.details.taskId ? ` · 任务 ${this.details.taskId}` : "");
    let lines: string[];
    if (width < 32 || height < 9) {
      lines = ["RepoPilot", "欢迎使用，我是你的 AI 编程助手。", metadata];
    } else {
      lines = [title, "",
        ...wrapTextWithAnsi("我是你的 AI 编程助手，支持对话与图片理解，", width),
        ...wrapTextWithAnsi("协助定位问题、生成补丁，并验收修复结果。", width),
        "", ...wrapTextWithAnsi(metadata, width)];
      const image = this.images.find(image => image.width <= width && image.lines.length + 1 + lines.length <= height);
      if (image) lines = [...image.lines, "", ...lines];
    }
    lines = lines.slice(0, height).map(line => {
      const clipped = truncateToWidth(line, width, "");
      return " ".repeat(Math.floor((width - visibleWidth(clipped)) / 2)) + clipped;
    });
    const padding = height - lines.length;
    return [...Array<string>(Math.floor(padding / 2)).fill(""), ...lines,
      ...Array<string>(Math.ceil(padding / 2)).fill("")];
  }

  invalidate(): void {}
}

export async function loadBrandHeader(details: { model: string; taskId?: string }): Promise<BrandHeaderComponent> {
  const asset = new URL("../assets/logo-terminal.json", import.meta.url);
  return new BrandHeaderComponent(JSON.parse(await readFile(asset, "utf8")) as LogoPixels, details);
}
