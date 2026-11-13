import assert from "node:assert/strict";
import test from "node:test";
import { describeChatStatus, formatChatStatus } from "../src/chat-status.ts";

const fakeKey = "sk-LOCAL_FAKE_STATUS_ONLY";
const model = { provider: "dashscope", id: "qwen3.7-plus", baseUrl: "https://example.test/compatible-mode/v1", input: ["text", "image"] };

test("status projects loaded model metadata and removes URL authentication and parameters", () => {
  const status = describeChatStatus({ ...model, baseUrl: "https://private-user:private-password@example.test/compatible-mode/v1?token=private-query#private-fragment" }, "fixture-task", fakeKey);
  assert.deepEqual(status, { model: "dashscope/qwen3.7-plus", endpoint: model.baseUrl, imageInput: true, taskId: "fixture-task" });
  const text = formatChatStatus(status);
  assert.match(text, /已加载.*未验证鉴权/);
  assert.match(text, /配置声明支持/);
  assert.match(text, /离线.*未发起网络请求/);
  assert.doesNotMatch(text, /private-|sk-|token=/);
  const plain = formatChatStatus(describeChatStatus({ ...model, input: ["text"] }, null, fakeKey));
  assert.match(plain, /配置未声明/);
  assert.match(plain, /未绑定/);
});

test("status never returns credentials or terminal controls from display metadata", () => {
  for (const baseUrl of [
    `https://example.test/${fakeKey}/v1`,
    `https://example.test/${[...fakeKey].map(char => `%${char.charCodeAt(0).toString(16)}`).join("")}/v1`,
    "javascript:private-value", "invalid-private-value", "https://example.test/v1\nprivate-control",
  ]) {
    const status = describeChatStatus({ ...model, baseUrl }, null, fakeKey);
    assert.equal(status.endpoint, "无法安全显示");
    assert.doesNotMatch(JSON.stringify(status), /sk-|private-|%73%6b/i);
  }
  const status = describeChatStatus({ ...model, provider: fakeKey, id: "\x1b[31munsafe" }, fakeKey, fakeKey);
  assert.doesNotMatch(formatChatStatus(status), /sk-|\x1b|unsafe/);
});
