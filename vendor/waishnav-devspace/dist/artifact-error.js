export class ArtifactError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "ArtifactError";
        this.code = code;
    }
}
