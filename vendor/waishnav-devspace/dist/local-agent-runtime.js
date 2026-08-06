function sandboxModeFor(writeMode) {
    switch (writeMode) {
        case "allowed":
            return "workspace-write";
        case "full_access":
            return "danger-full-access";
        case "read_only":
        case undefined:
            return "read-only";
    }
}
function threadOptionsFor(input) {
    return {
        workingDirectory: input.workspace,
        sandboxMode: sandboxModeFor(input.writeMode),
        approvalPolicy: "never",
        model: input.model,
        modelReasoningEffort: input.thinking,
    };
}
export class CodexSdkLocalAgentRuntime {
    provider = "codex";
    codex;
    constructor(codex) {
        this.codex = codex;
    }
    async run(input) {
        const options = threadOptionsFor(input);
        const thread = input.providerSessionId
            ? this.codex.resumeThread(input.providerSessionId, options)
            : this.codex.startThread(options);
        const turn = await thread.run(input.prompt);
        return {
            provider: this.provider,
            providerSessionId: thread.id,
            finalResponse: turn.finalResponse,
            items: turn.items,
        };
    }
}
export async function createCodexSdkLocalAgentRuntime(options, codexFactory) {
    const factory = codexFactory ?? (await defaultCodexFactory());
    return new CodexSdkLocalAgentRuntime(factory(options));
}
async function defaultCodexFactory() {
    const module = await import("@openai/codex-sdk");
    return (options) => new module.Codex(options);
}
