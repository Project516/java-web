import { join } from "node:path";

// A tool from the host's pinned JDK that `pnpm jdk` downloads
export const hotspot = (tool: "java" | "javac" | "jar") => join(import.meta.dirname, "..", "build", "hotspot", "bin", tool);
