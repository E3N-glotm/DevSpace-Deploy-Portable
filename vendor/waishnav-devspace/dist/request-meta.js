function metadataString(meta, key) {
    if (typeof meta !== "object" || meta === null)
        return undefined;
    const value = meta[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
export function openAiConversationScopeId(meta) {
    return metadataString(meta, "openai/session");
}
