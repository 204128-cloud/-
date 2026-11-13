import assert from "node:assert/strict";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { ChatImageError, loadChatImage } from "../src/chat-image.ts";
import * as images from "../src/chat-image.ts";

async function imageFixture(t: TestContext, parent = tmpdir()) {
  const tempRoot = resolve(parent);
  const directory = await mkdtemp(join(tempRoot, "repopilot-chat-image-"));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), tempRoot);
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function rejectsCode(code: string) {
  return (error: unknown) => error instanceof ChatImageError && error.code === code;
}

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mNgYGAAAAAEAAHI6uv5AAAAAElFTkSuQmCC";
const jpeg = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AP7//2Q==";
const webp = "UklGRhoAAABXRUJQVlA4TA4AAAAvAAAAAAcQEf0PRET/Aw==";

test("encodes the local image bytes and detects MIME from the signature", async t => {
  const directory = await imageFixture(t, process.cwd());
  for (const [data, mimeType] of [[png, "image/png"], [jpeg, "image/jpeg"], [webp, "image/webp"]]) {
    const file = join(directory, "sample image.bin");
    await writeFile(file, Buffer.from(data, "base64"));
    assert.deepEqual(await loadChatImage(relative(process.cwd(), file)), { type: "image", data, mimeType });
  }
});

test("rejects a misleading image extension and non-image bytes", async t => {
  const directory = await imageFixture(t);
  const file = join(directory, "sample.png");
  await writeFile(file, "not a PNG");
  await assert.rejects(loadChatImage(file), rejectsCode("CHAT_IMAGE_FORMAT_UNSUPPORTED"));
});

test("accepts 5 MiB and rejects files larger than 5 MiB", async t => {
  const directory = await imageFixture(t);
  const file = join(directory, "sample.png");
  await writeFile(file, Buffer.from(png, "base64"));
  await truncate(file, 5 * 1024 * 1024);
  assert.equal(Buffer.from((await loadChatImage(file)).data, "base64").length, 5 * 1024 * 1024);
  await truncate(file, 5 * 1024 * 1024 + 1);
  await assert.rejects(loadChatImage(file), rejectsCode("CHAT_IMAGE_TOO_LARGE"));
});

test("rejects directory paths as non-files", async t => {
  await assert.rejects(loadChatImage(await imageFixture(t)), rejectsCode("CHAT_IMAGE_NOT_FILE"));
});

test("rejects remote URLs, UNC shares and Windows device paths as invalid input", async () => {
  for (const path of ["https://example.invalid/image.png", "file:///image.png", "//server/share/image.png", "\\\\server\\share\\image.png", "\\\\.\\PhysicalDrive0", "\\\\?\\C:\\image.png", "NUL.png", "C:relative.png", "image.png:stream"]) {
    await assert.rejects(loadChatImage(path), rejectsCode("CHAT_IMAGE_PATH_INVALID"));
  }
});

test("reports unreadable files without echoing the path", async t => {
  const directory = await imageFixture(t);
  const file = join(directory, "unreadable image.png");
  await assert.rejects(loadChatImage(file), error => {
    assert.ok(error instanceof ChatImageError);
    assert.equal(error.code, "CHAT_IMAGE_READ_FAILED");
    assert.doesNotMatch(error.message, /unreadable image|ENOENT/);
    return true;
  });
});

test("loads attachment metadata separately from the model image payload", async t => {
  const directory = await imageFixture(t);
  const file = join(directory, "截图 image.bin");
  const bytes = Buffer.from(png, "base64");
  await writeFile(file, bytes);
  const attachment = await images.loadChatAttachment(file);
  assert.deepEqual(attachment, {
    name: "截图 image.bin", bytes: bytes.length,
    image: { type: "image", mimeType: "image/png", data: png },
  });
  assert.deepEqual(Object.keys(attachment.image).sort(), ["data", "mimeType", "type"]);
  const description = images.formatImageAttachment(attachment);
  assert.equal(description, `截图 image.bin · PNG · ${bytes.length} B`);
  assert.ok(!description.includes(directory));
  assert.ok(!description.includes(png));
  assert.deepEqual(await loadChatImage(file), attachment.image);
});

test("formats readable attachment sizes and signature-derived formats", () => {
  const attachment = { name: "sample.bin", bytes: 1536, image: { type: "image" as const, mimeType: "image/jpeg", data: jpeg } };
  assert.equal(images.formatImageAttachment(attachment), "sample.bin · JPEG · 1.5 KiB");
  assert.equal(images.formatImageAttachment({ ...attachment, bytes: 2 * 1024 * 1024,
    image: { type: "image", mimeType: "image/webp", data: webp } }), "sample.bin · WebP · 2.0 MiB");
});

test("distinguishes attachment inspection, removal and quoted file paths", () => {
  assert.deepEqual(images.parseImageCommand("/image"), { action: "show" });
  assert.deepEqual(images.parseImageCommand("/image   "), { action: "show" });
  assert.deepEqual(images.parseImageCommand("/image clear"), { action: "clear" });
  assert.deepEqual(images.parseImageCommand('/image "clear"'), { action: "attach", path: "clear" });
  assert.deepEqual(images.parseImageCommand("/image 'clear'"), { action: "attach", path: "clear" });
  assert.deepEqual(images.parseImageCommand('/image "D:\\截图\\报错 image.png"'), { action: "attach", path: "D:\\截图\\报错 image.png" });
  assert.deepEqual(images.parseImageCommand("/image local file.png"), { action: "attach", path: "local file.png" });
  for (const command of ["/images", '/image ""', "/image ' ", '/image "broken.png', "/image '\x1b[2J'"]) {
    assert.throws(() => images.parseImageCommand(command), error => error instanceof ChatImageError);
  }
});

test("rejects control characters and credential-bearing attachment paths before reading them", async () => {
  const currentKey = "LOCAL_CURRENT_CREDENTIAL_TEST_ONLY";
  for (const path of ["unsafe\x1b[2J.png", "unsafe\nname.png", "unsafe\tname.png", "sk-LOCAL_FAKE_IMAGE_TEST_ONLY.png", currentKey + ".png"]) {
    await assert.rejects(images.loadChatAttachment(path, currentKey), error => {
      assert.ok(error instanceof ChatImageError);
      assert.equal(error.code, "CHAT_IMAGE_PATH_INVALID");
      assert.ok(!error.message.includes(path));
      assert.ok(!error.message.includes(currentKey));
      return true;
    });
  }
});

test("pasted image input separates a leading local file from its question", () => {
  const path = "C:\\Users\\demo\\Pictures\\微信图片_测试.jpg";
  assert.deepEqual(images.parseImageInput(`"${path}"描述一下这张图片`), { path, prompt: "描述一下这张图片" });
  assert.deepEqual(images.parseImageInput(`'${path}'\n第一行\n第二行`), { path, prompt: "第一行\n第二行" });
  assert.deepEqual(images.parseImageInput('"D:\\截图\\an image.PNG"'), { path: "D:\\截图\\an image.PNG", prompt: "" });
  assert.deepEqual(images.parseImageInput("D:/截图/photo.webp 说明内容"), { path: "D:/截图/photo.webp", prompt: "说明内容" });
  assert.deepEqual(images.parseImageInput('./photo.jpeg'), { path: "./photo.jpeg", prompt: "" });
});

test("pasted image detection leaves ordinary path discussions, URLs and commands as text", () => {
  for (const text of ['请解释 "D:\\photo.png" 的含义', '"D:\\source.ts" 请解释代码',
    '"https://example.invalid/photo.jpg" 描述一下', '/image "D:\\photo.png"', '"photo.png" 是一个文件名',
    '"D:\\photo.png', 'D:\\source.ts', '图片上传有问题']) {
    assert.equal(images.parseImageInput(text), undefined);
  }
});
