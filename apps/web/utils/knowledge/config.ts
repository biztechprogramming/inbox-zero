import { env } from "@/env";

// Kept separate from memory.ts so hot paths (message sync) can check the flag
// without pulling the mem0ai module into their bundle.
export function isKnowledgeStoreEnabled() {
  return env.NEXT_PUBLIC_KNOWLEDGE_STORE_ENABLED;
}
