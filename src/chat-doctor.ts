import { PiConnectionError, type AuthenticationCheck } from "./pi.ts";
import type { ChatStatus } from "./chat-status.ts";

export type ChatDiagnosis = {
  checks: { name: string; status: "ok" | "warning" | "error" | "info"; message: string }[];
};

export function formatChatDiagnosis(result: ChatDiagnosis): string {
  const labels = { ok: "通过", warning: "提醒", error: "需处理", info: "说明" };
  return ["离线诊断（未联网，未验证鉴权或模型可用性）",
    ...result.checks.map(check => `${check.name} · ${labels[check.status]}\n${check.message}`),
    "本次检查未执行测试、未更新当前会话。可用 /status 查看已加载配置。"].join("\n\n");
}


export function authenticationDisclosure(status: ChatStatus): string {
  try {
    if (!["http:", "https:"].includes(new URL(status.endpoint).protocol)) throw new Error();
  } catch { throw new PiConnectionError("AUTH_ENDPOINT_INVALID", "无法安全显示当前接口，请检查配置并重新启动聊天后再进行联网检查。"); }
  return ["将向当前会话接口发起一次联网检查，可能产生少量费用。", `模型：${status.model}`, `接口：${status.endpoint}`,
    "仅发送固定文本 Reply OK.，密钥仅用于请求认证；不发送当前对话、图片或任务源码。"].join("\n");
}

export function formatAuthenticationResult(result: AuthenticationCheck): string {
  const status = result.httpStatus;
  const advice = result.status === "accepted" ? "本次固定文本请求被接受；不代表图片、SDK 流式对话或修复工具已通过。"
    : result.status === "invalid_response" ? "服务返回的内容不是有效的对话响应，未认定鉴权通过；请核对兼容接口与代理。"
    : status === 401 ? "密钥被拒绝，请核对密钥与接口所属地域、业务空间是否匹配，并确认使用完整有效密钥。"
    : status === 403 ? "请求被拒绝，请检查账号、业务空间及模型调用权限。"
    : status === 404 ? "请核对兼容接口地址、模型 ID 和模型授权；不能仅凭 404 判定密钥无效。"
    : status === 429 ? "请求受到限流或配额限制，请检查调用频率与账户配额。"
    : status >= 500 ? "模型服务暂时异常，请稍后重试。"
    : status >= 300 && status < 400 ? "接口返回重定向，未跟随跳转；请核对兼容接口地址。"
    : "请求未被接受，请核对服务配置与模型调用条件。";
  return ["本次联网检查结果", `HTTP ${status} · ${result.status === "accepted" ? "请求被接受" : "未通过检查"}`,
    ...(result.serviceCode ? [`服务错误码：${result.serviceCode}`] : []), advice,
    "检查未执行任务，也未更新当前会话配置。"].join("\n");
}
