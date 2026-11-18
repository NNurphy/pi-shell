// pi-shell · T-05：事件 → 状态（不碰 DOM）
//
// 两个必须记住的坑（03 §4② / 1.5.0 文档 json.md:93）：
// ① 增量在 record.assistantMessageEvent 里（{type, contentIndex, delta}），**不是顶层 delta**；
// ② text_end / thinking_end / toolcall_end 带**权威终值**，要覆盖拼接结果；message_end.message 整条替换部分消息。
// 渲染由 main.js 负责（T-05 只做纯文本），Markdown / 折叠 / 图片在 T-08 的 render.js 里扩展。

export function createTranscript() {
  const items = []; // {key, kind:"user"|"assistant"|"thinking"|"tool"|"notice", text, status?, toolName?}
  let counter = 0;
  let current = null; // 当前 assistant 消息条目
  let blocks = new Map(); // contentIndex → 块状态
  let thinkingItem = null;
  const toolsById = new Map(); // toolCallId → 工具条目（toolcall_start / tool_execution_start 共用，避免重复行）
  const toolItems = new Map(); // toolCallId → 工具条目（嵌套关系/子调用计数用）

  const touch = new Set(); // 本次 apply 变动的条目

  function add(kind, text = "", extra = {}) {
    const item = { key: `i${++counter}`, kind, text, ...extra };
    items.push(item);
    touch.add(item);
    return item;
  }

  function assistantText() {
    let out = "";
    for (const [idx, b] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
      if (b.type === "text") out += b.text;
    }
    return out;
  }

  function applyCovering(item, text) {
    if (!item) return;
    item.text = text;
    touch.add(item);
  }

  /** 同一条 assistant 消息的直播态思考条目（富渲染已含 thinking 时撤掉，避免重复） */
  function thinkingItemsOf(msgKey) {
    return items.filter((it) => it.kind === "thinking" && it.msgKey === msgKey);
  }

  return {
    items,

    /**
     * 撤掉某条 assistant 消息在直播态留下的思考条目（message_end 富渲染时用）。
     * 返回被撤掉的条目，调用方负责移除对应 DOM 节点。
     */
    dropThinking(msgKey) {
      if (!msgKey) return [];
      const dropped = thinkingItemsOf(msgKey);
      for (const it of dropped) {
        const idx = items.indexOf(it);
        if (idx >= 0) items.splice(idx, 1);
      }
      return dropped;
    },

    /** 本地回显：发送时立刻出现用户气泡（message_start 到达时不会重复插入） */
    addUser(text) {
      const item = add("user", text, { local: true });
      return item;
    },

    addNotice(text) {
      return add("notice", text);
    },

    apply(event) {
      touch.clear();
      if (!event || typeof event !== "object") return { changed: [] };
      const type = event.type;

      if (type === "bridge_state") {
        // 状态帧由 main.js 单独消费
      } else if (type === "message_start") {
        const role = event.message?.role;
        if (role === "assistant") {
          current = add("assistant", "", { startedAt: performance.now() });
          blocks = new Map();
          thinkingItem = null;
        } else if (role === "user") {
          const text = messageText(event.message);
          const last = items[items.length - 1];
          if (last && last.kind === "user" && last.local && last.text === text) {
            last.local = false; // 与本地回显同一条，不重复插入
          } else if (text) {
            add("user", text);
          }
        }
      } else if (type === "message_update") {
        const aev = event.assistantMessageEvent; // 坑①：增量在这里
        if (!aev) return { changed: [] };
        const ci = aev.contentIndex ?? 0;
        if (aev.type === "text_start") {
          blocks.set(ci, { type: "text", text: "" });
        } else if (aev.type === "text_delta") {
          const b = blocks.get(ci) || { type: "text", text: "" };
          b.text += aev.delta ?? "";
          blocks.set(ci, b);
          applyCovering(current, assistantText());
        } else if (aev.type === "text_end") {
          // 坑②：终值覆盖
          blocks.set(ci, { type: "text", text: aev.content ?? "" });
          applyCovering(current, assistantText());
        } else if (aev.type === "thinking_start") {
          thinkingItem = add("thinking", "", { msgKey: current?.key ?? null });
        } else if (aev.type === "thinking_delta") {
          if (!thinkingItem) thinkingItem = add("thinking", "", { msgKey: current?.key ?? null });
          thinkingItem.text += aev.delta ?? "";
          touch.add(thinkingItem);
        } else if (aev.type === "thinking_end") {
          if (!thinkingItem) thinkingItem = add("thinking", "", { msgKey: current?.key ?? null });
          thinkingItem.text = aev.content ?? thinkingItem.text; // 坑②
          touch.add(thinkingItem);
        } else if (aev.type === "toolcall_start") {
          // PIX-3：同一个 toolCallId 只建一条工具行（tool_execution_start 复用这一条）
          const id = aev.id ?? null;
          if (id && toolsById.has(id)) {
            // 已有条目：只补工具名
          } else {
            const item = add("tool", "", {
              toolName: aev.toolName ?? "tool",
              toolCallId: id,
              status: "调用中",
              startedAt: performance.now(),
              depth: 0,
              childCount: 0,
            });
            if (id) {
              toolsById.set(id, item);
              toolItems.set(id, item);
            }
          }
        } else if (aev.type === "toolcall_end") {
          const tc = aev.toolCall;
          const item = tc?.id ? toolsById.get(tc.id) : null;
          if (item && tc.name) {
            item.toolName = tc.name;
            item.args = tc.arguments ?? item.args;
            touch.add(item);
          }
        }
      } else if (type === "message_end") {
        const msg = event.message;
        if (msg?.role === "assistant") {
          // 坑②：整条替换为权威消息
          const text = messageText(msg);
          if (!current) current = add("assistant", "");
          applyCovering(current, text);
          blocks = new Map();
          thinkingItem = null; // 本条消息的思考到此为止（重复富渲染由 dropThinking 撤掉）
        }
      } else if (type === "tool_execution_start") {
        const id = event.toolCallId ?? null;
        let item = id ? toolsById.get(id) : null;
        if (!item) {
          item = add("tool", "", {
            toolName: event.toolName ?? "tool",
            toolCallId: id,
            depth: 0,
            childCount: 0,
          });
          if (id) {
            toolsById.set(id, item);
            toolItems.set(id, item);
          }
        }
        item.toolName = event.toolName ?? item.toolName ?? "tool";
        item.args = event.args ?? item.args;
        item.status = "运行中";
        // PIX-3：实时跳秒的起点（用本地单调时钟，不依赖事件到达间隔）
        if (item.startedAt == null) item.startedAt = performance.now();
        item.durationMs = null;
        // 嵌套：parentToolCallId 有值 → 缩进一级（最多 2 级），父行记子调用数
        const parentId = event.parentToolCallId ?? null;
        item.parentToolCallId = parentId;
        if (parentId) {
          const parent = toolItems.get(parentId) ?? toolsById.get(parentId) ?? null;
          item.depth = Math.min(2, (parent?.depth ?? 0) + 1);
          item.parentKey = parent?.key ?? null;
          if (parent) {
            parent.childCount = (parent.childCount ?? 0) + (item.countedChild ? 0 : 1);
            item.countedChild = true;
            touch.add(parent);
          }
        } else {
          item.depth = 0;
        }
        touch.add(item);
      } else if (type === "tool_execution_end") {
        const id = event.toolCallId ?? null;
        const item = id ? toolsById.get(id) ?? toolItems.get(id) : null;
        if (item && item.kind === "tool") {
          item.status = event.isError ? "失败" : "完成";
          item.isError = event.isError === true;
          item.text = summarizeToolResult(event.result);
          // PIX-3：结束耗时——事件 durationMs 优先；缺失时用本地起点差值（近似）
          item.durationMs =
            typeof event.durationMs === "number" && Number.isFinite(event.durationMs)
              ? event.durationMs
              : item.startedAt != null
                ? performance.now() - item.startedAt
                : null;
          item.durationSource = typeof event.durationMs === "number" ? "event" : "local";
          item.finishedAt = performance.now();
          touch.add(item);
          if (id) toolsById.delete(id);
        }
      }

      return { changed: [...touch] };
    },
  };
}

/** 从消息对象里取纯文本（assistant/user 的 content 为数组或字符串） */
export function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") out += block.text;
  }
  return out;
}

function summarizeToolResult(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return "";
  const text = content
    .filter((b) => b?.type === "text")
    .map((b) => b.text)
    .join("\n");
  return text.length > 200 ? text.slice(0, 200) + "…" : text;
}
