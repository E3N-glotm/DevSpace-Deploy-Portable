package com.devspace.agent;

final class ShellEscaper {
    private ShellEscaper() {}

    static String quote(String value) {
        if (value == null) return "''";
        return "'" + value.replace("'", "'\"'\"'") + "'";
    }
}
