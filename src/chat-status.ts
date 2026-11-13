export type ChatStatus = { model: string; endpoint: string; imageInput: boolean; taskId: string | null };

type LoadedModel = { provider: string; id: string; baseUrl: string; input: readonly string[] };
const hidden = "无法安全显示";

export function describeChatStatus(model: LoadedModel, taskId: string | null, apiKey: string): ChatStatus {
  const safe = (value: string) => {
    let decoded: string;
    try { decoded = decodeURIComponent(value); } catch { return hidden; }
    return !value.trim() || value.length > 4096 || /[\x00-\x1f\x7f-\x9f]/.test(decoded)
      || /\bsk-[A-Za-z0-9_-]{16,}\b/.test(decoded) || decoded.includes(apiKey)
      || decoded.includes(JSON.stringify(apiKey).slice(1, -1)) ? hidden : value;
  };
  let endpoint = hidden;
  try {
    if (!/[\x00-\x1f\x7f-\x9f]/.test(model.baseUrl)) {
      const url = new URL(model.baseUrl);
      if (url.protocol === "https:" || url.protocol === "http:") endpoint = safe(url.origin + url.pathname);
    }
  } catch { /* Keep malformed URLs out of the display. */ }
  return { model: safe(`${model.provider}/${model.id}`), endpoint,
    imageInput: model.input.includes("image"), taskId: taskId === null ? null : safe(taskId) };
}

export function formatChatStatus(status: ChatStatus): string {
  return ["当前会话状态（离线，未发起网络请求）", `模型：${status.model}`,
    `接口（已省略认证信息及参数）：${status.endpoint}`,
    `图片输入：${status.imageInput ? "配置声明支持" : "配置未声明支持"}`,
    "凭据：启动时已加载，未验证鉴权。", `绑定任务：${status.taskId ?? "未绑定"}`,
    "以上为当前会话已加载的配置；修改配置或密钥后请重启聊天。"].join("\n");
}
