import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { redactValue } from "./redaction.js";

function ruleFile(config) {
    return process.env.DEVSPACE_PERMISSION_RULES_FILE
        ?? join(dirname(config.stateDir), "config", "permission-rules.json");
}

function executableFromCommand(command) {
    const match = String(command ?? "").trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
    return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
}

function matchText(pattern, value) {
    if (!pattern)
        return true;
    try {
        return new RegExp(pattern, "i").test(value ?? "");
    }
    catch {
        return false;
    }
}

export class PermissionRuleEngine {
    config;
    runtimeState;
    path;
    document;
    constructor(config, runtimeState) {
        this.config = config;
        this.runtimeState = runtimeState;
        this.path = ruleFile(config);
        this.reload();
    }
    reload() {
        if (!existsSync(this.path)) {
            this.document = { version: 1, defaultDecision: "allow", rules: [] };
            return this.document;
        }
        try {
            const parsed = JSON.parse(readFileSync(this.path, "utf8"));
            this.document = {
                version: Number(parsed.version ?? 1),
                defaultDecision: ["allow", "deny", "audit"].includes(parsed.defaultDecision) ? parsed.defaultDecision : "allow",
                rules: Array.isArray(parsed.rules) ? parsed.rules : [],
            };
            return this.document;
        }
        catch (error) {
            throw new Error(`Invalid permission rules file ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    list() {
        return { path: this.path, ...redactValue(this.document) };
    }
    evaluate(input) {
        const executable = input.argv?.[0] ?? executableFromCommand(input.cmd);
        const executableName = basename(executable).toLowerCase();
        const argv = input.argv ?? [];
        const commandText = input.cmd ?? argv.join(" ");
        for (const rule of this.document.rules) {
            if (rule.enabled === false)
                continue;
            if (rule.executable && String(rule.executable).toLowerCase() !== executableName && String(rule.executable).toLowerCase() !== executable.toLowerCase())
                continue;
            if (rule.commandPattern && !matchText(rule.commandPattern, commandText))
                continue;
            if (rule.workspacePattern && !matchText(rule.workspacePattern, input.workspaceRoot))
                continue;
            if (Array.isArray(rule.argvPrefix)) {
                const commandArguments = argv.slice(1);
                const prefixMatches = rule.argvPrefix.every((value, index) => commandArguments[index] === value);
                if (!prefixMatches)
                    continue;
            }
            return this.applyDecision(rule.decision ?? "deny", rule.id ?? "unnamed", input, rule.description);
        }
        return this.applyDecision(this.document.defaultDecision, "default", input);
    }
    applyDecision(decision, ruleId, input, description) {
        const result = { decision, ruleId, description, executable: input.argv?.[0] ?? executableFromCommand(input.cmd) };
        if (decision === "audit" || decision === "deny") {
            this.runtimeState.appendEvent({
                kind: `permission.${decision}`,
                subject: ruleId,
                workspaceId: input.workspaceId,
                payload: {
                    ruleId,
                    description,
                    executable: result.executable,
                    cwd: input.cwd,
                    command: input.cmd,
                    argv: input.argv,
                },
            });
        }
        return result;
    }
}
