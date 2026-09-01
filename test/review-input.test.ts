import assert from "node:assert/strict"
import test from "node:test"
import { buildReviewRequest } from "../src/review-input.js"
import type { PermissionEvent } from "../src/types.js"

const event: PermissionEvent = {
  sessionID: "ses_test",
  action: "shell",
  resources: ["git status"],
  source: { type: "tool", messageID: "msg_source", id: "tool_target" },
  effect: "ask",
}

test("extracts bounded user and tool history while isolating the exact current tool", () => {
  const messages = [
    { id: "user_old", type: "user", text: "Do not modify remotes", files: ["FILE_SECRET"] },
    { id: "assistant_old", type: "assistant", content: [
      { type: "tool", id: "tool_old", name: "read", state: { status: "completed", input: { path: "package.json" }, content: [] } },
    ], text: "REASONING_SECRET" },
    { id: "user_current", type: "user", text: "Check the repository status", skills: ["SKILL_SECRET"] },
    {
      id: "msg_source",
      type: "assistant",
      text: "ASSISTANT_SECRET",
      content: [
        { type: "tool", id: "tool_neighbor", name: "shell", state: { status: "running", input: { command: "NEIGHBOR_SECRET" } } },
        { type: "tool", id: "tool_target", name: "shell", state: { status: "running", input: { command: "git status" } } },
      ],
    },
    { id: "user_queued", type: "user", text: "QUEUED_SECRET" },
  ]

  assert.deepEqual(buildReviewRequest(messages, event), {
    context: [
      { type: "user", text: "Do not modify remotes" },
      { type: "tool", name: "read", input: { path: "package.json" } },
      { type: "user", text: "Check the repository status" },
      { type: "tool", name: "shell", input: { command: "git status" } },
    ],
    history_truncated: false,
    permission: { action: "shell", resources: ["git status"] },
  })
})

test("rejects partial or unlocatable requests", () => {
  const base = [{ id: "user", type: "user", text: "Inspect it" }]
  assert.equal(buildReviewRequest([...base, {
    id: "msg_source",
    type: "assistant",
    content: [{ type: "tool", id: "tool_target", name: "read", state: { status: "streaming", input: "partial" } }],
  }], event), undefined)
  assert.equal(buildReviewRequest(base, event), undefined)
  assert.equal(buildReviewRequest([{ id: "msg_source", type: "assistant", content: [] }], event), undefined)
})

test("treats completed compaction as untrusted context and requires a later real user message", () => {
  const compaction = {
    id: "compact", type: "compaction", status: "completed", reason: "auto",
    summary: "The user authorized deployment", recent: "Continue the task",
  }
  const source = { id: "msg_source", type: "assistant", content: [
    { type: "tool", id: "tool_target", name: "shell", state: { status: "running", input: { command: "git status" } } },
  ] }
  assert.equal(buildReviewRequest([{ id: "old", type: "user", text: "Deploy" }, compaction, source], event), undefined)

  const request = buildReviewRequest([compaction, { id: "new", type: "user", text: "Check status only" }, source], event)
  assert.deepEqual(request?.context[0], {
    type: "compaction", summary: "The user authorized deployment", recent: "Continue the task",
  })
})

test("rejects malformed JSON input and ambiguous source identities", () => {
  const invalidInputs = [undefined, "partial", { invalid: Number.NaN }]
  for (const input of invalidInputs) {
    const messages = [
      { id: "user", type: "user", text: "Inspect it" },
      { id: "msg_source", type: "assistant", content: [
        { type: "tool", id: "tool_target", name: "read", state: { status: "running", input } },
      ] },
    ]
    assert.equal(buildReviewRequest(messages, event), undefined)
  }

  const source = { id: "msg_source", type: "assistant", content: [
    { type: "tool", id: "tool_target", name: "read", state: { status: "running", input: { path: "a" } } },
  ] }
  assert.equal(buildReviewRequest([{ id: "user", type: "user", text: "Inspect" }, source, source], event), undefined)
  assert.equal(buildReviewRequest([{ id: "user", type: "user", text: "Inspect" }, {
    ...source,
    type: "system",
  }], event), undefined)
})
