import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Knowledge graph extension entry point.
 *
 * Storage, lifecycle, and tools are added in later MVP tasks. Keep the factory
 * side-effect free so Pi invocations that never start a session do not acquire
 * resources.
 */
export default function knowledgeGraphExtension(_pi: ExtensionAPI): void {
  // Intentionally empty until KGM-2.3/KGM-2.4 add configuration and storage.
}
